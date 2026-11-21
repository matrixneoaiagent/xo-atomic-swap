# DoraHacks submission text (paste-ready)

**Bounty:** Migrate to XO — General Protocols, 1 BCH × 5 winners
**Deadline:** 2026-11-22 14:00 UTC
**Network:** Chipnet only; no mainnet funds.

## Project name

XO Atomic Swap (HTLC)

## Tagline

The BCH Stablecoin Bridge's HTLC, migrated to an XO template: redeem with a
sha256 preimage or refund after a absolute timestamp timelock, with both exits
pinned to their committed destination and value by the covenant.

## Description

The BCH Stablecoin Bridge uses a CashScript hash-time-locked contract to move
value atomically between Base Sepolia and BCH Chipnet. This submission migrates
that contract to XO.

`source/htlc.ts` defines a P2SH32 covenant committing to a sha256 hashlock, the
recipient public key and payout script, the sender payout script, and a absolute
refund timestamp. Two follow-up actions close it:

- **redeem** (recipient): reveal the preimage and sign; the covenant pays
  `input - 1500` sats to the committed recipient script.
- **refund** (sender): sign at or after the committed height; the covenant pays
  `input - 1500` sats back to the committed sender script.

The migration keeps the original's authorization model and relative refund
delay, and hardens it: the original left the destination and value to the
transaction builder, while this covenant pins both on-chain. It also replaces
`hash160(pk)` reconstruction with committed public keys and direct
`OP_CHECKSIG`, because the template language cannot rebuild a P2PKH script from a
key hash.

Chipnet evidence (test coins):

| Step | Txid |
|---|---|
| Create swap (timestamp tomorrow) | `eee5a7dfdfe9bd36a5a614c541ba8ab64095d6f3fd6268071ad3170bd53d6865` |
| Redeem with preimage | `1bd2570002410876f1aed5e737eaecf5ea71b2f0ebb1ba002534c6d7519ee862` |
| Create swap (timestamp yesterday) | `b44d1ad65df48c2e8a791825515bad06d9b5dbe065d44b9015a1d54920aa31eb` |
| Refund with sender key | `8646d3cfc58cae9bdca7be2890080b7320bbe58f9b22b6ccea43f96b17b97a4d` |
| Create swap (timestamp tomorrow) | `8cb96d60c2c0f682eacf5954326ee7da1eee49063f55f09602fb18a594d0bcf3` |
| Early refund (one hour early) | rejected: ``bad-txns-nonfinal, non-final transaction` (node); `OP_CHECKLOCKTIMEVERIFY` (VM)` |

The invitations are in `artifacts/` and open in <https://blaze.xo.cash/>. The
repository has 12 libauth BCH VM vectors covering every accept and reject path,
a reference builder, and reproduction instructions. `docs/FINDINGS.md` records
the issues found while building, including a reproducible Chipnet SPV header
sync failure in the current engine and the Chipnet policy that refuses an
nLockTime spend on an unconfirmed input.

The required 500-word feedback is written personally by the entrant and
committed as `docs/FEEDBACK.md` before the DoraHacks submission.

## Links

- Repository: `https://github.com/matrixneoaiagent/xo-atomic-swap`
- Original project: <https://github.com/matrixneoaiagent/bch-stablecoin-bridge>
- Original contract: <https://github.com/matrixneoaiagent/bch-stablecoin-bridge/blob/main/contracts/BridgeHTLC.cash>
- Live bridge demo (the project being migrated): <https://matrixneoaiagent.github.io/bch-stablecoin-bridge/>
- XO debug tool: <https://blaze.xo.cash/>
- Reproduction: `docs/REPRODUCTION.md`

## Track selection

Migrate to XO (1 BCH × 5). The same template can also be entered in Build with
XO (0.3 BCH × 10); the bounty rules allow one project to submit to multiple
bounties, and the template is novel as well as a migration.
