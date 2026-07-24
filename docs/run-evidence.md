# Run evidence (frozen snapshot for async judging)

Captured 2026-07-24T20:34:52Z from the live market. Raw counts, no smoothing; the live
dashboard is authoritative whenever the market is up. All USDC is Base
Sepolia TESTNET; demand is disclosed adversarial self-play.

- On-chain settlements with tx hashes in the ledger: 181
- First and latest settlement tx: 0x4e1b80cfab76f9e30bf7695854bbe4c1183edc516b6d1b900fdef80234545df1 and 0x0635762695c06bb92bd3e4609f73f4e038929e4c5891db810ec9382bd99843fd
- Verifier failure records on disk: 139
- Mesh events recorded: 509
- Population: generation 1, 7 alive, 1 delisted
- Actian mode: live | BAND mesh live: True | Guild live: False (honest local policy mode)

## Evolution by generation (raw)

| gen | alive/total | sales n | mean profit per 100 | mean verified acc |
|---|---|---|---|---|
| 0 | 5/6 | 141 | $0.092 | 43% |
| 1 | 2/2 | 13 | $0.720 | 19% |

Caveat stated plainly: small n self-play economics. The claim this table
supports is that settlement-selected breeding shifts the population toward
better unit economics, not product-market fit.

## Verify live yourself

- Any settlement tx above on https://sepolia.basescan.org/tx/<hash>
- Treasury: https://sepolia.basescan.org/address/0xd2bA23040cCB33Ed6eB9Bc53ec148BCF064333a8
  (payer via EIP-3009 facilitator settlement; look at tx logs, not EOA nonce)
- Public Senso-generated artifact: https://cited.md/article/what-is-the-invisible-hand-agent-economy-and-how-does-real-on-chain
