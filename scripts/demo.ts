import { createHash } from 'node:crypto';
import {
    binToHex,
    createVirtualMachineBch,
    encodeLockingBytecodeP2pkh,
    hash160,
    hash256,
    hexToBin,
    lockingBytecodeToCashAddress,
    secp256k1,
} from '@bitauth/libauth';
import { FEE_SATOSHIS } from '../source/index.js';
import {
    broadcastRaw,
    compileSwap,
    getHeight,
    listAddressUtxos,
    makeTx,
    serialize,
    signP2pkh,
    signRedeem,
    signRefund,
    type Tx,
    type TxOutput,
} from './lib/tx.js';

/**
 * End-to-end Chipnet run for the XO Atomic Swap template.
 *
 *   SENDER_PRIV    hex private key that funds and can refund (default: 0x…03)
 *   RECIPIENT_PRIV hex private key that can redeem      (default: 0x…02)
 *   PREIMAGE       hex preimage                         (default: 32 × 0x42)
 *   SWAP_SATS      amount per swap                      (default 60000)
 *   BROADCAST=1    send the transactions (otherwise build + verify only)
 */

function keyFromHex(hex: string): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const privateKey = hexToBin(hex);
    if (privateKey.length !== 32) throw new Error('private key must be 32 bytes');
    const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
    if (typeof publicKey === 'string') throw new Error(publicKey);
    return { privateKey, publicKey };
}

const sender = keyFromHex(process.env.SENDER_PRIV ?? `${'00'.repeat(31)}03`);
const recipient = keyFromHex(process.env.RECIPIENT_PRIV ?? `${'00'.repeat(31)}02`);
const preimage = hexToBin(process.env.PREIMAGE ?? '42'.repeat(32));
const hashlock = createHash('sha256').update(preimage).digest('hex');
const swapSatoshis = BigInt(process.env.SWAP_SATS ?? '60000');
const senderLockingScript = encodeLockingBytecodeP2pkh(hash160(sender.publicKey));
const recipientLockingScript = encodeLockingBytecodeP2pkh(hash160(recipient.publicKey));
const senderLockingScriptHex = binToHex(senderLockingScript);
const recipientLockingScriptHex = binToHex(recipientLockingScript);
const senderPublicKeyHex = binToHex(sender.publicKey);
const recipientPublicKeyHex = binToHex(recipient.publicKey);
const senderAddress = lockingBytecodeToCashAddress({ bytecode: senderLockingScript, prefix: 'bchtest' });
if (typeof senderAddress === 'string') throw new Error(senderAddress);

const broadcast = process.env.BROADCAST === '1';
const now = Math.floor(Date.now() / 1000);
const results: Array<Record<string, unknown>> = [];

function log(step: string, value: Record<string, unknown>): void {
    results.push({ step, ...value });
    console.log(`[${step}]`, JSON.stringify(value));
}

function verify(tx: Tx, sourceOutputs: TxOutput[], label: string): void {
    const vm = createVirtualMachineBch();
    const state = vm.evaluate({ inputIndex: 0, sourceOutputs, transaction: tx });
    const ok = vm.stateSuccess(state);
    if (ok !== true) throw new Error(`${label}: local VM rejected the transaction: ${String(ok)}`);
    console.log(`[${label}] VM_OK`);
}

