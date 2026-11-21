# On-chain evidence

All transactions are Chipnet (test coins only). Explorer:
`https://chipnet.imaginary.cash/tx/<txid>`.

Run date: 2026-11-21, Chipnet heights 341305–341308.

| # | Step | Txid | Status |
|---|---|---|---|
| 1 | Create swap A (redeem path) | `eee5a7dfdfe9bd36a5a614c541ba8ab64095d6f3fd6268071ad3170bd53d6865` | confirmed; output spent by the redeem |
| 2 | Redeem swap A with the preimage | `1bd2570002410876f1aed5e737eaecf5ea71b2f0ebb1ba002534c6d7519ee862` | confirmed in block 341307 |
| 3 | Create swap B (refund path) | `b44d1ad65df48c2e8a791825515bad06d9b5dbe065d44b9015a1d54920aa31eb` | confirmed in block 341307 |
| 4 | Refund swap B with the sender key | `8646d3cfc58cae9bdca7be2890080b7320bbe58f9b22b6ccea43f96b17b97a4d` | confirmed in block 341308 |
| 5 | Create swap C (early-refund attempt) | `8cb96d60c2c0f682eacf5954326ee7da1eee49063f55f09602fb18a594d0bcf3` | confirmed in block 341308; still unspent |
| 6 | Early refund of swap C | rejected | local VM and node rejection, see below |

## Addresses and committed values

| Swap | Address | `refundTime` |
|---|---|---|
| A (redeem) | `bchtest:pv9e2lyp4dnnmspql730p9rntgh6hc8k55njzzz0vhwenecav53sw0a6zw8l4` | 1795361677 (2026-11-22 15:34 UTC) |
| B (refund) | `bchtest:pwz2u3cdm5z0kme54p2yw0vmy32t4q2sj7s22mpw2n4vl2jyzlhvcrfjfja84` | 1795188877 (2026-11-20 15:34 UTC) |
| C (early rejection) | `bchtest:pvgf79ftvpqng68s82lt85mg36gfuygr0e5a8ytctu45zj3vt4sdz7kse2pwt` | 1795278877 (2026-11-21 16:34 UTC) |

Preimage: `5353…53` (32 bytes of `0x53`), hashlock
`c4ed6cc9444165adc1760e90422af0c023ae0b01e1c5f52a6a17c3d719190469`.

The redeem transaction publishes the preimage in its input, which is the HTLC's
intended reveal.

## Rejections

### Early refund (local VM)

The transaction is built with `nLockTime = 1795278876`, one second before the
committed `refundTime = 1795278877`:

```
Program called an OP_CHECKLOCKTIMEVERIFY operation that requires a locktime
greater than the transaction's locktime. Transaction locktime: 1795278876;
required locktime: 1795278877.
```

### Early refund (node)

The correctly built transaction at `nLockTime = 1795278877` is refused until the
wall clock reaches that second:

```
the transaction was rejected by network rules.

bad-txns-nonfinal, non-final transaction (code 64)
```

## Invitations

| Invitation | File | Resolved address |
|---|---|---|
| Create | `artifacts/createSwap-invitation.json` | `bchtest:pv9e2lyp4dnnmspql730p9rntgh6hc8k55njzzz0vhwenecav53sw0a6zw8l4` |
| Redeem | `artifacts/redeem-invitation.json` | same covenant |
| Refund | `artifacts/refund-invitation.json` | same covenant |

The create invitation's resolved `initialSwapOutput` locking bytecode is
`aa200b957c81ab673dc020ffa2f094735a2fabe0f6a52721084f65dd99e71d65230787`,
which is exactly the locking script of output 0 in transaction
`eee5a7df…6865`. `scripts/lib/tx.ts` compiles the same template independently
and produces the same address, so the invitation and the reference builder agree
byte for byte.
