import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTemplate } from '@xo-cash/utils';
import { atomicSwapTemplate } from '../source/index.js';

test('template parses and validates against the XO schema', () => {
    const parsed = parseTemplate(atomicSwapTemplate);
    assert.equal(parsed.name, 'XO Atomic Swap (HTLC)');
    assert.ok(parsed.scripts.swapRedeemBytecode.length > 0);
    assert.ok(parsed.lockingScripts.swapScript);
});

test('template exposes the start action and both follow-ups', () => {
    assert.equal(atomicSwapTemplate.start[0]?.action, 'createSwap');
    assert.ok(atomicSwapTemplate.actions.createSwap);
    assert.ok(atomicSwapTemplate.actions.redeem);
    assert.ok(atomicSwapTemplate.actions.refund);
    const roles = atomicSwapTemplate.lockingScripts.swapScript.roles;
    assert.ok(roles);
    assert.ok(roles.sender.actions?.some((a) => a.action === 'refund'));
    assert.ok(roles.recipient.actions?.some((a) => a.action === 'redeem'));
});
