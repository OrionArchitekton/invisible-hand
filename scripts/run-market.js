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
import { startFleet } from '../src/buyers/fleet.js';
import { start as startDashboard } from '../src/dashboard/server.js';

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

  // 5) Seed population: 6 variants, gen 0 (wallet + register + announce each).
  const seeded = await engine.seed(seedPopulation());
  console.log(`[run-market] seeded ${seeded.alive} variants at generation ${seeded.generation}`);

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

  // 9) Evolution cadence.
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
