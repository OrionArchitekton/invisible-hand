# Invisible Hand: architecture contract (SwarmHack 2026-07-24)

An agent economy where natural selection is enforced by real money. A population of
seller-agent variants sells structured extraction over live web content behind x402
paywalls (Base Sepolia USDC). Profit is the fitness function. Insolvent variants are
delisted (their endpoint literally 410s). Survivors breed; children inherit; lineage,
estates, and failure clusters persist in Actian VectorAI. Guild policy gates every
mutation. Gemini verifies output and operates mutation. BAND is the coordination mesh
(discovery, @mention buy orders, replayable audit). Pioneer serves the inference being
sold and its cost side (model-route gene, `Pioneer/Auto` savings story).

HONESTY BARS (non-negotiable, judged): self-play demand is DISCLOSED (buyers are
adversarial verifiers, not praise bots); testnet USDC is called testnet; nothing is
narrated that code does not do; a stubbed integration is labeled "local mode", never
faked as live.

## Runtime layout (plain ESM JS, node >= 20, minimal deps: express, x402-express,
x402-fetch, viem; NO TypeScript, NO build step; data plane = JSON-lines files in data/)

```
src/market/registry.js    market core: variant registry; per-variant express route
                          /v/:id/extract behind x402 middleware (price from genome);
                          delist(id) -> route returns 410 GONE + reason
src/market/seller.js      handler: {url|text} -> Pioneer chat/GLiNER extraction using
                          genome.model -> {claims[], model, cost_est_usd}
src/market/wallets.js     viem local accounts per variant + buyer treasury;
                          balances via Base Sepolia RPC; addresses in data/wallets.json
                          (private keys ONLY in data/keys.json, gitignored)
src/market/ledger.js      JSONL ledger data/ledger.jsonl: credit/debit(id, usd, reason,
                          tx_hash?); pnl(id); rolling profit-per-100-requests
src/buyers/fleet.js       buyer loop: pull live tasks (HN/RSS articles), pick seller
                          (BAND discovery order + quality-weighted), pay via x402-fetch,
                          verify, log receipt, re-purchase policy by verified quality
src/buyers/verify.js      schema check + Gemini URL-context cross-check ->
                          {verified, reasons[]}; failures -> data/failures.jsonl
src/evolution/genome.js   {id, parent_ids[], gen, price_usd, model, prompt_variant,
                          niche} + mutate/crossover via Gemini (JSON out, temperature 0.9)
src/evolution/engine.js   cadence loop: compute fitness (ledger pnl); bankruptcy when
                          bankroll exhausted -> delist + estate to Actian; breed top-2 ->
                          child (Guild-gated) -> fresh wallet + stake -> register + announce
src/memory/actian.js      gRPC localhost:6574; collections: genomes, estates, failures
                          (embeddings: all-MiniLM via @xenova/transformers or hash-embed
                          fallback; keep it working > fancy)
src/mesh/band.js          BAND room client (docs.band.ai): announce(variant),
                          buyOrder(task), emit(event). NO key -> local mode: append to
                          data/mesh.jsonl and log; NEVER pretend to be live
src/governance/guild.js   mutation gate: policy checks (price floor/ceiling, spend cap,
                          niche allowlist, max mutation delta) -> {approved, trace};
                          Guild API when key present, else local policy mode (real rules)
src/dashboard/server.js   :3311 live dashboard, server-rendered + 5s poll: generation
                          counter, per-variant P&L sparklines, population table with
                          explorer links (sepolia.basescan.org), lineage tree, event feed
scripts/spike-e2e.js      PROOF: 1 seller + 1 paid buy end-to-end on Base Sepolia via
                          facilitator https://x402.org/facilitator; prints tx hash
scripts/fund-treasury.js  keygen + print treasury address + faucet instructions
scripts/run-market.js     entrypoint: boot registry + N seed variants + buyer fleet +
                          evolution cadence + dashboard; env-tunable cadences
```

