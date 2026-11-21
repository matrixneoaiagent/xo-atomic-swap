import type { XOTemplate } from '@xo-cash/types';

/**
 * XO Atomic Swap (HTLC)
 *
 * A migration of the `BridgeHTLC.cash` CashScript contract used by the BCH
 * Stablecoin Bridge (https://github.com/matrixneoaiagent/bch-stablecoin-bridge)
 * into an XO template.
 *
 * The covenant commits to six things:
 *
 *   - hashlock              sha256(preimage) that authorises the redeem path
 *   - recipientPublicKey    the only key that may redeem
 *   - recipientLockingScript where a redeem must pay
 *   - senderPublicKey       the only key that may refund
 *   - senderLockingScript   where a refund must pay
 *   - refundTime            absolute Unix timestamp after which a refund is valid
 *
 * Two exits, no third:
 *
 *   1  redeem   recipient reveals the preimage and signs; the balance goes to
 *               the committed recipient script (minus the fixed fee).
 *   2  refund   sender signs after the timestamp; the balance goes back to the
 *               committed sender script (minus the fixed fee).
 *
 * The original CashScript contract only checked the hashlock, the key hashes
 * and the signatures; the destination was enforced by the off-chain bridge
 * code. This template additionally pins output 0 of both exits to the
 * committed payout script and pins the exact value, so the covenant itself
 * enforces the swap, not the transaction builder. That difference is
 * deliberate and documented in docs/ARCHITECTURE.md.
 *
 * Differences from the CashScript original (also documented):
 *   - the sender and recipient public keys are committed directly instead of
 *     hash160(key) so the template can use `checkSig` without reconstructing
 *     a P2PKH script inside the covenant;
 *   - `tx.time` is kept as the refund rule, expressed as an absolute Unix
 *     timestamp and enforced with OP_CHECKLOCKTIMEVERIFY.
 */
