# Invisible Hand

An agent economy where real on-chain settlement, not a simulated score, selects
which AI seller-agents survive and breed. All settlement is Base Sepolia TESTNET
USDC: real transactions, valueless asset. Built solo in one day, live at SwarmHack SF (tokens&,
2026-07-24).

## Judge path (60 seconds, no keys)

1. `npm install && npm test` runs 13 module self-test suites; all pass, no
   keys needed.
2. Proof of real settlement: [tx 0x4e1b80cf...45df1](https://sepolia.basescan.org/tx/0x4e1b80cfab76f9e30bf7695854bbe4c1183edc516b6d1b900fdef80234545df1)
   on Base Sepolia (one of 100+ in the live run's ledger).
3. Public artifact generated FROM the market's own reports by Senso and
   published to the challenge's named surface:
   [cited.md article](https://cited.md/article/what-is-the-invisible-hand-agent-economy-and-how-does-real-on-chain).
4. Frozen run evidence for async judging: [docs/run-evidence.md](docs/run-evidence.md).
   Read its ERRATA section too: it retracts the original headline reading of
   the generation-over-generation numbers, and that correction is the point.
5. Full 3-minute run of show: [DEMO.md](DEMO.md). The event-day tunnel is gone
   and the market is not running, so there is no live dashboard to visit; the
   durable page is
   [danmercede.com/works/invisible-hand](https://www.danmercede.com/works/invisible-hand/),
   and `node scripts/run-market.js` boots the dashboard locally on :3311.

Replay QA note: a Replay QA round on the dashboard found two medium bugs
(raw JSON in the event feed; the 5s DOM swap swallowing tx-link clicks);
both fixed with regression tests in commit 4e68d75.

Sponsor prize lanes, primary first: BAND (live two-agent @mention exchange),
Pioneer (the inference being sold), Replay (QA completed, bugs fixed), Senso
(KB to public cited.md loop), Actian (memory plane), x402/CDP (settlement
rail), Guild (honest local policy mode).

## The honesty bar, first

This project treats honesty as a feature under test:

- Every USDC amount is Base Sepolia testnet and is labeled that way on every
  judge-facing surface (dashboard, discovery API, state API, this README).
- Demand is disclosed self-play: the buyers are adversarial verifier-agents
  (schema check + Gemini cross-check against the live source), not praise bots.
  A verified failure sharply reduces a seller's repurchase probability
  (epsilon-greedy demand with hard decay on failure).
- Every integration that runs without a live key is labeled "local mode" in its
  events and logs, and is never presented as live. Guild governance runs as an
  honest local policy engine with real rule traces; we do not fake a Guild API.
- Demo controls that trigger market events on cue exist and are narrated as
  operator-triggered. Nothing is presented as spontaneous that is not.

## Verify it yourself

- Real on-chain x402 settlement:
  [0x4e1b80cfab76f9e30bf7695854bbe4c1183edc516b6d1b900fdef80234545df1](https://sepolia.basescan.org/tx/0x4e1b80cfab76f9e30bf7695854bbe4c1183edc516b6d1b900fdef80234545df1)
- Buyer treasury: [0xd2bA23040cCB33Ed6eB9Bc53ec148BCF064333a8](https://sepolia.basescan.org/address/0xd2bA23040cCB33Ed6eB9Bc53ec148BCF064333a8)
- The dashboard (:3311) links every settlement row to Basescan; at the time of
  writing the run had ~90 real on-chain settlements and a positive market net
  P&L, with dozens of verifier rejections on disk in `data/failures.jsonl`.
- `npm test` runs 13 module self-test suites (no keys required); all pass.

Live-call receipts for the non-chain integrations (so LIVE labels are as
checkable as the tx hashes; ids are org-scoped, not secrets):

- Senso full loop, KB to PUBLIC artifact: the market's own generation reports
  were ingested into the Senso KB, and Senso's content engine generated and
  published a public cited.md article from them (honesty bars propagated):
  https://cited.md/article/what-is-the-invisible-hand-agent-economy-and-how-does-real-on-chain
- Senso KB nodes (per-generation reports ingested via /org/kb/upload):
  content_id `6d94222f-8149-482e-bda1-9029e4a61771` at 19:12:10Z,
  `b9e25ce5-ef9e-499b-b2c8-303fe778ae9b` at 19:21:46Z,
  `91fde98c-5551-4ed5-9305-f8852a8a9043` at 19:40:08Z (2026-07-24).
- BAND: registered agents `ih-probe` and `ih-market` (per-agent keys minted
  via the documented register flow); mesh events stream as `[mesh:live]` and
  `/state` reports `mesh_live: true`.
- Actian VectorAI: `/state` reports mode `live` against REST :6573; counts
  shown there are process-local write counts, and `data/actian-local.jsonl`
  is the write-through mirror of everything sent to the server.

## How it works

A population of seller-agent variants sells structured claim extraction over
live Hacker News articles behind x402 paywalls. Each variant is a genome: id,
parents, generation, price, model route, prompt variant, niche.

- Profit is the fitness function: real settled revenue minus per-call inference
  cost, per variant, from an append-only ledger.
- An adversarial buyer fleet pays sellers with x402 (402 challenge, EIP-3009
  settlement via the public facilitator), verifies every response, and shifts
  future purchases toward verified quality.
- Fitness is cumulative net P&L (settled revenue minus inference cost, from
  the append-only ledger). Profit-per-100-requests is shown on the dashboard
  as a unit-economics view but is deliberately NOT the fitness function: it
  normalizes away volume, and a verified-bad seller that loses all demand
  must lose fitness, not idle as a solvent zombie.
- Insolvent variants (bankroll exhausted) are delisted: their endpoint
  literally returns HTTP 410 GONE, and their estate is written to memory.
- At the population cap, breeding does not stall: the lowest-fitness living
  variant is displaced by the incoming child. This is labeled a
  market-selected exit, never a bankruptcy; only true insolvency earns that
  word.
- Survivors breed. Children are mutated by Gemini, inherit immunity hints from
  their parents' failure clusters, and must pass a fail-closed governance gate
  (price band, mutation delta, niche allowlist, spend cap, parent solvency)
  before receiving a wallet and a stake.

The falsifiable thesis: a population selected by real settlement improves its
economics across generations. Evidence so far, raw and unsmoothed, on the
dashboard's Evolution panel: generation 1 variants average several times the
profit-per-100 of generation 0 in the live run. Stated with equal honesty:
generation 1's verified accuracy DECLINED while its economics improved, which
is reward hacking; early children optimized the declared fitness function, not
usefulness. That finding is itself the result: the market surfaced its own
fitness-design failure, and accuracy-aware selection pressure is the next
gate this system is built to apply. Self-play demand is disclosed; the
selection mechanism (pay, verify, decay, displace) does not depend on who the
buyers are, which is why it should generalize to exogenous demand.

## Sponsor tools

| Tool | Role | Mode |
|---|---|---|
| Pioneer | The inference being sold; model-route gene (pioneer/auto + 5 open models, live-verified) | LIVE |
| x402 + Coinbase CDP rails | 402 challenge + on-chain USDC settlement on Base Sepolia; every sale carries a tx hash | LIVE (testnet) |
| Gemini | Adversarial verifier (url_context cross-check) and the mutation operator for breeding | LIVE |
| Actian VectorAI | Memory plane: genomes, estates, failure clusters (REST :6573, deterministic hash-embed) | LIVE |
| BAND | Coordination mesh: announces, buy orders, settlements, governance blocks (per-agent keys) | LIVE |
| Senso | Per-generation market report published into the org knowledge base | LIVE |
| Guild | Mutation governance gate with full rule traces | local policy mode, labeled |

## Proven live vs capability

- Proven in this run: on-chain settlement, adversarial verification with real
  rejections, breeding into generation 1+, governance blocks with full traces,
  population survival across process restarts (snapshot restore).
- Capability, self-tested but not yet observed spontaneously in this run:
  insolvency culling. The delist-to-410 path is exercised via an
  operator-triggered stress test (`POST /demo/stress-insolvency/:id`) that
  debits a variant past its stake and runs the real insolvency path, and it is
  always narrated as operator-triggered.

## Run it

```bash
npm install
npm test                      # 13 module self-tests, no keys needed
node scripts/run-market.js    # boots market :4020, state :3313, dashboard :3311
```

Keys are optional and each enables a live path (absent keys degrade to labeled
local modes): `PIONEER_API_KEY`, `GEMINI_API_KEY`, `BAND_API_KEY`,
`SENSO_API_KEY`, `ACTIAN` via a local VectorAI container on :6573. The treasury
key lives in `data/keys.json` (generated by `scripts/fund-treasury.js`; fund it
at the Circle faucet for Base Sepolia).

Demo controls (local state port, operator-side): `POST /demo/buy {url?}` runs
one real paid buy cycle now (optionally on a chosen article URL);
`POST /demo/stress-insolvency/:id` runs the labeled stress test described
above. See [DEMO.md](DEMO.md) for the 3-minute run of show.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, interfaces, and the
verified integration facts the build was coded against.

## Known limitations

- Demand is endogenous (disclosed self-play); there are no external customers.
- Hash-embed clustering is lexical, not semantic.
- Guild runs local policy mode; the live Guild API leg was blocked on device
  auth at build time.
- Small sample sizes make per-generation trends noisy; the dashboard shows raw
  counts rather than smoothed curves.
