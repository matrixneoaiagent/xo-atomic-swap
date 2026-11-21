import { createHash } from 'node:crypto';
import {
    binToHex,
    encodeDataPush,
    encodeTransaction,
    flattenBinArray,
    generateSigningSerializationBch,
    hash256,
    cashAddressToLockingBytecode,
    hexToBin,
    lockingBytecodeToCashAddress,
    secp256k1,
} from '@bitauth/libauth';
import { compileCashAssemblyString, parseTemplate } from '@xo-cash/utils';
import { ElectrumClient } from '@electrum-cash/network';
import { atomicSwapTemplate } from '../../source/index.js';

export const CHIPNET_ELECTRUM = process.env.XO_ELECTRUM ?? 'chipnet.bch.ninja';
export const SIGHASH_ALL_FORKID = 0x41;

export type SwapParams = {
    senderPublicKeyHex: string;
    hashlockHex: string;
    recipientPublicKeyHex: string;
    recipientLockingScriptHex: string;
    senderLockingScriptHex: string;
    refundTime: number;
};

export type CompiledSwap = {
    redeem: Uint8Array;
    redeemHex: string;
    p2sh32: Uint8Array;
    p2sh32Hex: string;
    address: string;
};

const parsed = parseTemplate(atomicSwapTemplate);

/**
 * Compiles the template's own CashASM with concrete values. The sender public
 * key is substituted for the `<senderKey.public_key>` placeholder because a
 * reference builder does not hold an engine secret store.
 */
export function compileSwap(params: SwapParams): CompiledSwap {
    const scripts: Record<string, string> = { ...parsed.scripts };
    const redeemHex = compileCashAssemblyString({
        cashAssemblyText: scripts.swapRedeemBytecode,
        variables: {
            hashlock: hexToBin(params.hashlockHex),
            senderPublicKey: hexToBin(params.senderPublicKeyHex),
            recipientPublicKey: hexToBin(params.recipientPublicKeyHex),
            recipientLockingScript: hexToBin(params.recipientLockingScriptHex),
            senderLockingScript: hexToBin(params.senderLockingScriptHex),
            refundTime: BigInt(params.refundTime),
        },
        templateVariables: parsed.variables,
        templateScripts: scripts,
        evaluationDecodeMode: 'hex',
    });
    const redeem = hexToBin(redeemHex);
    const p2sh32 = p2sh32LockingScript(redeem);
    const p2sh32Hex = binToHex(p2sh32);
    return { redeem, redeemHex, p2sh32, p2sh32Hex, address: p2sh32ToAddress(p2sh32Hex) };
}

export function p2sh32LockingScript(redeem: Uint8Array): Uint8Array {
    return flattenBinArray([
        Uint8Array.of(0xaa), // OP_HASH256
        Uint8Array.of(0x20), // push 32 bytes
        hash256(redeem),
        Uint8Array.of(0x87), // OP_EQUAL
    ]);
}

function p2sh32ToAddress(p2sh32Hex: string): string {
    const encoded = lockingBytecodeToCashAddress({ bytecode: hexToBin(p2sh32Hex), prefix: 'bchtest' });
    if (typeof encoded === 'string') throw new Error(encoded);
    return encoded.address;
}

export type TxInput = {
    outpointTransactionHash: Uint8Array;
    outpointIndex: number;
    sequenceNumber: number;
    unlockingBytecode: Uint8Array;
};

export type TxOutput = {
    lockingBytecode: Uint8Array;
    valueSatoshis: bigint;
};

export type Tx = {
    version: number;
    inputs: TxInput[];
    outputs: TxOutput[];
    locktime: number;
};

export function makeTx(params: {
    inputs: Array<{ txid: string; vout: number; sequenceNumber?: number }>;
    outputs: TxOutput[];
    locktime?: number;
}): Tx {
    return {
        version: 2,
        inputs: params.inputs.map((input) => ({
            outpointTransactionHash: hexToBin(input.txid),
            outpointIndex: input.vout,
            sequenceNumber: input.sequenceNumber ?? 0xfffffffe,
            unlockingBytecode: new Uint8Array(),
        })),
        outputs: params.outputs,
        locktime: params.locktime ?? 0,
    };
}

function signingSerialization(tx: Tx, inputIndex: number, sourceOutputs: TxOutput[], coveredBytecode: Uint8Array): Uint8Array {
    return generateSigningSerializationBch(
        { inputIndex, sourceOutputs, transaction: tx },
        { coveredBytecode, signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID) },
    );
}

