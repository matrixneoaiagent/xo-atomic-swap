# Reproduction

Everything below runs on Chipnet with free test coins. No mainnet key is used.

## 1. Install and test

```bash
npm install
npm run typecheck
npm test
```

`npm test` runs 12 vectors in libauth's BCH VM: redeem success, wrong preimage,
wrong signer, wrong destination, wrong value, refund success, refund one block
early, wrong signer, wrong destination, and address sensitivity to each
committed value.

## 2. Keys and funding

The demo uses two throwaway Chipnet keys:

| Role | Default key | Address |
|---|---|---|
| sender | `00…03` | `bchtest:qp7av4vj6z4jlcxsy474wx4lqvkdnkunms9kkx0r2k` |
| recipient | `00…02` | `bchtest:q…` (derived from the key) |

Override them with `SENDER_PRIV`, `RECIPIENT_PRIV`, `PREIMAGE`, `SWAP_SATS` and `REFUND_TIME`.

Fund the sender from a free Chipnet faucet:

- <https://chipnet.bch.ninja/> (SHA-256 proof-of-work gate, automatable)
- <https://tbch.googol.cash/>

The faucet at `chipnet.bch.ninja` exposes `POST /api/challenge` and
`POST /api/claim`; the proof is `sha256("${payload}:${nonce}") <= target`.
`npm run faucet -- bchtest:qp7av4vj6z4jlcxsy474wx4lqvkdnkunms9kkx0r2k 300000`
performs that proof automatically. This repository does not need the faucet at
runtime; any funded P2PKH key works.

Set `FUNDING_TXID`, `FUNDING_VOUT` and `FUNDING_VALUE` if the sender's Electrum
view is not ready yet, or let `scripts/demo.ts` find the largest UTXO itself.

## 3. Compile the covenant and inspect the address

```bash
REFUND_TIME=1795300000 npm run invitations
```

This writes `artifacts/createSwap-invitation.json`,
`artifacts/redeem-invitation.json` and `artifacts/refund-invitation.json`, and
prints `CREATE_SWAP_ADDRESS`. Open the JSON in <https://blaze.xo.cash/> to
inspect the invitation. The address is a pure function of:

```
senderPublicKey, hashlock, recipientPublicKey, recipientLockingScript,
senderLockingScript, timelock
```

## 4. Build and verify without broadcasting

```bash
npm run demo
```

Every step prints `VM_OK` after libauth evaluates the transaction against the
real covenant. No transaction is sent.

## 5. Broadcast on Chipnet

```bash
BROADCAST=1 npm run demo
```

The script sends:

1. create swap A (60,000 sats, timestamp tomorrow) and redeem it with the
   preimage;
2. create swap B (60,000 sats, timestamp yesterday), wait for confirmation, and
   refund it;
3. create swap C (timestamp one hour in the future), wait for confirmation, and
   show that a refund one second early is rejected by the VM and the real
   refund is rejected by the node until the wall clock reaches the timestamp.

The refund step waits for the create transaction to confirm so the covenant
UTXO is in the node's UTXO set. The demo then refunds and captures the node's
rejection of an early refund.

## 6. Verify a transaction independently

```bash
curl -s https://chipnet.imaginary.cash/api/tx/<txid> | head
```

or in the explorer: <https://chipnet.imaginary.cash/tx/<txid>>.

The invitation's `CREATE_SWAP_ADDRESS` must equal the address of output 0 of the
create transaction. `scripts/lib/tx.ts`'s `compileSwap` recompiles the template
from its own CashASM, so a mismatch fails the VM check before broadcast.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SENDER_PRIV` | `00…03` | hex private key that funds and refunds |
| `RECIPIENT_PRIV` | `00…02` | hex private key that redeems |
| `PREIMAGE` | `42` × 32 | hex preimage |
| `SWAP_SATS` | `60000` | amount per swap |
| `FUNDING_TXID` / `FUNDING_VOUT` / `FUNDING_VALUE` | — | explicit funding outpoint |
| `REFUND_TIME` | now + 1 day | refund timestamp for the invitation generator |
| `BROADCAST` | unset | `1` sends transactions |
| `XO_ELECTRUM` | `chipnet.bch.ninja` | Electrum server |
