// src/buyers/fleet.js
// The adversarial buyer fleet. Each cycle: pull a real task from live Hacker News,
// pick a seller from the registry (epsilon-greedy over rolling verified quality),
// pay via x402-fetch with the buyer treasury account, verify the output
// adversarially, log a receipt, and enforce the re-purchase policy: verified
// failures decay that seller's weight HARD.
//
// Honesty bar: self-play demand is disclosed; buyers are verifiers, not praise
// bots. Missing wallet or registry modules mean the fleet refuses to run a paid
// cycle and says so; nothing is faked.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { verify } from "./verify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const RECEIPTS_PATH = path.join(DATA_DIR, "receipts.jsonl");

const HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

const EPSILON = Number(process.env.BUYER_EPSILON || 0.15);
const REPURCHASE_FLOOR = Number(process.env.BUYER_REPURCHASE_FLOOR || 0.05);
const BUY_EVERY_MS = Number(process.env.BUY_EVERY_MS || 15000);
const FLEET_MAX_SPEND_USD = Number(process.env.FLEET_MAX_SPEND_USD || 5);
// x402 max payment per request, USDC base units (6 decimals). Genome price
// ceiling is 0.02 USD; 0.05 default gives headroom while capping blast radius.
const MAX_PAY_USDC = BigInt(Math.round(Number(process.env.X402_MAX_USDC || 0.05) * 1e6));
const FETCH_TIMEOUT_MS = Number(process.env.FLEET_FETCH_TIMEOUT_MS || 30000);

// ---------- receipts ----------

function appendReceipt(entry) {
  if (process.env.SELF_TEST) return; // keep the real data plane clean during self-tests
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(RECEIPTS_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("[fleet] failed to append receipts.jsonl:", err.message);
  }
}

