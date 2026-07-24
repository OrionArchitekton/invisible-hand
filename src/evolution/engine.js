// src/evolution/engine.js
// Evolution cadence loop. Fitness = ledger pnl (rolling profit per 100 requests
// when the ledger exposes it). Bankroll accounting: each variant is staked
// BANKROLL_USD (default 0.25); inference costs and payouts flow through the
// ledger, so bankroll = stake + pnl. Insolvency (bankroll <= 0) -> registry
// delist + estate written to Actian + band event. Breeding: top 2 solvent
// variants -> genome.breed (Gemini or honest local mode) with inherited
// immunity from the parents' Actian failure clusters -> guild.gateMutation ->
// on approval: fresh wallet, register, stake, announce.
//
// SEAMS (integrator wires these in run-market.js; every call is try/caught so
// one builder's module failing does not kill the loop):
//   registry.register(variant)            mount paid route
//   registry.delist(id, reason)           route -> 410 GONE
//   ledger.pnl(id) -> usd                 credits minus debits
//   ledger.profitPer100(id) -> usd        optional; preferred fitness
//   ledger.requestCount(id) -> n          optional; breeding eligibility
//   wallets.createWallet(id)|create(id)   fresh variant wallet -> {address}
//   band.announce(variant)                mesh announce (local mode ok)
//   band.emit(event)                      mesh event (local mode ok)
//   guild.gateMutation(child) -> {approved, trace}
//   actian: src/memory/actian.js client (getActian() used by default)

import { breed } from "./genome.js";
import { getActian } from "../memory/actian.js";

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function pickFn(obj, names) {
  if (!obj) return null;
  for (const n of names) if (typeof obj[n] === "function") return obj[n].bind(obj);
  return null;
}

async function safe(label, fn, ...args) {
  if (!fn) return undefined;
  try {
    return await fn(...args);
  } catch (err) {
    console.warn(`[engine] seam "${label}" failed: ${err.message}`);
    return undefined;
  }
}

