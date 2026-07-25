// scripts/run-market.js
// Entrypoint (ARCHITECTURE.md): boot the market registry + 6 seed variants +
// buyer fleet + evolution cadence + dashboard. Env-tunable cadences; graceful
// shutdown on SIGINT/SIGTERM.
//
// Ports:
//   MARKET_PORT    (default 4020)  paid seller routes /v/:id/extract + free /market
//   STATE_PORT     (default 3313)  GET /state for the dashboard (engine truth)
//   DASHBOARD_PORT (default 3311)  server-rendered dashboard
//
// Cadence env (consumed by the modules themselves): EVAL_EVERY_MS (60s),
// BREED_CHECK_EVERY_MS (120s), BUY_EVERY_MS (15s), BANKROLL_USD (0.25),
// MAX_POPULATION (12), MIN_PARENT_REQUESTS (3).
//
// Seam adapters live HERE (the builders' modules stay untouched):
//   - ledger returns {net}/{per100} objects; engine wants numbers.
//   - wallets exposes createVariantWallet; engine looks for createWallet.
//   - fleet wants variant.endpoint; registry publicView carries route only.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '../src/market/registry.js';
import * as ledgerMod from '../src/market/ledger.js';
import {
  ensureTreasury,
  getTreasuryAccount,
  createVariantWallet,
  getBalances,
} from '../src/market/wallets.js';
import { seedPopulation } from '../src/evolution/genome.js';
import { createEngine } from '../src/evolution/engine.js';
import { getActian } from '../src/memory/actian.js';
import * as band from '../src/mesh/band.js';
import * as guild from '../src/governance/guild.js';
import { startFleet, runCycle } from '../src/buyers/fleet.js';
import { start as startDashboard } from '../src/dashboard/server.js';
import { publishMarketReport, isSensoLive } from '../src/publish/senso.js';

const MARKET_PORT = Number(process.env.MARKET_PORT || 4020);
const STATE_PORT = Number(process.env.STATE_PORT || 3313);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3311);
const MARKET_URL = process.env.MARKET_URL || `http://localhost:${MARKET_PORT}`;
// fleet.js falls back to MARKET_URL when a variant has no endpoint field.
process.env.MARKET_URL = MARKET_URL;

// Engine <-> ledger adapter: numbers out, sale-credit request counting.
const ledgerAdapter = {
  pnl: (id) => ledgerMod.pnl(id).net,
  profitPer100: (id) => ledgerMod.profitPer100(id).per100,
  requestCount: (id) =>
    ledgerMod.entries(id).filter(
      (e) => e.type === 'credit' && typeof e.reason === 'string' && e.reason.startsWith('sale'),
    ).length,
};

