# Run evidence (frozen snapshot for async judging)

Captured 2026-07-24T21:25:46Z from the live market. Raw counts, no smoothing; the live
dashboard is authoritative whenever the market is up. All USDC is Base
Sepolia TESTNET; demand is disclosed adversarial self-play.

- On-chain settlements with tx hashes in the ledger: 251
- First and latest settlement tx: 0x4e1b80cfab76f9e30bf7695854bbe4c1183edc516b6d1b900fdef80234545df1 and 0x21413d458e8da390b52e4d2798c7b16fd6164674076b759390fa5b40674c2654
- Verification receipts: 154/280 verified successes/attempts; 196 failure records
- Pioneer inference debits: 207 (plus 71 labeled Gemini fallbacks)
- BAND: 658 events delivered to the two-agent room; 674 mesh events recorded overall
- Population: generation 1, 8 alive, 1 delisted
- Governed evolution during the run: child v1-9e655c bred through the six-rule gate after the spend-cap accounting fix (live-capital basis, trace names it)
- Actian mode: live | Guild: honest local policy mode

## Evolution by generation (raw; accuracy = verified successes/attempts)

| gen | alive/total | sales n | mean profit per 100 | verified acc (ok/attempts) |
|---|---|---|---|---|
| 0 | 5/6 | 189 | $0.087 | 56% (120/215) |
| 1 | 3/3 | 35 | $0.619 | 41% (16/39) |

Stated plainly: generation 1 improved unit economics while verified
accuracy declined. That is reward hacking, surfaced by the system itself,
and it is the next selective pressure (evaluation windows and verified
sample floors are now part of displacement rules).

## Verify live yourself

- Any settlement tx above on https://sepolia.basescan.org/tx/<hash> or https://base-sepolia.blockscout.com/tx/<hash>
- Treasury: https://sepolia.basescan.org/address/0xd2bA23040cCB33Ed6eB9Bc53ec148BCF064333a8
  (payer via EIP-3009 facilitator settlement; check tx logs, not EOA nonce)
- Public Senso-generated artifact: https://cited.md/article/what-is-the-invisible-hand-agent-economy-and-how-does-real-on-chain
