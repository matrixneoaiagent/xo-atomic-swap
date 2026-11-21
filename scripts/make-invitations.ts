import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';
import { serializeInvitation } from '@xo-cash/utils';
import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { createHash } from 'node:crypto';
import { hexToBin } from '@bitauth/libauth';
import { writeArtifact } from './lib/artifacts.js';
import { atomicSwapTemplate } from '../source/index.js';

/**
 * Produces inspectable XO invitations for the template without touching the
 * chain. The Chipnet header-sync bug in the engine (docs/FINDINGS.md item 1)
 * prevents `listSpendableUnspentOutputs` from working, but invitation creation
 * and output resolution are local operations and work normally.
 *
 * The addresses these invitations resolve to are the exact addresses the
 * reference builder in scripts/demo.ts funds on Chipnet.
 *
 *   SENDER_PRIV      hex sender key (default 0x…03)
 *   RECIPIENT_PRIV   hex recipient key (default 0x…02)
 *   PREIMAGE         hex preimage (default 32 × 0x42)
 *   SWAP_SATS        amount (default 60000)
 */
const senderPriv = process.env.SENDER_PRIV ?? `${'00'.repeat(31)}03`;
const recipientPriv = process.env.RECIPIENT_PRIV ?? `${'00'.repeat(31)}02`;
const preimageHex = process.env.PREIMAGE ?? '42'.repeat(32);
const swapSatoshis = BigInt(process.env.SWAP_SATS ?? '60000');
const hashlock = createHash('sha256').update(hexToBin(preimageHex)).digest('hex');

const { secp256k1, hash160, encodeLockingBytecodeP2pkh } = await import('@bitauth/libauth');
const senderPub = secp256k1.derivePublicKeyCompressed(hexToBin(senderPriv));
const recipientPub = secp256k1.derivePublicKeyCompressed(hexToBin(recipientPriv));
if (typeof senderPub === 'string' || typeof recipientPub === 'string') throw new Error('bad key');
const senderScript = binToHex(encodeLockingBytecodeP2pkh(hash160(senderPub)));
const recipientScript = binToHex(encodeLockingBytecodeP2pkh(hash160(recipientPub)));

const refundTime = Number(process.env.REFUND_TIME ?? String(Math.floor(Date.now() / 1000) + 86_400));