async function main() {
  console.log('[run-market] Invisible Hand market booting (TESTNET USDC, Base Sepolia)');

  // 1) Buyer treasury (created if absent; funding is a faucet step, not code).
  const treasury = ensureTreasury();
  try {
    const bal = await getBalances(treasury.address);
    console.log(`[run-market] treasury ${treasury.address} USDC=${bal.usdc} ETH=${bal.eth}`);
    if (Number(bal.usdc) === 0) {
      console.warn('[run-market] treasury has 0 USDC: paid buys will 402-challenge but not settle. Fund via https://faucet.circle.com (Base Sepolia).');
    }
  } catch (err) {
    console.warn(`[run-market] balance probe failed (${err.message}); continuing`);
  }

  // 2) Market registry (paid routes + free /market discovery).
  const registry = createRegistry();
  await new Promise((resolve) => registry.listen(MARKET_PORT, resolve));
  console.log(`[run-market] market on ${MARKET_URL} (paid /v/:id/extract, free /market)`);

  // 3) Actian memory plane (honest local mode if the container is down).
  const actian = getActian();
  await actian.ensureReady();
  console.log('[run-market] actian:', JSON.stringify(actian.status()));

  // 4) Evolution engine with adapted seams.
  const engine = createEngine({
    registry,
    ledger: ledgerAdapter,
    wallets: { createWallet: (id) => createVariantWallet(id) },
    band,
    guild,
    actian,
  });

  // 5) Population: resume from the last snapshot when one exists (restarts must
  //    not reset evolution to gen 0), else seed 6 fresh gen-0 variants.
  const POP_SNAPSHOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/population.json');
  let priorPop = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(POP_SNAPSHOT, 'utf8'));
    if (Array.isArray(parsed) && parsed.length) priorPop = parsed;
  } catch { /* no snapshot yet -> fresh seed */ }
  let seeded;
  if (priorPop) {
    seeded = await engine.restore(priorPop);
    console.log(`[run-market] RESUMED population from snapshot: gen ${seeded.generation}, ${seeded.alive} alive, ${seeded.dead} delisted`);
  } else {
    seeded = await engine.seed(seedPopulation());
    console.log(`[run-market] seeded ${seeded.alive} variants at generation ${seeded.generation}`);
  }

  // Persist the population atomically (tmp+rename) every 15s and on shutdown.
  const writeSnapshot = () => {
    try {
      const tmp = `${POP_SNAPSHOT}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(engine.snapshot(), null, 2));
      fs.renameSync(tmp, POP_SNAPSHOT);
    } catch (err) {
      console.warn(`[run-market] population snapshot write failed: ${err.message}`);
    }
  };
  const snapTimer = setInterval(writeSnapshot, 15_000);
  snapTimer.unref?.();

  // 6) /state endpoint the dashboard polls (engine truth wins over file estimates).
  const stateApp = express();
  stateApp.get('/state', (_req, res) => {
    const s = engine.state();
    res.json({
      ts: new Date().toISOString(),
      generation: s.generation,
      alive: s.alive,
      dead: s.dead,
      treasury: treasury.address,
      market_url: MARKET_URL,
      testnet: true,
      actian: actian.status(),
      mesh_live: band.isLive(),
      guild_live: guild.isGuildLive(),
      variants: s.population.map((r) => ({
        ...r,
        status: r.alive ? 'live' : 'delisted',
        reason: r.delist_reason || '',
      })),
    });
  });
  stateApp.get('/healthz', (_req, res) => res.json({ ok: true }));
  const stateServer = await new Promise((resolve) => {
    const srv = stateApp.listen(STATE_PORT, () => resolve(srv));
  });
  console.log(`[run-market] state endpoint on http://127.0.0.1:${STATE_PORT}/state`);

  // 7) Dashboard.
  const dash = startDashboard({
    port: DASHBOARD_PORT,
    stateUrl: `http://127.0.0.1:${STATE_PORT}/state`,
  });

  // 8) Adversarial buyer fleet (disclosed self-play demand). Mesh forwarding:
  // buy orders and settlements go to BAND (or honest local mesh.jsonl).
  const fleetRegistry = {
    list: () => registry.list().map((v) => ({ ...v, endpoint: `${MARKET_URL}${v.route}` })),
  };
  const fleet = startFleet({
    registry: fleetRegistry,
    account: getTreasuryAccount(),
    onEvent: (event) => {
      try {
        if (event.type === 'buy_order') {
          band.buyOrder({
            url: event.task_url,
            seller_id: event.variant_id,
            price_usd: event.price,
          }).catch((e) => console.warn(`[run-market] mesh buyOrder failed: ${e.message}`));
        } else if (event.type === 'receipt' && event.tx_hash) {
          band.emit({
            type: 'settlement',
            variant_id: event.variant_id,
            price_usd: event.price,
            tx_hash: event.tx_hash,
            task_url: event.task_url,
            verified: event.verified,
          }).catch((e) => console.warn(`[run-market] mesh settlement emit failed: ${e.message}`));
        }
      } catch (err) {
        console.warn(`[run-market] onEvent forwarding failed: ${err.message}`);
      }
    },
  });

  // 8b) Demo-control seams (LOCAL state app only, never tunneled). These are
  //     honest operator triggers wired to the REAL market paths, so the 3-min
  //     demo's beats fire on cue instead of riding the stochastic cadence:
  //     - POST /demo/buy {url?}: run one real paid buy cycle now; a provided
  //       url becomes the task (the "judge picks an article" beat, for real).
  //     - POST /demo/stress-insolvency/:id: operator-triggered stress test;
  //       debits the variant's ledger past its stake (reason says exactly
  //       that), then runs the real evalTick -> insolvency -> delist(410) ->
  //       estate path. Never narrated as a spontaneous bankruptcy.
  stateApp.use(express.json());
  stateApp.post('/demo/buy', async (req, res) => {
    try {
      const url = req.body && typeof req.body.url === 'string' && req.body.url.startsWith('http')
        ? req.body.url : null;
      const receipt = await runCycle({
        registry: fleetRegistry,
        account: getTreasuryAccount(),
        tracker: fleet.tracker,
        // Same mesh forwarding as the autonomous fleet, so demo buys show up
        // as buy_order/settlement lines in the feed and the BAND room.
        onEvent: (event) => {
          try {
            if (event.type === 'buy_order') {
              band.buyOrder({ url: event.task_url, seller_id: event.variant_id, price_usd: event.price })
                .catch((e) => console.warn(`[run-market] demo mesh buyOrder failed: ${e.message}`));
            } else if (event.type === 'receipt' && event.tx_hash) {
              band.emit({ type: 'settlement', variant_id: event.variant_id, price_usd: event.price, tx_hash: event.tx_hash, task_url: event.task_url, verified: event.verified })
                .catch((e) => console.warn(`[run-market] demo mesh settlement failed: ${e.message}`));
            }
          } catch (err) {
            console.warn(`[run-market] demo onEvent failed: ${err.message}`);
          }
        },
        ...(url ? { task: { url, title: 'judge-picked article' } } : {}),
      });
      res.json({ ok: !receipt?.skipped, receipt });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300) });
    }
  });
  stateApp.post('/demo/stress-insolvency/:id', async (req, res) => {
    try {
      const id = String(req.params.id);
      const row = engine.state().population.find((r) => r.id === id);
      if (!row) { res.status(404).json({ ok: false, error: `no variant ${id}` }); return; }
      if (!row.alive) { res.status(409).json({ ok: false, error: `${id} already delisted` }); return; }
      const debit = Math.max(0, row.bankroll) + 0.001;
      ledgerMod.debit(id, debit, 'demo_stress_test:operator_triggered_insolvency');
      const after = await engine.evalTick();
      const outRow = after.population.find((r) => r.id === id);
      res.json({
        ok: outRow ? !outRow.alive : false,
        variant: outRow,
        note: 'operator-triggered stress test: ledger debited past stake, then the real insolvency -> delist(410) -> estate path ran',
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300) });
    }
  });
  console.log(`[run-market] demo seams armed on :${STATE_PORT} (POST /demo/buy, POST /demo/stress-insolvency/:id)`);

  // 9) Senso publish cadence: per-generation market report into the org KB
  //    (live when SENSO_API_KEY present; labeled local mode otherwise).
  const SENSO_EVERY_MS = Number(process.env.SENSO_PUBLISH_EVERY_MS || 600_000);
  let lastPublishedGen = -1;
  const sensoTick = async (force = false) => {
    try {
      const s = engine.state();
      if (!force && s.generation === lastPublishedGen) return;
      await publishMarketReport(s);
      lastPublishedGen = s.generation;
    } catch (err) {
      console.warn(`[run-market] senso publish failed: ${err.message}`);
    }
  };
  console.log(`[run-market] senso publisher: ${isSensoLive() ? 'LIVE' : 'local mode'}, every ${SENSO_EVERY_MS}ms or on generation change`);
  sensoTick(true);
  const sensoTimer = setInterval(() => sensoTick(false), SENSO_EVERY_MS);
  sensoTimer.unref?.();

  // 10) Evolution cadence.
  engine.start();
  console.log('[run-market] market is LIVE.');
  console.log(`[run-market]   dashboard  http://localhost:${DASHBOARD_PORT}`);
  console.log(`[run-market]   market     ${MARKET_URL}/market`);
  console.log(`[run-market]   state      http://127.0.0.1:${STATE_PORT}/state`);

  // 10) Graceful shutdown.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[run-market] ${signal}: shutting down`);
    try { clearInterval(snapTimer); writeSnapshot(); } catch { /* best effort */ }
    try { clearInterval(sensoTimer); } catch { /* best effort */ }
    try { fleet.stop(); } catch { /* best effort */ }
    try { engine.stop(); } catch { /* best effort */ }
    try { registry.close(); } catch { /* best effort */ }
    try { stateServer.close(); } catch { /* best effort */ }
    try { dash.server.close(); } catch { /* best effort */ }
    setTimeout(() => process.exit(0), 750).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[run-market] boot failed: ${err.stack || err}`);
  process.exit(1);
});
