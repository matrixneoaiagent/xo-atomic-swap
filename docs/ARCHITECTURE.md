# Architecture

## The contract

`swapScript` is a P2SH32 covenant. Its address commits to six values:

| Value | Meaning |
|---|---|
| `hashlock` | `sha256(preimage)`, 32 bytes |
| `recipientPublicKey` | the compressed key that must sign a redeem |
| `recipientLockingScript` | where a redeem must pay |
| `senderLockingScript` | where a refund must pay |
| `refundTime` | absolute Unix timestamp at or after which a refund is valid |
| `swapSatoshis` | the balance, mirrored for off-chain maths (the UTXO is authoritative) |

The compiled redeem script has one selector and two branches:

```
OP_IF
    # selector 1: redeem
    OP_SHA256 <hashlock> OP_EQUALVERIFY          # preimage check
    <recipientPublicKey> OP_CHECKSIG OP_VERIFY    # recipient signature
    OP_TXOUTPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
    OP_0 OP_OUTPUTBYTECODE <recipientLockingScript> OP_EQUALVERIFY
    OP_0 OP_OUTPUTVALUE OP_BIN2NUM
        OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUAL
OP_ELSE
    # selector 2: refund
    OP_2 OP_NUMEQUALVERIFY
    <refundTime> OP_CHECKLOCKTIMEVERIFY OP_DROP   # absolute timestamp
    <senderPublicKey> OP_CHECKSIG OP_VERIFY        # sender signature
    OP_TXOUTPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
    OP_0 OP_OUTPUTBYTECODE <senderLockingScript> OP_EQUALVERIFY
    OP_0 OP_OUTPUTVALUE OP_BIN2NUM
        OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUAL
OP_ENDIF
```

The unlock scripts are:

```
redeem: <recipient sig + sighash> <preimage> OP_1 <redeem script>
refund: <sender sig + sighash>              OP_2 <redeem script>   (tx.locktime = refundTime)
```

The refund transaction's `nLockTime` is the committed timestamp.
`OP_CHECKLOCKTIMEVERIFY` refuses the branch if the transaction locktime is
earlier, and the node refuses to relay it until the wall clock reaches it. The
input sequence must not be `0xffffffff`, or CLTV is disabled; the reference
builder uses `0xfffffffe`.

The selector is pushed before the redeem script because P2SH32 evaluates the
redeem script last. `OP_IF` consumes it; for redeem, the preimage is left on top
for `OP_SHA256`.

## Why public keys are creation variables

The template language cannot concatenate a P2PKH script from a raw hash inside a
covenant. The original CashScript contract committed `hash160(pk)` and let the
spender supply `pk`. This template commits both full public keys
(`senderPublicKey`, `recipientPublicKey`) as public creation variables and runs
`OP_CHECKSIG` against them. The trade-off is that the full keys, not just their
hashes, are committed in the address. That is not a secret; it is the same
information a P2PKH address hides, and it keeps the address a pure function of
public data.

The private keys are only needed when a role signs. They are declared as action
secrets (`senderKey` for refund, `recipientKey` for redeem), so a wallet that
holds them can follow up without re-deriving anything from the address.

The payout scripts are separate committed values, so the covenant can pin the
destination without reconstructing a P2PKH script.

## State machine

```
createSwap (sender)
      │
      ▼
  swapScript ──► redeem (recipient, preimage + signature, any time)
      │
      └────────► refund (sender, signature, only after the relative period)
```

`redeem` and `refund` are follow-up actions on the same locking script, exposed
to the two roles. Both close the covenant; there is no third path.

## Security notes

- **Front-running.** A redeem reveals the preimage in the mempool. The covenant
  only pays `recipientLockingScript`, so a copier cannot redirect the funds.
  This is why the original requires the recipient signature as well as the
  secret.
- **Timelock coordination.** The sender sets `refundTime` so that the refund
  becomes valid only after the other chain's leg can no longer be redeemed by
  the sender. The original used an absolute height; this migration uses an
  absolute timestamp because Chipnet nodes currently reject a height-based
  `nLockTime` (`docs/FINDINGS.md` item 2). A cross-chain script picks the
  timestamp to match the other chain's window, which is natural for an EVM
  counterparty that already uses `block.timestamp`.
- **No replay.** A redeem consumes the covenant UTXO. A second redeem would
  need the same UTXO, which no longer exists. A refund after a redeem fails for
  the same reason.
- **Value pinning.** Both exits pay exactly `input - 1500` to the committed
  script, so a spender cannot attach a second output that drains the balance.
- **Fee.** 1,500 sats is fixed in the covenant, mirroring the original
  contract's hardcoded miner fee. A higher fee would need a new template
  instance; a lower one is impossible.
- **Token variant.** The original bridge can lock a mock PUSD CashToken. This
  template does not yet pin a token category/amount. Documented as future work.

## Differences from the original

| Topic | Original `BridgeHTLC.cash` | This template |
|---|---|---|
| Key commitment | `hash160(pk)` | full compressed public key |
| Destination | builder-enforced | covenant-enforced |
| Value | builder-enforced | covenant-enforced |
| Timelock | `tx.time >= timelock` (absolute height) | `OP_CHECKLOCKTIMEVERIFY` + `tx.locktime` (absolute timestamp) |
| Selector | cashc-generated | explicit `OP_IF` selector |
| Tokens | native + CashToken | native BCH only |

The first four changes make the covenant stronger, the fifth is a Chipnet
adaptation (height-based locktime is not relayable today), and the last is a scoped
limitation, not a regression in the native-BCH path.

## Why an XO template

The bridge's HTLC was a one-off CashScript contract with a bespoke TypeScript
builder. As an XO template it becomes:

- **inspectable**: an invitation carries the template, variables and expected
  outputs, and the XO debug tool can render it;
- **wallet-connectable**: a wallet that speaks XO can create and follow up on a
  swap without a bespoke integration;
- **composable**: the same `swapScript` can back a bridge, an OTC desk or a
  submarine swap, with the payout scripts chosen per instance;
- **reproducible**: the address is a pure function of six public values.