const engine = await Engine.create('doctor vibrant wear drip visa property carry scale people excess symptom must', {
    network: XO_SUPPORTED_NETWORKS.chipnet,
    databasePath: './.xo-invitations',
});
try {
    const { templateIdentifier } = await engine.importTemplate(atomicSwapTemplate);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const start = template.start.find((intent) => intent.action === 'createSwap');
    if (!start) throw new Error('createSwap intent missing');
    const redeemIntent = template.lockingScripts.swapScript.roles?.recipient.actions?.find((intent) => intent.action === 'redeem');
    if (!redeemIntent) throw new Error('redeem intent missing');
    const refundIntent = template.lockingScripts.swapScript.roles?.sender.actions?.find((intent) => intent.action === 'refund');
    if (!refundIntent) throw new Error('refund intent missing');

    // 1. Creation invitation. The sender key is supplied rather than generated
    // so the reference builder can sign for it.
    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'createSwap',
        intent: start,
        variables: [
            { variableIdentifier: 'swapSatoshis', roleIdentifier: 'sender', value: swapSatoshis },
            { variableIdentifier: 'hashlock', roleIdentifier: 'sender', value: hashlock },
            { variableIdentifier: 'senderPublicKey', roleIdentifier: 'sender', value: binToHex(senderPub) },
            { variableIdentifier: 'recipientPublicKey', roleIdentifier: 'sender', value: binToHex(recipientPub) },
            { variableIdentifier: 'recipientLockingScript', roleIdentifier: 'sender', value: recipientScript },
            { variableIdentifier: 'senderLockingScript', roleIdentifier: 'sender', value: senderScript },
            { variableIdentifier: 'refundTime', roleIdentifier: 'sender', value: refundTime },
        ],
    });
    const createId = created.invitation.invitationIdentifier;
    await engine.appendInvitation(createId, {
        templateIdentifier,
        actionIdentifier: 'createSwap',
        outputs: [{ outputIdentifier: 'initialSwapOutput' }],
    });
    const swapBytecode = await engine.resolveInvitationOutputLockingBytecode(createId, 'initialSwapOutput', 'sender');
    const swapAddress = lockingBytecodeToCashAddress({ bytecode: hexToBin(swapBytecode), prefix: 'bchtest' });
    if (typeof swapAddress === 'string') throw new Error(swapAddress);
    const createInvitation = await engine.getInvitation(createId);
    if (!createInvitation) throw new Error('create invitation missing');
    console.log('create', writeArtifact('createSwap-invitation.json', serializeInvitation(createInvitation.invitation)));
    console.log('CREATE_SWAP_ADDRESS', swapAddress.address, swapBytecode);

    // 2. Redeem invitation: the recipient's key and the preimage.
    const redeem = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'redeem',
        intent: { ...redeemIntent, secrets: [{ recipientKey: recipientPriv }] },
        variables: [
            { variableIdentifier: 'swapSatoshis', roleIdentifier: 'recipient', value: swapSatoshis },
            { variableIdentifier: 'hashlock', roleIdentifier: 'recipient', value: hashlock },
            { variableIdentifier: 'recipientPublicKey', roleIdentifier: 'recipient', value: binToHex(recipientPub) },
            { variableIdentifier: 'recipientLockingScript', roleIdentifier: 'recipient', value: recipientScript },
            { variableIdentifier: 'senderLockingScript', roleIdentifier: 'recipient', value: senderScript },
            { variableIdentifier: 'refundTime', roleIdentifier: 'recipient', value: refundTime },
            { variableIdentifier: 'preimage', roleIdentifier: 'recipient', value: preimageHex },
        ],
    });
    await engine.appendInvitation(redeem.invitation.invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'redeem',
        outputs: [{ outputIdentifier: 'recipientPayoutOutput' }],
    });
    const redeemInvitation = await engine.getInvitation(redeem.invitation.invitationIdentifier);
    if (!redeemInvitation) throw new Error('redeem invitation missing');
    console.log('redeem', writeArtifact('redeem-invitation.json', serializeInvitation(redeemInvitation.invitation)));

    // 3. Refund invitation: the sender key.
    const refund = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'refund',
        intent: { ...refundIntent, secrets: [{ senderKey: senderPriv }] },
        variables: [
            { variableIdentifier: 'swapSatoshis', roleIdentifier: 'sender', value: swapSatoshis },
            { variableIdentifier: 'hashlock', roleIdentifier: 'sender', value: hashlock },
            { variableIdentifier: 'senderPublicKey', roleIdentifier: 'sender', value: binToHex(senderPub) },
            { variableIdentifier: 'recipientPublicKey', roleIdentifier: 'sender', value: binToHex(recipientPub) },
            { variableIdentifier: 'recipientLockingScript', roleIdentifier: 'sender', value: recipientScript },
            { variableIdentifier: 'senderLockingScript', roleIdentifier: 'sender', value: senderScript },
            { variableIdentifier: 'refundTime', roleIdentifier: 'sender', value: refundTime },
        ],
    });
    await engine.appendInvitation(refund.invitation.invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'refund',
        outputs: [{ outputIdentifier: 'senderPayoutOutput' }],
    });
    const refundInvitation = await engine.getInvitation(refund.invitation.invitationIdentifier);
    if (!refundInvitation) throw new Error('refund invitation missing');
    console.log('refund', writeArtifact('refund-invitation.json', serializeInvitation(refundInvitation.invitation)));
} finally {
    await engine.stop().catch(() => undefined);
}

// The engine's background Electrum sync rejects on shutdown in this Chipnet
// environment (docs/FINDINGS.md item 1); the invitations are already written.
process.exit(0);
