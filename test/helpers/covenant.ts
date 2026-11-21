import {
    createVirtualMachineBch,
    encodeDataPush,
    encodeLockingBytecodeP2pkh,
    flattenBinArray,
    generateSigningSerializationBch,
    hash160,
    hash256,
    hexToBin,
    secp256k1,
} from '@bitauth/libauth';
import { compileCashAssemblyString, parseTemplate } from '@xo-cash/utils';
import { atomicSwapTemplate, buildHashlock } from '../../source/index.js';

/** SIGHASH_ALL | SIGHASH_FORKID. */
export const SIGHASH_ALL_FORKID = 0x41;

export const SELECTOR_REDEEM = 0x01;
export const SELECTOR_REFUND = 0x02;

export type TestCovenant = {
    redeem: Uint8Array;
    p2sh32: Uint8Array;
    senderPrivateKey: Uint8Array;
    senderPublicKey: Uint8Array;
    recipientPrivateKey: Uint8Array;
    recipientPublicKey: Uint8Array;
    recipientLockingScript: Uint8Array;
    senderLockingScript: Uint8Array;
    hashlock: string;
    preimage: Uint8Array;
    refundTime: bigint;
};

const parse = parseTemplate(atomicSwapTemplate);

function keyFromByte(byte: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const privateKey = new Uint8Array(32);
    privateKey[31] = byte;
    const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
    if (typeof publicKey === 'string') throw new Error(publicKey);
    return { privateKey, publicKey };
}

/**
 * Compiles the real CashASM from `source/htlc.ts` with concrete test values.
 * Only `senderPublicKey` is substituted (the template derives it from a
 * secret, which a unit test cannot hold), so every other opcode evaluated
 * below is exactly the bytecode an engine would deploy.
 */
export function buildTestCovenant(options?: {
    refundTime?: bigint;
    preimageByte?: number;
    senderByte?: number;
    recipientByte?: number;
}): TestCovenant {
    const sender = keyFromByte(options?.senderByte ?? 1);
    const recipient = keyFromByte(options?.recipientByte ?? 2);
    const refundTime = options?.refundTime ?? 1_700_000_000n;
    const preimage = new Uint8Array(32).fill(options?.preimageByte ?? 0x42);
    const hashlock = buildHashlock(preimage);
    const recipientLockingScript = encodeLockingBytecodeP2pkh(hash160(recipient.publicKey));
    const senderLockingScript = encodeLockingBytecodeP2pkh(hash160(sender.publicKey));

    const scripts: Record<string, string> = {
        ...parse.scripts,
        senderPublicKeyPush: `<0x${Buffer.from(sender.publicKey).toString('hex')}>`,
    };

    const redeemHex = compileCashAssemblyString({
        cashAssemblyText: scripts.swapRedeemBytecode,
        variables: {
            hashlock: hexToBin(hashlock),
            recipientPublicKey: recipient.publicKey,
            recipientLockingScript,
            senderLockingScript,
            refundTime,
        },
        templateVariables: parse.variables,
        templateScripts: scripts,
        evaluationDecodeMode: 'hex',
    });
    const redeem = hexToBin(redeemHex);
    const p2sh32 = p2sh32LockingScript(redeem);

    return {
        redeem,
        p2sh32,
        senderPrivateKey: sender.privateKey,
        senderPublicKey: sender.publicKey,
        recipientPrivateKey: recipient.privateKey,
        recipientPublicKey: recipient.publicKey,
        recipientLockingScript,
        senderLockingScript,
        hashlock,
        preimage,
        refundTime,
    };
}

type Output = { lockingBytecode: Uint8Array; valueSatoshis: bigint };

type EvaluateResult = { success: boolean; reason?: string };