## Interfaces (code to THESE; integrator wires seams)

- genome: see evolution/genome.js above; seed population = 6 variants, gen 0, staked
  BANKROLL_USD each (default 0.25), price_usd in [0.001, 0.02].
- registry.register(variant) mounts route; registry.delist(id, reason); registry.list().
- ledger.debit/credit return the entry; every x402 settlement logs tx_hash.
- seller cost side: estimate per-call inference cost from Pioneer pricing table
  (data/pioneer-prices.json, checked in) unless usage headers available.
- verify(): schema = {claims:[{text, source_url, confidence}]}; Gemini cross-check
  fetches source via URL-context and rejects unsupported claims.
- engine cadence: EVAL_EVERY_MS (default 60s), BREED_CHECK_EVERY_MS (default 120s).
- band/guild: feature-flag envs BAND_API_KEY, GUILD_API_KEY; absent -> local mode.
- Payment consts: network eip155:84532; facilitator https://x402.org/facilitator;
  USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e (Base Sepolia).

## Env (doppler-wrapped at runtime; never hardcode)
GEMINI_API_KEY (exists) · PIONEER_API_KEY · BAND_API_KEY · GUILD_API_KEY (pending Dan)
TREASURY_PRIVATE_KEY (generated locally, data/keys.json)

## Demo arc (3:00, two panes: dashboard + basescan explorer; BAND room third if live)
0:00 market at generation N, running for hours. 0:30 judge picks a live article; buy
order fires; 402 challenge + settlement on-chain. 1:15 weak seller returns junk;
verification rejects; re-purchases stop; balance crosses cost line. 1:45 bankruptcy:
delist fires, curl 410 on stage; estate written; parents breed; child lands first paid
request. 2:30 close: profit-per-100 curve up across generations, verified accuracy up,
unit cost down, one governance block trace, explorer left open.

## VERIFIED integration facts (live-probed 07-24 ~11:30; code against THESE)

- Runtime env chain: `doppler run -p swarm-hack -c prd -- doppler run -p claude-code-use -c prd -- node ...`
  (swarm-hack/prd holds PIONEER_API_KEY + BAND_API_KEY; claude-code-use/prd holds GEMINI_API_KEY).
- Pioneer: base `https://api.pioneer.ai/v1`, OpenAI-compatible, `Authorization: Bearer $PIONEER_API_KEY`.
  165 models live; router id is `pioneer/auto` (also `anthropic/pioneer-auto`); frontier ids like
  `claude-sonnet-4-5`, plus open models. /models returns the list (verified HTTP 200).
- BAND (VERIFIED end-to-end): human key = $BAND_API_KEY. Mint agents:
  `POST https://app.band.ai/api/v1/me/agents/register` body `{"agent":{"name","description"}}`,
  X-API-Key header -> 201 with `data.credentials.api_key` (shown ONCE). Agent API base
  `https://app.band.ai/api/v1/agent/*` with the AGENT key in X-API-Key (verified 200 on /agent/chats).
  Probe agent `ih-probe` credentials already saved at data/band-agents.json (gitignored, mode 600) -
  reuse it or mint per-role agents at boot. Human chat endpoints (/me/chats) are Enterprise-gated:
  do NOT use them. Websocket: wss://app.band.ai/api/v1/socket/websocket.
- Guild: CLI v0.17.0 on PATH but UNAUTHENTICATED on this box (expects ~/.guild/config.json; auth
  pending from operator laptop). guild.js stays in local policy mode until GUILD_CONFIG_JSON lands;
  then `guild --mode json api <METHOD> <path>` becomes available for real registration of decisions.
- Treasury: data/keys.json holds {treasury:{privateKey,address}}; address
  0xd2bA23040cCB33Ed6eB9Bc53ec148BCF064333a8; faucet funding pending (x402 402-challenge works unfunded).
