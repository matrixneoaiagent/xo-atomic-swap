# Personal feedback — writing template

The bounty requires the feedback to be **personally written**. AI-written
feedback is explicitly rejected and subjectively enforced. This file is a set of
prompts and raw material, not a finished submission. Write the final 500 words
yourself, in your own voice, and save it as `docs/FEEDBACK.md`.

Useful raw material is in [`FINDINGS.md`](FINDINGS.md). Pick the points you
actually hit while building and say what you expected, what happened, and what
you would change.

## Suggested structure (~500 words)

1. **What I built and my XO experience before this** (2–3 sentences).
2. **What worked well.** Which parts of the template model made the HTLC easier
   than the original CashScript + bespoke TypeScript builder? Consider:
   - roles and follow-up actions mapping naturally to sender/recipient and
     redeem/refund;
   - `bytes` variables for the hashlock and preimage;
   - a CashASM expression as the transaction locktime;
   - the invitation as an inspectable artifact.
3. **What was hard or confusing.** Be specific:
   - identifier collisions between a variable and a script with the same name;
   - the stack order for `OP_IF` + preimage + signature;
   - how to supply a known secret instead of a generated one;
   - anything you personally tripped over.
4. **Missing functionality / limitations.**
   - no way to build a P2PKH script from a key hash inside a covenant;
   - no token-aware output enforcement in the template layer (the original
     bridge's PUSD leg);
   - wallet/UTXO selection depends on the engine's SPV sync.
5. **Bugs and reproductions.**
   - Chipnet header sync stops at 332451 (FINDINGS item 1). Include the error and
     the height; say what you had to do instead.
   - Chipnet refuses `nLockTime` spends on unconfirmed inputs (FINDINGS item 2).
6. **Suggestions.**
   - a documented checkpoint/bootstrap path for wallets;
   - clearer compiler errors for identifier collisions;
   - a first-class "known secret" option for reproducible demos;
   - token helpers for covenant-enforced `OP_OUTPUTTOKENCATEGORY` /
     `OP_OUTPUTTOKENAMOUNT` checks.
7. **What you would build next** (one or two sentences).

## Checklist before saving

- [ ] It is in your own words, not copied from `FINDINGS.md`.
- [ ] It is about 500 words.
- [ ] It names at least two concrete things that worked and two that did not.
- [ ] Any bug claim includes a height, error string, or reproduction step.
- [ ] It does not claim a mainnet deployment or real funds.
- [ ] `docs/FEEDBACK.md` is committed and linked from the README.
