# Run evidence (frozen at the v1.0-swarmhack release)

Captured 2026-07-25T02:56:48Z, end of the SwarmHack event day. Raw counts, no smoothing.
All USDC is Base Sepolia TESTNET; demand is disclosed adversarial self-play.

- On-chain settlements with tx hashes in the ledger: 731
- First and latest settlement tx: 0x4e1b80cfab76f9e30bf7695854bbe4c1183edc516b6d1b900fdef80234545df1 and 0xd60cc4059f9255009a1cb017a4d264413b92116c7c4dca95859d2f1bc7471de5
- Verification receipts: 392/798 verified successes/attempts; 802 failure records
- Pioneer inference debits: 698 (plus 83 labeled Gemini fallbacks)
- BAND: 1814 events delivered to the two-agent room; 1830 mesh events recorded
- Population: generation 1, 8 alive, 1 delisted
- Governed birth during the recorded demo: child v1-9e655c through the six-rule gate
- Actian mode: live | Guild: honest local policy mode

## Evolution by generation (raw; accuracy = verified successes/attempts)

| gen | alive/total | sales n | mean profit per 100 | verified acc (ok/attempts) |
|---|---|---|---|---|
| 0 | 5/6 | 451 | $0.098 | 51% (257/501) |
| 1 | 3/3 | 253 | $0.681 | 43% (117/271) |

Stated plainly: generation 1 improved unit economics several-fold while
verified accuracy declined. That is reward hacking, surfaced by the system
itself and reported receipt-true; accuracy-aware selection is the next gate.

## ERRATA (added 2026-07-24, after the frozen release)

The numbers above are unchanged and stay frozen. What changed is their INTERPRETATION.
Three defects were found by re-reading the run's own artifacts, and each weakens the
headline the section above states. Recording them here rather than re-running the
release, because the correction is the point of the project.

**1. The generation comparison is survivorship, not evolution.** `data/population.json`
shows generation 0 was six agents all `bred_by: "seed"` with identical `created_at`,
hand-seeded across a 20x price spread ($0.001 to $0.02). The single insolvency was the
CHEAPEST seed, so its bankruptcy was close to determined by a price we chose, not by
anything it did. Generation 1 was three agents that all descend from the top-priced
seeds, all run one model, and two of which (`v1-6d39f3`, `v1-e2188d`) share both
parents, the same price and the same model. So "gen 1 improved unit economics
several-fold" substantially measures which seeded price band survived. It is not a
clean measurement of what the optimizer learned.

**2. The accuracy decline is confounded and undersized.** Generation 0 spanned six
different models; generation 1 ran one 8B model. A smaller model being cheaper and less
accurate is the ordinary cost/quality frontier. On top of that, the two generations were
graded on different articles in different time windows, because the buyer fleet pulls
and shuffles a live source list every cycle. The two-proportion test on 257/501 versus
117/271 is nominally significant, but the 271 generation 1 attempts are repeated
sampling of a single lineage, and a modest clustering design effect removes that
significance. The decline shows the failure mode EXISTS. It does not size it.

**3. Four of six `MODEL_POOL` ids were silently mispriced.** `priceFor()` in
`src/market/seller.js` falls back to the `default` row ($1.00/$4.00 per 1M tokens) when
a model id has no explicit entry. Through this run, `openai/gpt-oss-20b`,
`openai/gpt-oss-120b`, `meta-llama/Llama-3.1-8B-Instruct` and `zai-org/GLM-5.2` all had
no matching row, so their inference cost, and therefore their profit, used the fallback
rather than a real rate. `zai-org/GLM-5.2` is the sharpest case: a `zhipuai/glm-5.2` row
existed but never matched, because `MODEL_POOL` uses a different org prefix. All four now
have explicit sourced rows, and `seller.js` carries a self-test asserting that no
`MODEL_POOL` id can resolve to `default` again.

**What the run still supports.** The claim that survives all of the above is structural
rather than statistical, and it is the one worth keeping: selection could only ever see
profit. Fitness is cumulative net P&L (`src/evolution/engine.js`), there is no accuracy
term in the objective and no accuracy floor gating promotion or breeding. Verified
failures move only an in-memory buyer demand weight (`src/buyers/fleet.js`), which
reaches fitness weakly and indirectly by changing how often a seller is picked, and
never writes to the ledger. Calling the observed result "reward hacking" overstates it:
an objective function that was never given a quality term did exactly what it was told.
Accuracy-aware selection remains the next gate.

## Verify

- Any tx above: https://sepolia.basescan.org/tx/<hash> or https://base-sepolia.blockscout.com/tx/<hash>
- Treasury: https://sepolia.basescan.org/address/0xd2bA23040cCB33Ed6eB9Bc53ec148BCF064333a8
- Public Senso-generated artifact: https://cited.md/article/what-is-the-invisible-hand-agent-economy-and-how-does-real-on-chain