async function waitConfirmed(txid: string, address: string, timeoutMinutes = 45): Promise<void> {
    if (!broadcast) return;
    const started = Date.now();
    for (;;) {
        const utxos = await listAddressUtxos(address);
        const utxo = utxos.find((candidate) => candidate.txid === txid && candidate.height > 0);
        if (utxo) {
            console.log(`[confirm] ${txid} at height ${utxo.height}`);
            return;
        }
        if (Date.now() - started > timeoutMinutes * 60_000) throw new Error(`timed out waiting for ${txid}`);
        console.log(`[confirm] waiting for ${txid}…`);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
}

async function send(tx: Tx, label: string, retryNonFinal = false): Promise<string> {
    const hex = binToHex(serialize(tx));
    if (!broadcast) {
        console.log(`[${label}] DRY_RUN txid=${binToHex(hash256(hexToBin(hex))).slice(0, 16)}… size=${hex.length / 2}`);
        return '';
    }
    for (let attempt = 1; attempt <= (retryNonFinal ? 4 : 1); attempt += 1) {
        try {
            const txid = await broadcastRaw(hex);
            console.log(`[${label}] BROADCAST ${txid}`);
            return txid;
        } catch (error) {
            const message = (error as Error).message;
            const retry = retryNonFinal && /non-final|nonfinal/.test(message) && attempt < 4;
            if (!retry) throw error;
            console.log(`[${label}] attempt ${attempt} non-final; waiting 60s for the tip`);
            await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
    }
    throw new Error('unreachable');
}

const height = await getHeight();
console.log('chain height', height);
console.log('sender', senderLockingScriptHex, 'recipient', recipientLockingScriptHex, 'hashlock', hashlock);

// ---------------------------------------------------------------------------
// Step 1: create a swap and redeem it with the preimage.
// ---------------------------------------------------------------------------
const swapRedeem = compileSwap({
    senderPublicKeyHex,
    hashlockHex: hashlock,
    recipientPublicKeyHex,
    recipientLockingScriptHex,
    senderLockingScriptHex,
    refundTime: now + 86_400,
});
console.log('redeem swap address', swapRedeem.address, 'redeem script', swapRedeem.redeemHex.length / 2, 'bytes');

let funding = (await listAddressUtxos(senderAddress.address)).find((utxo) => utxo.value >= swapSatoshis + 5_000n);
if (!funding) {
    // Fall back to an explicit outpoint so the demo also works before Electrum
    // has indexed a fresh faucet transaction.
    const txid = process.env.FUNDING_TXID;
    const vout = Number(process.env.FUNDING_VOUT ?? '0');
    const value = BigInt(process.env.FUNDING_VALUE ?? '0');
    if (!txid || value === 0n) throw new Error('no funding UTXO; set FUNDING_TXID/FUNDING_VOUT/FUNDING_VALUE');
    funding = { txid, vout, value, height: 0 };
    console.log('using explicit funding outpoint', funding);
}

const createFee = 500n;
const createChange = funding.value - swapSatoshis - createFee;
const createTx = makeTx({
    inputs: [{ txid: funding.txid, vout: funding.vout }],
    outputs: [
        { lockingBytecode: swapRedeem.p2sh32, valueSatoshis: swapSatoshis },
        { lockingBytecode: senderLockingScript, valueSatoshis: createChange },
    ],
});
signP2pkh({ tx: createTx, inputIndex: 0, sourceOutputs: [{ lockingBytecode: senderLockingScript, valueSatoshis: funding.value }], privateKey: sender.privateKey, publicKey: sender.publicKey, lockingBytecode: senderLockingScript });
verify(createTx, [{ lockingBytecode: senderLockingScript, valueSatoshis: funding.value }], 'create-redeem-swap');
const createRedeemTxid = await send(createTx, 'create-redeem-swap');
log('create-redeem-swap', { txid: createRedeemTxid, address: swapRedeem.address, value: String(swapSatoshis) });

const redeemTx = makeTx({
    inputs: [{ txid: createRedeemTxid || '00'.repeat(32), vout: 0 }],
    outputs: [{ lockingBytecode: recipientLockingScript, valueSatoshis: swapSatoshis - FEE_SATOSHIS }],
});
signRedeem({ tx: redeemTx, inputIndex: 0, sourceOutputs: [{ lockingBytecode: swapRedeem.p2sh32, valueSatoshis: swapSatoshis }], redeem: swapRedeem.redeem, privateKey: recipient.privateKey, preimage });
verify(redeemTx, [{ lockingBytecode: swapRedeem.p2sh32, valueSatoshis: swapSatoshis }], 'redeem');
const redeemTxid = await send(redeemTx, 'redeem');
log('redeem', { txid: redeemTxid, preimage: binToHex(preimage) });

// ---------------------------------------------------------------------------
// Step 2: create a swap whose timelock has already passed, then refund it.
// ---------------------------------------------------------------------------
const swapRefund = compileSwap({
    senderPublicKeyHex,
    hashlockHex: hashlock,
    recipientPublicKeyHex,
    recipientLockingScriptHex,
    senderLockingScriptHex,
    refundTime: now - 86_400,
});
const funding2 = { txid: createRedeemTxid || '11'.repeat(32), vout: 1, value: createChange };
const createRefundTx = makeTx({
    inputs: [{ txid: funding2.txid, vout: funding2.vout }],
    outputs: [
        { lockingBytecode: swapRefund.p2sh32, valueSatoshis: swapSatoshis },
        { lockingBytecode: senderLockingScript, valueSatoshis: funding2.value - swapSatoshis - createFee },
    ],
});
signP2pkh({ tx: createRefundTx, inputIndex: 0, sourceOutputs: [{ lockingBytecode: senderLockingScript, valueSatoshis: funding2.value }], privateKey: sender.privateKey, publicKey: sender.publicKey, lockingBytecode: senderLockingScript });
verify(createRefundTx, [{ lockingBytecode: senderLockingScript, valueSatoshis: funding2.value }], 'create-refund-swap');
const createRefundTxid = await send(createRefundTx, 'create-refund-swap');
log('create-refund-swap', { txid: createRefundTxid, address: swapRefund.address, refundTime: now - 86_400 });

await waitConfirmed(createRefundTxid, swapRefund.address);

const refundTx = makeTx({
    inputs: [{ txid: createRefundTxid || '22'.repeat(32), vout: 0 }],
    outputs: [{ lockingBytecode: senderLockingScript, valueSatoshis: swapSatoshis - FEE_SATOSHIS }],
    locktime: now - 86_400,
});
signRefund({ tx: refundTx, inputIndex: 0, sourceOutputs: [{ lockingBytecode: swapRefund.p2sh32, valueSatoshis: swapSatoshis }], redeem: swapRefund.redeem, privateKey: sender.privateKey });
verify(refundTx, [{ lockingBytecode: swapRefund.p2sh32, valueSatoshis: swapSatoshis }], 'refund');
const refundTxid = await send(refundTx, 'refund', true);
log('refund', { txid: refundTxid });

// ---------------------------------------------------------------------------
// Step 3: create a swap with a future timelock and prove an early refund is
// rejected by the local VM and (when broadcasting) by the node.
// ---------------------------------------------------------------------------
const swapEarly = compileSwap({
    senderPublicKeyHex,
    hashlockHex: hashlock,
    recipientPublicKeyHex,
    recipientLockingScriptHex,
    senderLockingScriptHex,
    refundTime: now + 3_600,
});
const funding3 = { txid: createRefundTxid || '33'.repeat(32), vout: 1, value: funding2.value - swapSatoshis - createFee };
const createEarlyTx = makeTx({
    inputs: [{ txid: funding3.txid, vout: funding3.vout }],
    outputs: [
        { lockingBytecode: swapEarly.p2sh32, valueSatoshis: swapSatoshis },
        { lockingBytecode: senderLockingScript, valueSatoshis: funding3.value - swapSatoshis - createFee },
    ],
});
signP2pkh({ tx: createEarlyTx, inputIndex: 0, sourceOutputs: [{ lockingBytecode: senderLockingScript, valueSatoshis: funding3.value }], privateKey: sender.privateKey, publicKey: sender.publicKey, lockingBytecode: senderLockingScript });
verify(createEarlyTx, [{ lockingBytecode: senderLockingScript, valueSatoshis: funding3.value }], 'create-early-swap');
const createEarlyTxid = await send(createEarlyTx, 'create-early-swap');
log('create-early-swap', { txid: createEarlyTxid, address: swapEarly.address, refundTime: now + 3_600 });

await waitConfirmed(createEarlyTxid, swapEarly.address);

// 3a. A transaction whose locktime is one second short of the committed
// timestamp must fail in the VM: OP_CHECKLOCKTIMEVERIFY compares the
// transaction locktime to the committed timestamp, so this proves the script
// enforces it.
const earlyRefundVmTx = makeTx({
    inputs: [{ txid: createEarlyTxid || '44'.repeat(32), vout: 0 }],
    outputs: [{ lockingBytecode: senderLockingScript, valueSatoshis: swapSatoshis - FEE_SATOSHIS }],
    locktime: now + 3_600 - 1,
});
signRefund({ tx: earlyRefundVmTx, inputIndex: 0, sourceOutputs: [{ lockingBytecode: swapEarly.p2sh32, valueSatoshis: swapSatoshis }], redeem: swapEarly.redeem, privateKey: sender.privateKey });

const vm = createVirtualMachineBch();
const earlyState = vm.evaluate({ inputIndex: 0, sourceOutputs: [{ lockingBytecode: swapEarly.p2sh32, valueSatoshis: swapSatoshis }], transaction: earlyRefundVmTx });
const earlyResult = vm.stateSuccess(earlyState);
console.log('[early-refund] VM result (one second short):', String(earlyResult));
if (earlyResult === true) throw new Error('early refund passed the local VM: the timelock is broken');
log('early-refund-vm', { result: String(earlyResult) });

// 3b. A correctly built refund at the committed timestamp is valid to the
// script, but a node will not accept it until the wall clock reaches that
// timestamp. Broadcasting now must fail with a non-final error.
const earlyRefundNodeTx = makeTx({
    inputs: [{ txid: createEarlyTxid || '44'.repeat(32), vout: 0 }],
    outputs: [{ lockingBytecode: senderLockingScript, valueSatoshis: swapSatoshis - FEE_SATOSHIS }],
    locktime: now + 3_600,
});
signRefund({ tx: earlyRefundNodeTx, inputIndex: 0, sourceOutputs: [{ lockingBytecode: swapEarly.p2sh32, valueSatoshis: swapSatoshis }], redeem: swapEarly.redeem, privateKey: sender.privateKey });

if (broadcast) {
    try {
        const txid = await broadcastRaw(binToHex(serialize(earlyRefundNodeTx)));
        throw new Error(`node accepted an early refund: ${txid}`);
    } catch (error) {
        const message = (error as Error).message;
        if (/node accepted an early refund/.test(message)) throw error;
        console.log('[early-refund] NODE_REJECTED', message);
        log('early-refund-node', { rejected: true, reason: message });
    }
}

console.log('RESULTS', JSON.stringify(results, null, 2));