export function createEngine(deps = {}, opts = {}) {
  const { registry, ledger, band, guild, wallets } = deps;
  const actian = deps.actian || getActian();

  const cfg = {
    evalEveryMs: num(opts.evalEveryMs ?? process.env.EVAL_EVERY_MS, 60_000),
    breedEveryMs: num(opts.breedEveryMs ?? process.env.BREED_CHECK_EVERY_MS, 120_000),
    bankrollUsd: num(opts.bankrollUsd ?? process.env.BANKROLL_USD, 0.25),
    maxPopulation: num(opts.maxPopulation ?? process.env.MAX_POPULATION, 12),
    minParentRequests: num(opts.minParentRequests ?? process.env.MIN_PARENT_REQUESTS, 3),
    forceLocalBreed: Boolean(opts.forceLocalBreed),
  };

  const fnPnl = pickFn(ledger, ["pnl"]);
  const fnPer100 = pickFn(ledger, ["profitPer100", "rollingProfitPer100", "pnlPer100"]);
  const fnReqs = pickFn(ledger, ["requestCount", "requests", "countRequests"]);
  const fnWallet = pickFn(wallets, ["createWallet", "create", "createFor", "newWallet"]);

  // population: id -> record
  const pop = new Map();
  let timers = [];
  let breeding = false;

  function emit(event) {
    return safe("band.emit", pickFn(band, ["emit"]), { ts: new Date().toISOString(), ...event });
  }

  async function addVariant(genome, { announce = true, isChild = false, restored = false } = {}) {
    const rec = {
      genome,
      stake_usd: cfg.bankrollUsd,
      alive: true,
      born_at: Date.now(),
      fitness: 0,
      pnl: 0,
      bankroll: cfg.bankrollUsd,
      requests: 0,
      delist_reason: null,
      wallet: null,
    };
    if (fnWallet) rec.wallet = await safe("wallets.create", fnWallet, genome.id);
    else if (isChild) console.warn("[engine] no wallet seam wired; child gets no fresh wallet (integrator TODO)");
    const walletAddress =
      (rec.wallet && typeof rec.wallet === "object" && rec.wallet.address) ||
      (typeof rec.wallet === "string" ? rec.wallet : null);
    await safe("registry.register", pickFn(registry, ["register"]), {
      ...genome,
      address: walletAddress || genome.address || null,
      wallet: rec.wallet,
    });
    await safe("actian.upsertGenome", actian.upsertGenome, genome);
    pop.set(genome.id, rec);
    if (announce) await safe("band.announce", pickFn(band, ["announce"]), genome);
    if (!restored) await emit({ type: isChild ? "child_born" : "variant_seeded", variant_id: genome.id, gen: genome.gen, parent_ids: genome.parent_ids, price_usd: genome.price_usd, model: genome.model });
    return rec;
  }

  async function seed(genomes) {
    for (const g of genomes) await addVariant(g, { isChild: false });
    return state();
  }

  // Durable population state for restart-without-reseed. P&L is NOT stored:
  // it lives in the file-backed ledger and recomputes on the next evalTick.
  function snapshot() {
    return [...pop.values()].map((r) => ({
      genome: r.genome,
      stake_usd: r.stake_usd,
      alive: r.alive,
      born_at: r.born_at,
      delist_reason: r.delist_reason,
    }));
  }

  // Rebuild the population from a snapshot: living variants re-register their
  // paid routes (wallets reuse by id), delisted ones re-register then delist so
  // their routes still 410 with the original reason. No announce/seed events.
  async function restore(records) {
    for (const r of records) {
      if (!r || !r.genome || !r.genome.id) continue;
      const rec = await addVariant(r.genome, { announce: false, isChild: false, restored: true });
      if (Number.isFinite(r.stake_usd)) rec.stake_usd = r.stake_usd;
      if (Number.isFinite(r.born_at)) rec.born_at = r.born_at;
      if (r.alive === false) {
        rec.alive = false;
        rec.delist_reason = r.delist_reason || "restored: delisted in prior run";
        await safe("registry.delist", pickFn(registry, ["delist"]), r.genome.id, rec.delist_reason);
      }
    }
    return state();
  }

  function fitnessOf(id) {
    if (fnPer100) {
      const v = fnPer100(id);
      if (Number.isFinite(Number(v))) return Number(v);
    }
    return num(fnPnl ? fnPnl(id) : 0, 0);
  }

  async function insolvency(id, rec) {
    rec.alive = false;
    rec.delist_reason = "insolvent: bankroll exhausted";
    const estate = {
      variant_id: id,
      genome: rec.genome,
      born_at: new Date(rec.born_at).toISOString(),
      died_at: new Date().toISOString(),
      lifetime_ms: Date.now() - rec.born_at,
      cause: "insolvency",
      stake_usd: rec.stake_usd,
      final_pnl: rec.pnl,
      final_bankroll: rec.bankroll,
      fitness: rec.fitness,
      requests: rec.requests,
    };
    await safe("registry.delist", pickFn(registry, ["delist"]), id, rec.delist_reason);
    await safe("actian.writeEstate", actian.writeEstate, estate);
    await emit({ type: "bankruptcy", variant_id: id, gen: rec.genome.gen, final_pnl: rec.pnl, reason: rec.delist_reason });
    console.log(`[engine] BANKRUPTCY ${id} gen=${rec.genome.gen} pnl=${rec.pnl.toFixed(4)} -> delisted, estate written`);
  }

  // Evaluate fitness + solvency for every living variant.
  async function evalTick() {
    for (const [id, rec] of pop) {
      if (!rec.alive) continue;
      try {
        rec.pnl = num(fnPnl ? await fnPnl(id) : 0, 0);
        rec.fitness = num(await fitnessOf(id), 0);
        rec.requests = num(fnReqs ? await fnReqs(id) : rec.requests, rec.requests);
        rec.bankroll = rec.stake_usd + rec.pnl;
        if (rec.bankroll <= 0) await insolvency(id, rec);
      } catch (err) {
        console.warn(`[engine] evalTick(${id}) failed: ${err.message}`);
      }
    }
    return state();
  }

  // Breed the top-2 fittest solvent variants through the guild gate.
  async function breedTick() {
    if (breeding) return { bred: false, reason: "breed already in progress" };
    breeding = true;
    try {
      const alive = [...pop.entries()].filter(([, r]) => r.alive);
      if (alive.length < 2) return { bred: false, reason: "need 2 living parents" };
      if (alive.length >= cfg.maxPopulation) return { bred: false, reason: "population at cap" };
      const ranked = alive.sort((a, b) => b[1].fitness - a[1].fitness);
      const [aId, aRec] = ranked[0];
      const [bId, bRec] = ranked[1];
      const experienced = aRec.requests + bRec.requests >= cfg.minParentRequests;
      if (!experienced) return { bred: false, reason: `parents need ${cfg.minParentRequests} combined requests, have ${aRec.requests + bRec.requests}` };

      // Inherited immunity: parents' failure clusters from Actian.
      const failureClusters = (await safe("actian.getFailureClusters", actian.getFailureClusters, [aId, bId])) || [];
      const child = await breed(aRec.genome, bRec.genome, {
        failureClusters,
        forceLocal: cfg.forceLocalBreed,
      });

      const gateFn = pickFn(guild, ["gateMutation"]);
      // Guild's parents-solvent rule fails closed on unknown solvency: pass the
      // parents WITH live bankroll evidence, plus the stake the child would get.
      const parentGenomes = [
        { ...aRec.genome, bankroll_usd: aRec.bankroll },
        { ...bRec.genome, bankroll_usd: bRec.bankroll },
      ];
      const verdict = gateFn
        ? await safe("guild.gateMutation", gateFn, child, parentGenomes, { stakeUsd: cfg.bankrollUsd })
        : { approved: true, trace: ["no guild seam wired; ungated (integrator TODO)"] };
      if (!verdict || !verdict.approved) {
        await emit({ type: "governance_block", variant_id: child.id, parent_ids: child.parent_ids, trace: verdict?.trace || ["gate returned no verdict"] });
        console.log(`[engine] guild BLOCKED child ${child.id}: ${JSON.stringify(verdict?.trace || [])}`);
        return { bred: false, reason: "guild blocked", child, trace: verdict?.trace };
      }

      await addVariant(child, { isChild: true });
      console.log(`[engine] BRED ${child.id} gen=${child.gen} from ${aId}+${bId} (immunity clusters: ${failureClusters.length})`);
      return { bred: true, child, parents: [aId, bId], failureClusters, trace: verdict.trace };
    } finally {
      breeding = false;
    }
  }

  function state() {
    const rows = [...pop.entries()].map(([id, r]) => ({
      id,
      gen: r.genome.gen,
      parent_ids: r.genome.parent_ids,
      model: r.genome.model,
      niche: r.genome.niche,
      price_usd: r.genome.price_usd,
      alive: r.alive,
      stake_usd: r.stake_usd,
      pnl: r.pnl,
      bankroll: r.bankroll,
      fitness: r.fitness,
      requests: r.requests,
      delist_reason: r.delist_reason,
      wallet: r.wallet?.address || r.wallet || null,
    }));
    const living = rows.filter((r) => r.alive);
    return {
      generation: living.length ? Math.max(...living.map((r) => r.gen)) : 0,
      population: rows,
      alive: living.length,
      dead: rows.length - living.length,
      config: cfg,
    };
  }

  function start() {
    if (timers.length) return;
    const t1 = setInterval(() => { evalTick().catch((e) => console.warn(`[engine] evalTick crashed: ${e.message}`)); }, cfg.evalEveryMs);
    const t2 = setInterval(() => { breedTick().catch((e) => console.warn(`[engine] breedTick crashed: ${e.message}`)); }, cfg.breedEveryMs);
    t1.unref?.(); t2.unref?.();
    timers = [t1, t2];
    console.log(`[engine] cadence started: eval every ${cfg.evalEveryMs}ms, breed check every ${cfg.breedEveryMs}ms, stake ${cfg.bankrollUsd} USD`);
  }

  function stop() {
    for (const t of timers) clearInterval(t);
    timers = [];
  }

  return { seed, snapshot, restore, addVariant, evalTick, breedTick, state, start, stop, config: cfg };
}