function readRecentReceipts(limit = 500) {
  try {
    const lines = fs.readFileSync(RECEIPTS_PATH, "utf8").trim().split("\n");
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- rolling verified-quality weights ----------

export function createQualityTracker() {
  const stats = new Map(); // variant_id -> {attempts, ok, fail, weight}
  const get = (id) => {
    if (!stats.has(id)) stats.set(id, { attempts: 0, ok: 0, fail: 0, weight: 0.5 });
    return stats.get(id);
  };
  return {
    get,
    all: () => stats,
    recordSuccess(id) {
      const s = get(id);
      s.attempts += 1;
      s.ok += 1;
      s.weight = Math.min(1, s.weight + 0.3 * (1 - s.weight));
      return s.weight;
    },
    // Re-purchase policy: a VERIFIED failure decays the weight hard.
    recordVerifiedFailure(id) {
      const s = get(id);
      s.attempts += 1;
      s.fail += 1;
      s.weight = Math.max(0.01, s.weight * 0.2);
      return s.weight;
    },
    // Transport problems (timeouts, 410 race, payment errors): mild decay only.
    recordTransportFailure(id) {
      const s = get(id);
      s.attempts += 1;
      s.weight = Math.max(0.01, s.weight * 0.7);
      return s.weight;
    },
    seedFromReceipts(receipts) {
      for (const r of receipts) {
        if (!r.variant_id) continue;
        if (r.infra_error || r.transport_error) continue;
        if (r.verified === true) this.recordSuccess(r.variant_id);
        else if (r.verified === false) this.recordVerifiedFailure(r.variant_id);
      }
    },
  };
}

// ---------- seller selection: epsilon-greedy over quality weights ----------

export function pickSeller(variants, tracker, epsilon = EPSILON, rng = Math.random) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  // Exploration: uniform over EVERYONE, including punished sellers. This is the
  // only rehabilitation path a hard-decayed seller has.
  if (rng() < epsilon) {
    return variants[Math.floor(rng() * variants.length)];
  }
  // Exploitation: weighted sample over sellers above the re-purchase floor.
  let pool = variants.filter((v) => tracker.get(variantId(v)).weight > REPURCHASE_FLOOR);
  if (pool.length === 0) pool = variants;
  const weights = pool.map((v) => tracker.get(variantId(v)).weight);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function variantId(v) {
  return v.id || v.variant_id || v.genome?.id;
}

function variantPrice(v) {
  const p = v.price_usd ?? v.genome?.price_usd;
  return typeof p === "number" ? p : null;
}

function sellerEndpoint(v) {
  if (v.endpoint) return v.endpoint;
  if (v.url) return v.url;
  const base = process.env.MARKET_URL || "http://localhost:4020";
  return `${base}/v/${variantId(v)}/extract`;
}

// ---------- live tasks: Hacker News firebase API (keyless, real) ----------

export async function fetchTasks(limit = 10) {
  const res = await fetch(HN_TOP, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HN topstories ${res.status}`);
  const ids = (await res.json()).slice(0, 60);
  // Shuffle so consecutive cycles spread across the front page.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const tasks = [];
  for (const id of ids) {
    if (tasks.length >= limit) break;
    try {
      const item = await (
        await fetch(HN_ITEM(id), { signal: AbortSignal.timeout(10000) })
      ).json();
      if (item && item.url && item.type === "story") {
        tasks.push({ id: item.id, title: item.title, url: item.url });
      }
    } catch {
      // skip unreachable items; live data is allowed to be messy
    }
  }
  if (tasks.length === 0) throw new Error("no HN tasks with URLs found");
  return tasks;
}

// ---------- lazy seams to modules owned by other builders ----------

let _registry = null;
async function loadRegistry() {
  if (_registry) return _registry;
  const mod = await import("../market/registry.js");
  _registry = mod.registry || mod.default || mod;
  if (typeof _registry.list !== "function") {
    throw new Error("registry module loaded but exposes no list()");
  }
  return _registry;
}

let _treasury = null;
async function loadTreasuryAccount() {
  if (_treasury) return _treasury;
  const mod = await import("../market/wallets.js");
  const candidate =
    (typeof mod.getTreasuryAccount === "function" && (await mod.getTreasuryAccount())) ||
    (typeof mod.getBuyerTreasury === "function" && (await mod.getBuyerTreasury())) ||
    mod.treasuryAccount ||
    mod.buyerTreasury ||
    mod.treasury ||
    null;
  if (!candidate) {
    throw new Error(
      "wallets.js loaded but no treasury export found (tried getTreasuryAccount/getBuyerTreasury/treasuryAccount/buyerTreasury/treasury)"
    );
  }
  _treasury = candidate;
  return _treasury;
}

// ---------- one purchase cycle ----------

/**
 * Run one adversarial purchase cycle.
 * @param {object} opts
 *   opts.tracker  quality tracker (createQualityTracker())
 *   opts.registry override registry (must expose list())
 *   opts.account  override treasury signer (viem local account)
 *   opts.task     override task {url, title}; default pulls live from HN
 *   opts.onEvent  optional (event) => void for dashboard/mesh wiring
 * @returns {Promise<object>} the receipt written (or {skipped, reason})
 */
export async function runCycle(opts = {}) {
  const tracker = opts.tracker;
  if (!tracker) throw new Error("runCycle requires opts.tracker");
  const emit = typeof opts.onEvent === "function" ? opts.onEvent : () => {};

  let registry;
  let account;
  try {
    registry = opts.registry || (await loadRegistry());
    account = opts.account || (await loadTreasuryAccount());
  } catch (err) {
    const reason = `fleet cannot run a paid cycle: ${err.message}`;
    console.error(`[fleet] ${reason}`);
    return { skipped: true, reason };
  }

  const variants = await registry.list();
  const live = (variants || []).filter((v) => !v.delisted && v.status !== "delisted");
  if (live.length === 0) return { skipped: true, reason: "no live sellers in registry" };

  const seller = pickSeller(live, tracker);
  const vid = variantId(seller);
  const task = opts.task || (await fetchTasks(1))[0];
  emit({ type: "buy_order", variant_id: vid, task_url: task.url, title: task.title, price: variantPrice(seller) });

  const fetchWithPay = wrapFetchWithPayment(fetch, account, MAX_PAY_USDC);
  const receipt = {
    ts: new Date().toISOString(),
    variant_id: vid,
    price: variantPrice(seller),
    verified: false,
    task_url: task.url,
  };

  let payload;
  try {
    const res = await fetchWithPay(sellerEndpoint(seller), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: task.url }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const payHeader = res.headers.get("x-payment-response");
    if (payHeader) {
      try {
        const settled = decodeXPaymentResponse(payHeader);
        if (settled?.transaction) receipt.tx_hash = settled.transaction;
      } catch {
        // header present but undecodable; leave tx_hash unset rather than guess
      }
    }
    if (!res.ok) throw new Error(`seller HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    receipt.transport_error = true;
    receipt.reason = `transport: ${err.message}`;
    tracker.recordTransportFailure(vid);
    appendReceipt(receipt);
    emit({ type: "purchase_failed", variant_id: vid, reason: receipt.reason });
    return receipt;
  }

  const result = await verify(payload, { url: task.url, variant_id: vid });
  receipt.verified = result.verified;
  receipt.verify_mode = result.mode;
  if (!result.verified) receipt.reason = result.reasons.slice(0, 3).join(" | ");
  if (result.infra_error) {
    // Our verification infra failed; do not credit, do not punish.
    receipt.infra_error = true;
  } else if (result.verified) {
    tracker.recordSuccess(vid);
  } else {
    const w = tracker.recordVerifiedFailure(vid);
    emit({ type: "verified_failure", variant_id: vid, weight: w, reasons: result.reasons });
  }
  appendReceipt(receipt);
  emit({ type: "receipt", ...receipt });
  return receipt;
}

// ---------- the fleet loop ----------

/**
 * Start the buyer fleet loop. Returns {stop, tracker}.
 * Spend guard: stops purchasing after FLEET_MAX_SPEND_USD of receipts this run.
 */
export function startFleet(opts = {}) {
  const tracker = opts.tracker || createQualityTracker();
  tracker.seedFromReceipts(readRecentReceipts());
  const everyMs = opts.everyMs || BUY_EVERY_MS;
  let stopped = false;
  let spentUsd = 0;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      if (spentUsd >= FLEET_MAX_SPEND_USD) {
        console.error(
          `[fleet] session spend guard hit (${spentUsd.toFixed(4)} >= ${FLEET_MAX_SPEND_USD} USD); pausing purchases`
        );
      } else {
        const receipt = await runCycle({ ...opts, tracker });
        if (receipt && !receipt.skipped && typeof receipt.price === "number" && receipt.tx_hash) {
          spentUsd += receipt.price;
        }
      }
    } catch (err) {
      console.error("[fleet] cycle error:", err.message);
    }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, 0);

  return {
    tracker,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ---------- self-test (no network, no payments) ----------

if (process.env.SELF_TEST) {
  const assert = (cond, label) => {
    if (!cond) {
      console.error(`SELF_TEST FAIL: ${label}`);
      process.exitCode = 1;
    } else {
      console.log(`SELF_TEST ok: ${label}`);
    }
  };

  const tracker = createQualityTracker();
  assert(tracker.get("a").weight === 0.5, "new seller starts at neutral weight 0.5");
  tracker.recordSuccess("a");
  assert(tracker.get("a").weight > 0.5, "success raises weight");
  const before = tracker.get("a").weight;
  tracker.recordVerifiedFailure("a");
  assert(tracker.get("a").weight <= before * 0.2 + 1e-9, "verified failure decays weight hard (x0.2)");
  for (let i = 0; i < 5; i++) tracker.recordVerifiedFailure("a");
  assert(tracker.get("a").weight >= 0.01, "weight floored at 0.01");

  const t2 = createQualityTracker();
  const variants = [{ id: "good" }, { id: "bad" }];
  for (let i = 0; i < 6; i++) t2.recordSuccess("good");
  for (let i = 0; i < 3; i++) t2.recordVerifiedFailure("bad");
  let goodPicks = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (variantId(pickSeller(variants, t2)) === "good") goodPicks++;
  }
  assert(goodPicks > N * 0.8, `exploitation prefers verified seller (${goodPicks}/${N} picks)`);
  assert(goodPicks < N, "epsilon exploration still reaches punished seller");

  t2.seedFromReceipts([
    { variant_id: "seeded", verified: true },
    { variant_id: "seeded", verified: false },
  ]);
  assert(t2.get("seeded").attempts === 2, "seedFromReceipts replays history");

  console.log("fleet.js self-test done");
}