export function signP2pkh(params: {
    tx: Tx;
    inputIndex: number;
    sourceOutputs: TxOutput[];
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    lockingBytecode: Uint8Array;
}): void {
    const { tx, inputIndex, sourceOutputs, privateKey, publicKey, lockingBytecode } = params;
    const serialization = signingSerialization(tx, inputIndex, sourceOutputs, lockingBytecode);
    const signature = secp256k1.signMessageHashSchnorr(privateKey, hash256(serialization));
    if (typeof signature === 'string') throw new Error(signature);
    tx.inputs[inputIndex]!.unlockingBytecode = flattenBinArray([
        encodeDataPush(flattenBinArray([ signature, Uint8Array.of(SIGHASH_ALL_FORKID) ])),
        encodeDataPush(publicKey),
    ]);
}

export function signRedeem(params: {
    tx: Tx;
    inputIndex: number;
    sourceOutputs: TxOutput[];
    redeem: Uint8Array;
    privateKey: Uint8Array;
    preimage: Uint8Array;
}): void {
    const { tx, inputIndex, sourceOutputs, redeem, privateKey, preimage } = params;
    const serialization = signingSerialization(tx, inputIndex, sourceOutputs, redeem);
    const signature = secp256k1.signMessageHashSchnorr(privateKey, hash256(serialization));
    if (typeof signature === 'string') throw new Error(signature);
    tx.inputs[inputIndex]!.unlockingBytecode = flattenBinArray([
        encodeDataPush(flattenBinArray([ signature, Uint8Array.of(SIGHASH_ALL_FORKID) ])),
        encodeDataPush(preimage),
        Uint8Array.of(0x51), // OP_1: redeem selector
        encodeDataPush(redeem),
    ]);
}

export function signRefund(params: {
    tx: Tx;
    inputIndex: number;
    sourceOutputs: TxOutput[];
    redeem: Uint8Array;
    privateKey: Uint8Array;
}): void {
    const { tx, inputIndex, sourceOutputs, redeem, privateKey } = params;
    const serialization = signingSerialization(tx, inputIndex, sourceOutputs, redeem);
    const signature = secp256k1.signMessageHashSchnorr(privateKey, hash256(serialization));
    if (typeof signature === 'string') throw new Error(signature);
    tx.inputs[inputIndex]!.unlockingBytecode = flattenBinArray([
        encodeDataPush(flattenBinArray([ signature, Uint8Array.of(SIGHASH_ALL_FORKID) ])),
        Uint8Array.of(0x52), // OP_2: refund selector
        encodeDataPush(redeem),
    ]);
}

export function serialize(tx: Tx): Uint8Array {
    const encoded = encodeTransaction(tx);
    if (typeof encoded === 'string') throw new Error(encoded);
    return encoded;
}

export async function broadcastRaw(hex: string): Promise<string> {
    const client = new ElectrumClient<never>('xo-atomic-swap', '1.5.0', CHIPNET_ELECTRUM);
    await client.connect();
    try {
        const result = await client.request('blockchain.transaction.broadcast', hex);
        if (result instanceof Error) throw result;
        const txid = (result as { result?: string }).result ?? (result as unknown as string);
        if (typeof txid !== 'string') throw new Error(`broadcast failed: ${JSON.stringify(result)}`);
        return txid;
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

export async function getTxHex(txid: string): Promise<string> {
    const client = new ElectrumClient<never>('xo-atomic-swap', '1.5.0', CHIPNET_ELECTRUM);
    await client.connect();
    try {
        const result = await client.request('blockchain.transaction.get', txid);
        const hex = (result as { result?: string }).result ?? (result as unknown as string);
        if (typeof hex !== 'string') throw new Error(`cannot fetch ${txid}`);
        return hex;
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

export async function getHeight(): Promise<number> {
    const client = new ElectrumClient<never>('xo-atomic-swap', '1.5.0', CHIPNET_ELECTRUM);
    await client.connect();
    try {
        const result = await client.request('blockchain.headers.subscribe');
        const height = (result as { height?: number }).height ?? (result as unknown as { result?: { height: number } }).result?.height;
        if (typeof height !== 'number') throw new Error(`cannot read height: ${JSON.stringify(result)}`);
        return height;
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

export async function listAddressUtxos(address: string): Promise<Array<{ txid: string; vout: number; value: bigint; height: number }>> {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string') throw new Error(decoded);
    const scriptHash = createScriptHash(binToHex(decoded.bytecode));
    const client = new ElectrumClient<never>('xo-atomic-swap', '1.5.0', CHIPNET_ELECTRUM);
    await client.connect();
    try {
        const result = await client.request('blockchain.scripthash.listunspent', scriptHash);
        const rows = (result as { result?: Array<{ tx_hash: string; tx_pos: number; value: number; height: number }> }).result
            ?? (result as unknown as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>);
        return (rows ?? []).map((row) => ({
            txid: row.tx_hash,
            vout: row.tx_pos,
            value: BigInt(row.value),
            height: row.height,
        }));
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

function createScriptHash(lockingBytecodeHex: string): string {
    return createHash('sha256').update(Buffer.from(lockingBytecodeHex, 'hex')).digest().reverse().toString('hex');
}