// ---------------------------------------------------------------------------
if (process.env.SELF_TEST) {
  const assert = (cond, msg) => {
    if (!cond) { console.error("SELF_TEST FAIL:", msg); process.exit(1); }
  };
  const { seedPopulation } = await import("./genome.js");
  const { createActian } = await import("../memory/actian.js");

  const calls = { register: [], delist: [], announce: [], emit: [], gate: [], wallet: [] };
  const pnlById = {};
  const deps = {
    registry: {
      register: (v) => calls.register.push(v.id),
      delist: (id, reason) => calls.delist.push({ id, reason }),
    },
    ledger: {
      pnl: (id) => pnlById[id] ?? 0,
      profitPer100: (id) => (pnlById[id] ?? 0) * 10,
      requestCount: () => 5,
    },
    wallets: { createWallet: (id) => { calls.wallet.push(id); return { address: "0xtest" + id }; } },
    band: {
      announce: (v) => calls.announce.push(v.id),
      emit: (e) => calls.emit.push(e.type),
    },
    guild: { gateMutation: (child) => { calls.gate.push(child.id); return { approved: true, trace: ["price in band", "delta bounded"] }; } },
    actian: createActian({ forceLocal: true, persistLocal: false }),
  };

  const engine = createEngine(deps, { forceLocalBreed: true, minParentRequests: 0, bankrollUsd: 0.25 });
  const seeds = seedPopulation().slice(0, 3);
  await engine.seed(seeds);
  assert(calls.register.length === 3, "3 variants registered");
  assert(calls.wallet.length === 3, "3 wallets created");

  // Record a real failure for a parent so inherited immunity has substance.
  await deps.actian.recordFailure({ variant_id: seeds[0].id, reason: "claims missing source_url" });

  // One winner, one modest, one insolvent (pnl wipes the 0.25 stake).
  pnlById[seeds[0].id] = 0.10;
  pnlById[seeds[1].id] = 0.02;
  pnlById[seeds[2].id] = -0.30;
  await engine.evalTick();
  assert(calls.delist.length === 1 && calls.delist[0].id === seeds[2].id, "insolvent variant delisted");
  assert(calls.emit.includes("bankruptcy"), "bankruptcy event emitted");
  const estates = (await deps.actian.search("estates", "estate", { limit: 5 }));
  assert(estates.some((e) => e.payload?.variant_id === seeds[2].id), "estate written to actian");

  const res = await engine.breedTick();
  assert(res.bred === true, `breed succeeded: ${res.reason || "ok"}`);
  assert(res.child.gen === 1 && res.parents.includes(seeds[0].id), "child gen 1 from top parent");
  assert(res.failureClusters.length >= 1, "parent failure clusters retrieved for immunity");
  assert(res.child.prompt_variant.includes("INHERITED IMMUNITY"), "immunity injected into child prompt");
  assert(calls.gate.length === 1, "guild gate consulted");
  const st = engine.state();
  assert(st.population.length === 4 && st.alive === 3 && st.generation === 1, "state: 4 total, 3 alive, gen 1");

  // snapshot -> restore into a FRESH engine must preserve gen, liveness, and delists.
  const snap = engine.snapshot();
  assert(snap.length === 4 && snap.filter((r) => r.alive).length === 3, "snapshot carries 4 records, 3 alive");
  const calls2 = { register: [], delist: [] };
  const engine2 = createEngine({
    ...deps,
    registry: {
      register: (v) => calls2.register.push(v.id),
      delist: (id, reason) => calls2.delist.push({ id, reason }),
    },
  }, { forceLocalBreed: true, minParentRequests: 0, bankrollUsd: 0.25 });
  const restored = await engine2.restore(snap);
  assert(restored.population.length === 4 && restored.alive === 3 && restored.generation === 1, "restore: 4 total, 3 alive, gen 1 (no gen-0 reseed)");
  assert(calls2.delist.length === 1 && calls2.delist[0].id === seeds[2].id, "restore re-delists the dead variant (route 410s)");
  console.log("engine.js SELF_TEST OK:", { generation: st.generation, alive: st.alive, dead: st.dead, child: res.child.id, clusters: res.failureClusters, restored: { alive: restored.alive, generation: restored.generation } });
}
