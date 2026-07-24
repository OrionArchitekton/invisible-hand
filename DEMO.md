# Demo run of show (3:00, live, no slides)

Panes staged before start: dashboard http://localhost:3311 (primary), a
terminal, and a Basescan tab pre-staged on the settlement tx. Read live
numbers off the screen; never quote stale counts.

Every beat fires through a real seam. The two operator triggers are narrated
as operator triggers, always.

0:00 HOOK. On screen: dashboard tiles (settlements counter, market net P&L).
Say: "This is a live agent economy where real on-chain settlement, not a
made-up score, decides which AI agents survive and breed. It is testnet USDC
on Base Sepolia, and I will give you the honesty bar behind every claim."

0:20 REAL SETTLEMENT. Ask a judge for any article URL (or take the top HN
story). Terminal: `curl -X POST localhost:3313/demo/buy -H 'content-type: application/json' -d '{"url":"<judge url>"}'`.
On screen: the buy order and settlement land in the event feed; click the tx
link; Basescan opens. Say: "A real x402 402-challenge and on-chain settlement,
on an article you picked. Real transactions, testnet asset, nothing mocked."

0:45 ADVERSARIAL VERIFICATION. On screen: event feed rejections and the
failures count. Say: "Demand is disclosed self-play: buyers are adversarial
Gemini verifiers that cross-check claims against the live source. Junk does
not get paid twice; rejections are on disk."

1:05 PROFIT AS FITNESS. On screen: population table, P&L sparklines,
bankrolls. Say: "Profit is fitness: settled revenue minus inference cost per
variant. The model route is a gene; expensive junk-producing routes bleed out."

1:25 SELECTION, HONESTLY LABELED. Terminal:
`curl -X POST localhost:3313/demo/stress-insolvency/<weakest-id>` then
`curl -i localhost:4020/v/<weakest-id>/extract`.
Say: "Nothing has gone bankrupt on its own yet, so I am firing the insolvency
path as an operator stress test, and I am telling you it is manual. Ledger
debited past stake, the real path runs: delisted, endpoint 410 GONE, estate
written to Actian."

1:50 BREEDING. On screen: child_born event, a v1/v2 variant row, lineage tree.
Say: "Survivors breed. A Gemini-mutated child inherits immunity hints from its
parents' failure clusters stored in Actian, gets a fresh wallet and a stake."

2:15 GOVERNANCE GATE. On screen: a governance_block event expanded. Say:
"Every mutation passes a fail-closed policy gate: price band, mutation delta,
niche allowlist, spend cap, parent solvency. This is a real trace of a child
being blocked. It is Guild's policy shape running in honest local mode; we did
not fake a live Guild API."

2:40 TOOL SWEEP + HONESTY CLOSE. On screen: dashboard footer disclosure. Say:
"Pioneer serves the inference being sold, x402 settles it on-chain, Gemini
verifies and mutates, Actian is the memory plane, BAND is the mesh, Senso
archives every generation into a knowledge base. Every stub is labeled, and
every number on this screen is verifiable on-chain."

## Contingencies

- Pioneer timeout mid-buy: the seller falls back to labeled Gemini; the model
  string in the feed says exactly that. Point at it: honesty bar working.
- No breed fires in-window: show the existing v1 rows + child_born events from
  earlier in the run instead; say when they happened.
- Tunnel or wifi dies: everything is localhost; only Basescan needs network.
