import assert from 'node:assert/strict';
import test from 'node:test';
import { FEE_SATOSHIS } from '../source/index.js';
import {
    buildTestCovenant,
    evaluateRedeem,
    evaluateRefund,
    p2pkhForPrivateKeyByte,
} from './helpers/covenant.js';

const SWAP = 100_000n;
const PAYOUT = SWAP - FEE_SATOSHIS;

test('redeem: preimage plus recipient signature pays the committed recipient', () => {
    const covenant = buildTestCovenant();
    const result = evaluateRedeem({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: covenant.recipientLockingScript, valueSatoshis: PAYOUT }],
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('redeem: rejected with the wrong preimage', () => {
    const covenant = buildTestCovenant();
    const result = evaluateRedeem({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: covenant.recipientLockingScript, valueSatoshis: PAYOUT }],
        preimage: new Uint8Array(32).fill(0x43),
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_EQUALVERIFY|OP_VERIFY|SHA256/i);
});

test('redeem: rejected when the sender signs instead of the recipient', () => {
    const covenant = buildTestCovenant();
    const result = evaluateRedeem({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: covenant.recipientLockingScript, valueSatoshis: PAYOUT }],
        signWith: covenant.senderPrivateKey,
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /NULLFAIL|signature/i);
});

test('redeem: rejected when the money goes anywhere but the committed recipient', () => {
    const covenant = buildTestCovenant();
    const result = evaluateRedeem({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: p2pkhForPrivateKeyByte(9), valueSatoshis: PAYOUT }],
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_EQUALVERIFY|OP_VERIFY/i);
});

test('redeem: rejected when the payout value is not exactly input minus the fee', () => {
    const covenant = buildTestCovenant();
    const result = evaluateRedeem({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: covenant.recipientLockingScript, valueSatoshis: PAYOUT - 1n }],
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /non-truthy|OP_NUMEQUAL|false/i);
});

test('refund: sender takes the balance at the committed timestamp', () => {
    const covenant = buildTestCovenant({ refundTime: 1_700_000_000n });
    const result = evaluateRefund({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: covenant.senderLockingScript, valueSatoshis: PAYOUT }],
        locktime: 1_700_000_000,
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('refund: rejected one second before the committed timestamp', () => {
    const covenant = buildTestCovenant({ refundTime: 1_700_000_000n });
    const result = evaluateRefund({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: covenant.senderLockingScript, valueSatoshis: PAYOUT }],
        locktime: 1_699_999_999,
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /CHECKLOCKTIMEVERIFY|non-final|locktime/i);
});

test('refund: rejected when the recipient signs instead of the sender', () => {
    const covenant = buildTestCovenant({ refundTime: 1_700_000_000n });
    const result = evaluateRefund({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: covenant.senderLockingScript, valueSatoshis: PAYOUT }],
        locktime: 1_700_000_000,
        signWith: covenant.recipientPrivateKey,
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /NULLFAIL|signature/i);
});

test('refund: rejected when the money goes anywhere but the committed sender', () => {
    const covenant = buildTestCovenant({ refundTime: 1_700_000_000n });
    const result = evaluateRefund({
        covenant,
        inputValueSatoshis: SWAP,
        outputs: [{ lockingBytecode: p2pkhForPrivateKeyByte(9), valueSatoshis: PAYOUT }],
        locktime: 1_700_000_000,
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_EQUALVERIFY|OP_VERIFY/i);
});

test('a different hashlock, key, timestamp or payout script changes the address', () => {
    const base = buildTestCovenant({ refundTime: 1_700_000_000n });
    const otherPreimage = buildTestCovenant({ refundTime: 1_700_000_000n, preimageByte: 0x44 });
    const otherSender = buildTestCovenant({ refundTime: 1_700_000_000n, senderByte: 4 });
    const otherRecipient = buildTestCovenant({ refundTime: 1_700_000_000n, recipientByte: 5 });
    const otherTimelock = buildTestCovenant({ refundTime: 1_700_000_001n });

    for (const [name, other] of Object.entries({ otherPreimage, otherSender, otherRecipient, otherTimelock })) {
        assert.notDeepEqual(base.redeem, other.redeem, `${name} must change the redeem script`);
        assert.notDeepEqual(base.p2sh32, other.p2sh32, `${name} must change the address`);
    }
});
