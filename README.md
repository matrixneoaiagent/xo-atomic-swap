# XO Atomic Swap (HTLC)

An XO template migration of the BCH Stablecoin Bridge's `BridgeHTLC.cash`
contract. A sender locks BCH in a hash-time-locked covenant; the recipient
redeems it by revealing a sha256 preimage and signing, or the sender refunds it
after an absolute timestamp timelock. Both exits pay a destination and an
exact value enforced by the covenant itself.

- **Bounty:** [Migrate to XO](https://bchblaze.cash/bounties/migrate-to-xo/) — General Protocols, 1 BCH × 5 winners, judged 23–27 November 2026.
- **Original project:** [bch-stablecoin-bridge](https://github.com/matrixneoaiagent/bch-stablecoin-bridge) (`contracts/BridgeHTLC.cash`, commit `a585557`).
- **Network:** Bitcoin Cash Chipnet only. No mainnet funds.
- **License:** MIT.

## What was migrated

The original contract has two paths:

```cashscript
function redeem(bytes secret, pubkey pk, sig s) {
    require(sha256(secret) == hashlock);
    require(hash160(pk) == recipientHash);
    require(checkSig(s, pk));
}
function refund(pubkey pk, sig s) {
    require(tx.time >= timelock);
    require(hash160(pk) == senderHash);
    require(checkSig(s, pk));
}
```

The XO template keeps the same two exits and the same refund-delay idea,
and adds covenant-enforced payout pins:

| Rule | Original CashScript | XO template |
|---|---|---|
| Preimage check | `sha256(secret) == hashlock` | `OP_SHA256 <hashlock> OP_EQUALVERIFY` |
| Redeem authorisation | `hash160(pk) == recipientHash` + `checkSig` | committed `recipientPublicKey` + `OP_CHECKSIG` |
| Refund authorisation | `hash160(pk) == senderHash` + `checkSig` | committed sender key + `OP_CHECKSIG` |
| Refund timelock | `tx.time >= timelock` (absolute height) | `OP_CHECKLOCKTIMEVERIFY` + `tx.locktime = <refundTime>` (absolute timestamp) |
| Redeem destination | transaction builder | covenant pins output 0 to `recipientLockingScript` |
| Refund destination | transaction builder | covenant pins output 0 to `senderLockingScript` |
| Value | transaction builder | covenant pins output 0 to `input - 1500` sats |
| Function dispatch | cashc selector | `OP_IF` selector 1 = redeem, 2 = refund |

The destination and value pins are a deliberate hardening over the original: a
covenant that only checks a signature and a hash lets any caller send the money
anywhere. The migration makes the covenant itself enforce the swap.

## Chipnet evidence

| Step | Transaction | What it proves |
|---|---|---|
| Create swap A | `eee5a7dfdfe9bd36a5a614c541ba8ab64095d6f3fd6268071ad3170bd53d6865` | Funds `bchtest:pv9e2lyp4dnnmspql730p9rntgh6hc8k55njzzz0vhwenecav53sw0a6zw8l4` with 60,000 sats |
| Redeem A | `1bd2570002410876f1aed5e737eaecf5ea71b2f0ebb1ba002534c6d7519ee862` | Preimage `42…42` + recipient signature releases 58,500 sats to the recipient script |
| Create swap B | `b44d1ad65df48c2e8a791825515bad06d9b5dbe065d44b9015a1d54920aa31eb` | Funds `bchtest:pwz2u3cdm5z0kme54p2yw0vmy32t4q2sj7s22mpw2n4vl2jyzlhvcrfjfja84` with a timestamp in the past |
| Refund B | `8646d3cfc58cae9bdca7be2890080b7320bbe58f9b22b6ccea43f96b17b97a4d` | Sender signature + CLTV returns 58,500 sats |
| Create swap C | `8cb96d60c2c0f682eacf5954326ee7da1eee49063f55f09602fb18a594d0bcf3` | Funds `bchtest:pvgf79ftvpqng68s82lt85mg36gfuygr0e5a8ytctu45zj3vt4sdz7kse2pwt` with a timestamp one hour in the future |
| Early refund C | rejected | Local VM refuses a locktime one second short; the node refuses the real locktime until the wall clock reaches it |

The full transaction log, including rejection reasons, is in
[`docs/EVIDENCE.md`](docs/EVIDENCE.md). Explorer links use
`https://chipnet.imaginary.cash/tx/<txid>`.

## Requirements → where they are satisfied

| Bounty requirement | Where |
|---|---|
| Novel, well-designed, functional XO template | [`source/htlc.ts`](source/htlc.ts) |
| Correctly implements its intended contract | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), 12 VM vectors in [`test/vm.test.ts`](test/vm.test.ts) |
| Execute a Chipnet transaction with an inspectable invitation | [`artifacts/`](artifacts/), [`docs/EVIDENCE.md`](docs/EVIDENCE.md) |
| Submit the invitation used | `artifacts/createSwap-invitation.json`, `artifacts/redeem-invitation.json`, `artifacts/refund-invitation.json` |
| Follow-up actions | `redeem` and `refund` are follow-ups on `swapScript` for the recipient and sender roles |
| Template + invitation + reproduction instructions | [`docs/REPRODUCTION.md`](docs/REPRODUCTION.md) |
| Links to original project and XO implementation | this README, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Personally written feedback | [`docs/FEEDBACK_TEMPLATE.md`](docs/FEEDBACK_TEMPLATE.md) — **the user must write the final 500 words**; the technical findings in [`docs/FINDINGS.md`](docs/FINDINGS.md) are inputs, not a substitute |

## Quick start

```bash
npm install
npm run typecheck
npm test          # 12 VM vectors: every accept and reject path
npm run demo      # build + locally verify the whole sequence (no broadcast)
BROADCAST=1 npm run demo   # send it on Chipnet (test coins only)
```

The demo needs a funded Chipnet key. It reads `SENDER_PRIV` (hex, default
`00…03`), `RECIPIENT_PRIV` (default `00…02`), `PREIMAGE` (default 32 × `0x42`)
and `SWAP_SATS` (default 60,000). Fund the sender's P2PKH address from
[`chipnet.bch.ninja`](https://chipnet.bch.ninja/) or
[`tbch.googol.cash`](https://tbch.googol.cash/); both are free testnet faucets.

Inspect an invitation at the XO debug tool, <https://blaze.xo.cash/>, by
importing the JSON from `artifacts/`.

## Layout

| Path | Contents |
|---|---|
| `source/htlc.ts` | the XO template |
| `scripts/demo.ts` | reference builder: create, redeem, refund, early-refund rejection |
| `scripts/make-invitations.ts` | produces the inspectable invitations (no chain access) |
| `scripts/evidence-extra.ts` | waits for confirmations, refunds, and captures the node rejection |
| `scripts/lib/tx.ts` | libauth transaction builder and Electrum broadcast |
| `test/` | template validation and 12 BCH VM vectors |
| `docs/` | architecture, reproduction, findings, evidence, submission text |
| `artifacts/` | invitations and run records |

## Limitations

- Native BCH only. The original bridge also moves a mock PUSD CashToken; this
  migration keeps the native-BCH path and documents the token variant as future
  work (the covenant would need to pin the token category and amount).
- Fixed 1,500-sat fee on both exits, mirroring the original contract's fixed
  miner fee.
- The refund uses an absolute **Unix timestamp**, not the original's absolute
  block height, because every public Chipnet node currently rejects a
  height-based `nLockTime` (`docs/FINDINGS.md` item 2) while accepting a
  timestamp-based one. The refund semantics are otherwise the same: the sender
  cannot refund before the committed moment, and the recipient can redeem at any
  time.
- The preimage becomes public when the redeem transaction is broadcast. That is
  the HTLC's design: the counterparty uses the revealed secret on the other
  chain.
- Not audited. Testnet only.
