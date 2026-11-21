# Findings while building this template

These are reproducible observations from building and running the template on
Chipnet on 21 November 2026. They are inputs for the personally written feedback
required by the bounty, not a substitute for it.

## 1. Chipnet header sync stops at height 332451 in `@electrum-cash/application`

The XO engine's SPV sync fails permanently at Chipnet height 332451:

```
Header '00000000000ecc7187034ddaa4327af300c23fd57bfd2557af6ca2392a022671'
at height 332451 claims target 486604799, expected 437753688.
```

`486604799` is the compressed difficulty-1 target (`0x1d00ffff`), i.e. a
minimum-difficulty block. Chipnet's `allowMinimumDifficultyBlocks` is true in the
shipped network parameters, but the ASERT function only returns the minimum
target when `timestamp - parentTimestamp > 2 * 600 s`; this block does not meet
that condition but is still valid on the network. Sync stops at 77.4 %, so
`Engine.listSpendableUnspentOutputs()` returns `[]` even when the wallet has
confirmed coins.

Impact: the engine cannot build or sign a transaction from a wallet UTXO on
Chipnet with the shipped dependency versions (`@xo-cash/engine`
`0.1.1-next.17778370827`, `@electrum-cash/application` 1.5.x).

Workaround used here: `scripts/lib/tx.ts` is a reference builder that compiles
the template's own CashASM and builds the transactions with libauth. The
invitations are still produced by the engine (`scripts/make-invitations.ts`),
because invitation creation and output resolution are local operations. The
addresses match: both paths compile the same template with the same variables.

Suggested fix: treat a header whose compressed target equals
`minimumDifficultyTarget` as satisfying the minimum-difficulty rule regardless of
the 2× timestamp condition, or expose a "trust this checkpoint" bootstrap so a
wallet can start after a known height.

## 2. Chipnet nodes reject every transaction with a nonzero `nLockTime`

A correctly signed refund with `nLockTime` set to a past height is rejected by
all three public Chipnet Electrum servers (bch.ninja, imaginary.cash,
c3-soft):

```
bad-txns-nonfinal, non-final transaction (code 64)
```

The control cases isolate the cause:

| `nLockTime` | Input sequence | Result |
|---|---|---|
| `0` | `0xfffffffe` | accepted |
| `1` | `0xfffffffe` | `bad-txns-nonfinal` |
| `340000` | `0xfffffffe` | `bad-txns-nonfinal` |
| current tip − 1 (341294) | `0xfffffffe` | `bad-txns-nonfinal` |
| `341242` | `0xffffffff` | `non-mandatory-script-verify-flag (Locktime requirement not satisfied)` |

Every nonzero absolute locktime is treated as non-final, even when it is far
below the tip. That makes `OP_CHECKLOCKTIMEVERIFY` unusable for a relayed
transaction on Chipnet today, independent of the covenant: a plain P2PKH
self-transfer with `nLockTime = 1` fails the same way.

BIP68 relative locktime is broken too: a plain P2PKH spend with input sequence
`1` or `2` on a coin that is two blocks old is rejected `non-BIP68-final`, and
`sequence = 0` (BIP68 disabled) is accepted. The inheritance-vault claim that
used CSV on 18 November confirmed at block 337175, so this is a regression in
the current Chipnet node software, not a property of the template.

Timestamp-based `nLockTime` **does** work: a plain P2PKH spend with
`nLockTime = 1_700_000_000` (November 2023) and sequence `0xfffffffe` is
accepted, while a future timestamp is rejected as non-final. The node appears to
treat `nLockTime` as a timestamp regardless of the 500,000,000 threshold, so a
height value (e.g. 341242) is in the far past as a timestamp... and yet is
rejected. The exact rule is inconsistent; what matters is the empirical result.

Impact: the original `BridgeHTLC.cash` uses `tx.time >= timelock` with an
absolute height. The XO migration keeps `tx.time` but commits an **absolute Unix
timestamp**, which Chipnet nodes accept. The refund semantics are "at or after
this moment", which is natural for an EVM counterparty using `block.timestamp`.

Suggestion: fix the Chipnet finality check, or document the height/timestamp
inconsistency. A wallet that only tests scripts locally will not notice until
broadcast.

## 3. CashASM identifiers must be unique across variables and scripts

Naming a template script `recipientPublicKey` while a variable has the same
identifier fails at compile time:

```
CashAssembly identifier exists for more than one resolution type:
identifier "recipientPublicKey", resolutionTypes [variable, script]
```

The fix is a distinct script name (`recipientPublicKeyPush`). This is easy to hit
when a script exists only to push a variable.

## 4. `bytes` variables are hex strings in both locking and unlocking scripts

A `bytes` variable is supplied as lowercase hex and is pushed as data. That makes
a 32-byte sha256 hashlock and a 32-byte preimage natural template variables. The
preimage can live in the redeem action's variables; it is only revealed when the
transaction is broadcast, which is exactly the HTLC behaviour. It does not need
to be a `private_key` secret.

## 5. A timestamp works as a transaction locktime; a height does not

`locktime: '$(<refundTime>)'` resolves from the template state and produces a
transaction whose `nLockTime` equals the committed timestamp. Combined with
`OP_CHECKLOCKTIMEVERIFY`, this gives the original's `tx.time >= timelock`
behaviour. The only change is the unit: seconds instead of blocks, because of
item 2.

A height-based `locktime: '$(<height>)'` compiles and passes the local VM, but
every Chipnet node rejects the broadcast. This is the kind of difference a
local VM test cannot catch.

## 6. A supplied secret value is ignored; the engine generates a new key

Passing `secrets: [{ senderKey: <hex> }]` in the action intent, even with
`generate: []`, does **not** import that key. `engine.listSecretData()` reports
the stored secret as `isEntropy: true`, and the resolved address uses a random
public key, not the one derived from the supplied hex. The same template with the
key committed as a `public_key` variable resolves to the expected address.

Workaround used here: both public keys are public creation variables
(`senderPublicKey`, `recipientPublicKey`) and the private keys are only needed at
signature time. This is also better template design: the address is a pure
function of public data, and a wallet can reproduce it without holding either
key.

Suggestion: either reject a supplied secret value with a clear error, or add an
explicit "import this key" path. Silently generating entropy is surprising.

## 7. Selector dispatch for a two-function covenant

The cashc-style selector works in a hand-written template:

```
OP_DUP OP_1 OP_NUMEQUAL OP_IF OP_DROP <redeem branch>
OP_ELSE OP_2 OP_NUMEQUALVERIFY <refund branch> OP_ENDIF
```

The redeem unlock must push the preimage **before** the selector so `OP_IF`
consumes the selector and leaves the preimage on top for `OP_SHA256`. Pushing it
after the selector leaves an extra stack item and fails the clean-stack check.

## 8. The template language cannot build a P2PKH script from a key hash

Committing `hash160(pk)` and reconstructing `OP_DUP OP_HASH160 … OP_CHECKSIG`
inside the covenant is not expressible with the current helpers. The template
commits the full public key and the payout locking script instead. This is
equivalent for authorization and strictly stronger for destination pinning, at
the cost of a slightly longer address commitment.

## 9. CashToken outputs are not covered by this migration

The original bridge's token leg (mock PUSD) is not migrated. A token-aware HTLC
would need to pin the category and amount on both exits, and the template's
output `token` field alone is not an enforcement: the covenant script would need
`OP_OUTPUTTOKENCATEGORY`/`OP_OUTPUTTOKENAMOUNT` checks. This is documented as
future work rather than claimed as done.