export const atomicSwapTemplate: XOTemplate = {
    $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',

    name: 'XO Atomic Swap (HTLC)',
    description:
        'A hash-time-locked contract: the recipient redeems with a sha256 preimage and a signature, or the sender refunds after an absolute timestamp timelock. Both exits pay the committed destination and are enforced by the covenant.',
    icon: 'swap',

    version: '1',
    supported: [ 'BCH_2023_05', 'BCH_2024_05', 'BCH_2025_05', 'BCH_2026_05' ],

    resources: [
        {
            name: 'XO template documentation',
            description: 'Guide to writing XO templates.',
            url: 'https://stack.xo.cash/blog/2026-08-24-Vision-to-Reality-6-Writing-Templates.html',
        },
        {
            name: 'Original project: BCH Stablecoin Bridge',
            description: 'The working CashScript/Solidity HTLC bridge this template migrates to XO.',
            url: 'https://github.com/matrixneoaiagent/bch-stablecoin-bridge',
        },
        {
            name: 'Original contract: BridgeHTLC.cash',
            description: 'The CashScript HTLC that is the source of this migration.',
            url: 'https://github.com/matrixneoaiagent/bch-stablecoin-bridge/blob/main/contracts/BridgeHTLC.cash',
        },
        {
            name: 'Bitcoin Cash absolute locktime (BIP65)',
            description: 'The consensus rule behind tx.time in CashScript and OP_CHECKLOCKTIMEVERIFY here.',
            url: 'https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki',
        },
    ],

    roles: {
        sender: {
            name: 'Sender',
            description: 'Funds the swap and can refund the whole balance after the timestamp.',
            icon: 'sender',
        },
        recipient: {
            name: 'Recipient',
            description: 'Redeems the swap at any time by revealing the sha256 preimage and signing with the committed key.',
            icon: 'recipient',
        },
    },

    start: [
        {
            action: 'createSwap',
            role: 'sender',
        },
    ],

    actions: {
        createSwap: {
            name: 'Create Atomic Swap',
            description:
                'Lock BCH in a new hash-time-locked covenant for a recipient. The hashlock, both payout scripts, both keys and the refund height are committed into the address.',
            icon: 'swap',

            roles: {
                sender: {
                    name: 'Fund swap',
                    description:
                        'Choose the recipient key and payout script, the sha256 hashlock, the refund height and the amount.',
                    icon: 'sender',

                    requirements: {
                        variables: [
                            'swapSatoshis',
                            'hashlock',
                            'senderPublicKey',
                            'recipientPublicKey',
                            'recipientLockingScript',
                            'senderLockingScript',
                            'refundTime',
                        ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'sender', slots: { min: 1, max: 1 } },
                ],
            },

            transaction: 'createSwapTransaction',
        },

        redeem: {
            name: 'Redeem (reveal preimage)',
            description:
                'The recipient reveals the preimage whose sha256 is the committed hashlock, signs, and takes the balance to the committed recipient script.',
            icon: 'redeem',

            roles: {
                recipient: {
                    requirements: {
                        variables: [
                            'swapSatoshis',
                            'hashlock',
                            'recipientLockingScript',
                            'preimage',
                        ],
                        secrets: [ 'recipientKey' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'recipient', slots: { min: 1, max: 1 } },
                ],
            },

            // Off-chain mirror of the on-chain value rule for UIs.
            conditions: [
                '$(<swapSatoshis> <1500> OP_SUB <546> OP_GREATERTHANOREQUAL)',
            ],

            transaction: 'redeemTransaction',
        },

        refund: {
            name: 'Refund (after timestamp)',
            description:
                'After the committed timestamp, the sender signs and takes the balance back to the committed sender script. Before that time the covenant refuses the spend.',
            icon: 'refund',

            roles: {
                sender: {
                    requirements: {
                        variables: [
                            'swapSatoshis',
                            'refundTime',
                            'senderLockingScript',
                        ],
                        secrets: [ 'senderKey' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'sender', slots: { min: 1, max: 1 } },
                ],
            },

            conditions: [
                '$(<swapSatoshis> <1500> OP_SUB <546> OP_GREATERTHANOREQUAL)',
            ],

            transaction: 'refundTransaction',
        },
    },

    transactions: {
        createSwapTransaction: {
            name: 'Atomic Swap Created',
            description:
                'Locked $(<swapSatoshis>) satoshis in an HTLC for the recipient, refundable by the sender at the committed timestamp.',
            icon: 'swap',

            inputs: [],
            outputs: [
                { output: 'initialSwapOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        redeemTransaction: {
            name: 'Swap Redeemed',
            description:
                'The recipient revealed the preimage and took the balance. The secret is now public on-chain.',
            icon: 'redeem',

            inputs: [
                { input: 'redeemInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'recipientPayoutOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        refundTransaction: {
            name: 'Swap Refunded',
            description:
                'The sender refunded the swap after the timestamp passed.',
            icon: 'refund',

            inputs: [
                { input: 'refundInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'senderPayoutOutput', outputIndex: 0 },
            ],

            // Absolute locktime: the transaction's nLockTime is the committed
            // Unix timestamp, and OP_CHECKLOCKTIMEVERIFY enforces it.
            version: 2,
            locktime: '$(<refundTime>)',
            composable: true,
        },
    },

    inputs: {
        redeemInput: {
            name: 'Swap balance',
            description: 'The covenant output holding $(<swapSatoshis>) satoshis.',
            icon: 'swap',

            valueSatoshis: '$(<swapSatoshis>)',
            token: null,
            unlockingScript: 'unlockRedeem',
        },
        refundInput: {
            name: 'Swap balance',
            description: 'The covenant output holding $(<swapSatoshis>) satoshis.',
            icon: 'swap',

            valueSatoshis: '$(<swapSatoshis>)',
            token: null,
            unlockingScript: 'unlockRefund',
        },
    },

    outputs: {
        initialSwapOutput: {
            name: 'Atomic Swap',
            description:
                'A new covenant holding $(<swapSatoshis>) satoshis, redeemable with the preimage or refundable after the timestamp.',
            icon: 'swap',

            lockingScript: 'swapScript',
            valueSatoshis: '$(<swapSatoshis>)',
            token: null,
        },

        recipientPayoutOutput: {
            name: 'Recipient payout',
            description: 'The whole balance minus the fixed fee, paid to the recipient script committed in the covenant.',
            icon: 'recipient',

            lockingScript: '$(<recipientLockingScript>)',
            valueSatoshis: '$(<swapSatoshis> <1500> OP_SUB)',
            token: null,
        },

        senderPayoutOutput: {
            name: 'Sender refund',
            description: 'The whole balance minus the fixed fee, paid back to the sender script committed in the covenant.',
            icon: 'sender',

            lockingScript: '$(<senderLockingScript>)',
            valueSatoshis: '$(<swapSatoshis> <1500> OP_SUB)',
            token: null,
        },
    },

    lockingScripts: {
        swapScript: {
            name: 'Atomic Swap (HTLC)',
            description:
                'Holds the balance and enforces the two exits: a preimage + recipient signature redeem, or a sender-signed refund after the committed timestamp.',
            icon: 'swap',

            lockingType: 'p2sh',
            lockingBytecode: 'swapRedeemBytecode',
            unlockingBytecode: 'unlockRedeem',

            state: {
                variables: [
                    'hashlock',
                    'recipientPublicKey',
                    'recipientLockingScript',
                    'senderLockingScript',
                    'refundTime',
                    'swapSatoshis',
                ],
                secrets: [],
            },

            roles: {
                sender: {
                    state: {
                        variables: [],
                        secrets: [],
                    },

                    actions: [
                        { action: 'refund', role: 'sender', secrets: [{ senderKey: null }] },
                    ],

                    balance: {
                        satoshis: true,
                    },

                    // The engine currently normalizes Electrum UTXOs as
                    // selectable; apps must pass the covenant input explicitly.
                    selectable: false,
                },

                recipient: {
                    state: {
                        variables: [],
                        secrets: [],
                    },

                    actions: [
                        { action: 'redeem', role: 'recipient', secrets: [{ recipientKey: null }] },
                    ],

                    selectable: false,
                },
            },
        },
    },

    scripts: {
        // Both public keys are public creation parameters, pushed back onto the
        // stack at spend time for the signature check.
        senderPublicKeyPush: '<senderPublicKey>',
        recipientPublicKeyPush: '<recipientPublicKey>',

        // require(checkSig(sig, key))
        enforceSenderSignature: 'senderPublicKeyPush OP_CHECKSIG',
        enforceRecipientSignature: 'recipientPublicKeyPush OP_CHECKSIG',

        // require(sha256(preimage) == hashlock). The unlock script pushes the
        // preimage before the selector, so this consumes the stack item that is
        // already there instead of pushing a second copy.
        enforceHashlock: 'OP_SHA256 <hashlock> OP_EQUALVERIFY',

        // require(tx.time >= refundTime)
        enforceRefundTime: '<refundTime> OP_CHECKLOCKTIMEVERIFY OP_DROP',

        // require(tx.outputs.length == 1)
        enforceSingleOutput: 'OP_TXOUTPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY',

        // require(tx.outputs[0].lockingBytecode == committed script)
        enforceRedeemDestination: 'OP_0 OP_OUTPUTBYTECODE <recipientLockingScript> OP_EQUALVERIFY',
        enforceRefundDestination: 'OP_0 OP_OUTPUTBYTECODE <senderLockingScript> OP_EQUALVERIFY',

        // require(tx.outputs[0].value == tx.inputs[0].value - 1500)
        enforceRedeemValue:
            'OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUAL',
        enforceRefundValue:
            'OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUAL',

        // function redeem(): preimage + recipient signature, pinned payout.
        enforceRedeem:
            'enforceHashlock enforceRecipientSignature OP_VERIFY enforceSingleOutput enforceRedeemDestination enforceRedeemValue',

        // function refund(): timestamp + sender signature, pinned payout.
        enforceRefund:
            'enforceRefundTime enforceSenderSignature OP_VERIFY enforceSingleOutput enforceRefundDestination enforceRefundValue',

        // Function selector, the same shape `cashc` emits for multi-function
        // contracts: 1 = redeem, 2 = refund.
        swapRedeemBytecode:
            'OP_DUP OP_1 OP_NUMEQUAL OP_IF OP_DROP enforceRedeem OP_ELSE OP_2 OP_NUMEQUALVERIFY enforceRefund OP_ENDIF',

        // The preimage is pushed before the selector so OP_IF consumes the
        // selector and leaves the preimage on top for OP_SHA256.
        unlockRedeem: '<recipientKey.schnorr_signature.all_outputs> <preimage> <1>',
        unlockRefund: '<senderKey.schnorr_signature.all_outputs> <2>',
    },

    constants: {
        feeSatoshis: {
            name: 'Fixed miner fee',
            description:
                'Fixed fee taken from the swap on either exit. Inlined into the covenant as <1500>; template constants are not exposed inside compiled scripts.',
            type: 'satoshis',
            value: 1500n,
        },
        dustLimit: {
            name: 'Dust limit',
            description: 'Minimum payout value the off-chain helpers accept.',
            type: 'satoshis',
            value: 546n,
        },
    },

    variables: {
        senderKey: {
            name: 'Sender key',
            description:
                'The key that authorises a refund. Its public key is committed into the covenant address at creation.',
            type: 'private_key',
        },
        recipientKey: {
            name: 'Recipient key',
            description:
                'The key that authorises a redeem. It must match recipientPublicKey; the covenant checks the signature against that committed key.',
            type: 'private_key',
        },
        hashlock: {
            name: 'Hashlock',
            description: 'The 32-byte sha256 hash of the preimage. Changing it changes the address.',
            type: 'bytes',
        },
        preimage: {
            name: 'Preimage',
            description:
                'The secret whose sha256 equals the hashlock. It is private until the redeem transaction is broadcast, then public on-chain.',
            type: 'bytes',
        },
        senderPublicKey: {
            name: 'Sender public key',
            description:
                'The compressed public key that must sign a refund. Committed into the covenant address; it must match senderKey when the sender signs.',
            type: 'public_key',
        },
        recipientPublicKey: {
            name: 'Recipient public key',
            description:
                'The compressed public key that must sign a redeem. Committed into the covenant address.',
            type: 'public_key',
        },
        recipientLockingScript: {
            name: 'Recipient payout script',
            description: 'The locking script a redeem must pay. Usually the P2PKH script of the recipient key.',
            type: 'locking_script',
        },
        senderLockingScript: {
            name: 'Sender refund script',
            description: 'The locking script a refund must pay. Usually the P2PKH script of the sender key.',
            type: 'locking_script',
        },
        refundTime: {
            name: 'Refund height',
            description:
                'absolute timestamp locktime in blocks. The refund input must have a sequence of at least this value, and the coin must be that many blocks old; before that the branch is refused by OP_CHECKLOCKTIMEVERIFY.',
            type: 'integer',
        },
        swapSatoshis: {
            name: 'Swap balance',
            description: 'The current number of satoshis held by the covenant. Informational mirror; the authoritative balance is the UTXO value.',
            type: 'satoshis',
        },
    },

    icons: [
        { name: 'swap', hash: '0000000000000000000000' },
        { name: 'sender', hash: '0000000000000000000000' },
        { name: 'recipient', hash: '0000000000000000000000' },
        { name: 'redeem', hash: '0000000000000000000000' },
        { name: 'refund', hash: '0000000000000000000000' },
    ],
};