function evaluate(params: {
    covenant: TestCovenant;
    inputValueSatoshis: bigint;
    outputs: Output[];
    locktime: number;
    unlockingBytecode: Uint8Array;
}): EvaluateResult {
    const { covenant, inputValueSatoshis, outputs, locktime, unlockingBytecode } = params;
    const input = {
        outpointTransactionHash: new Uint8Array(32).fill(0x11),
        outpointIndex: 0,
        sequenceNumber: 0xfffffffe,
        unlockingBytecode,
    };
    const transaction = { version: 2, inputs: [ input ], outputs, locktime };
    const sourceOutputs = [{ lockingBytecode: covenant.p2sh32, valueSatoshis: inputValueSatoshis }];
    const vm = createVirtualMachineBch();
    const state = vm.evaluate({ inputIndex: 0, sourceOutputs, transaction });
    const result = vm.stateSuccess(state);
    return { success: result === true, reason: result === true ? undefined : String(result) };
}

function sign(covenant: TestCovenant, privateKey: Uint8Array, outputs: Output[], locktime: number): Uint8Array {
    const transaction = {
        version: 2,
        inputs: [{
            outpointTransactionHash: new Uint8Array(32).fill(0x11),
            outpointIndex: 0,
            sequenceNumber: 0xfffffffe,
            unlockingBytecode: new Uint8Array(),
        }],
        outputs,
        locktime,
    };
    const sourceOutputs = [{ lockingBytecode: covenant.p2sh32, valueSatoshis: 100_000n }];
    const signingSerialization = generateSigningSerializationBch(
        { inputIndex: 0, sourceOutputs, transaction },
        { coveredBytecode: covenant.redeem, signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID) },
    );
    const signature = secp256k1.signMessageHashSchnorr(privateKey, hash256(signingSerialization));
    if (typeof signature === 'string') throw new Error(signature);
    return flattenBinArray([ signature, Uint8Array.of(SIGHASH_ALL_FORKID) ]);
}

/** Redeem: preimage + recipient signature, payout to the recipient script. */
export function evaluateRedeem(params: {
    covenant: TestCovenant;
    inputValueSatoshis: bigint;
    outputs: Output[];
    preimage?: Uint8Array;
    signWith?: Uint8Array;
}): EvaluateResult {
    const { covenant, inputValueSatoshis, outputs } = params;
    const preimage = params.preimage ?? covenant.preimage;
    const signature = sign(covenant, params.signWith ?? covenant.recipientPrivateKey, outputs, 0);
    return evaluate({
        covenant,
        inputValueSatoshis,
        outputs,
        locktime: 0,
        unlockingBytecode: flattenBinArray([
            encodeDataPush(signature),
            encodeDataPush(preimage),
            Uint8Array.of(0x51), // OP_1: redeem selector
            encodeDataPush(covenant.redeem),
        ]),
    });
}

/** Refund: sender signature after the absolute refundTime, payout to the sender script. */
export function evaluateRefund(params: {
    covenant: TestCovenant;
    inputValueSatoshis: bigint;
    outputs: Output[];
    locktime?: number;
    signWith?: Uint8Array;
}): EvaluateResult {
    const { covenant, inputValueSatoshis, outputs } = params;
    const locktime = params.locktime ?? Number(covenant.refundTime);
    const signature = sign(covenant, params.signWith ?? covenant.senderPrivateKey, outputs, locktime);
    return evaluate({
        covenant,
        inputValueSatoshis,
        outputs,
        locktime,
        unlockingBytecode: flattenBinArray([
            encodeDataPush(signature),
            Uint8Array.of(0x52), // OP_2: refund selector
            encodeDataPush(covenant.redeem),
        ]),
    });
}

export function p2pkhForPrivateKeyByte(byte: number): Uint8Array {
    const { publicKey } = keyFromByte(byte);
    return encodeLockingBytecodeP2pkh(hash160(publicKey));
}

/** Builds the 34-byte P2SH32 locking script for an arbitrary redeem script. */
export function p2sh32LockingScript(redeem: Uint8Array): Uint8Array {
    return flattenBinArray([
        Uint8Array.of(0xaa),
        Uint8Array.of(0x20),
        hash256(redeem),
        Uint8Array.of(0x87),
    ]);
}
