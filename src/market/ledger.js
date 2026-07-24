// src/market/ledger.js
// Append-only JSONL money ledger: data/ledger.jsonl.
// Every x402 settlement is credited with its tx_hash; inference costs are debited.
// Fitness (engine) and dashboards read pnl(id) and profitPer100(id) from here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');

export function ledgerPath() {
  return process.env.LEDGER_PATH || path.join(DATA_DIR, 'ledger.jsonl');
}

function appendEntry(entry) {
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  return entry;
}

function makeEntry(type, id, usd, reason, tx_hash) {
  if (!id) throw new Error(`ledger.${type}: id required`);
  const amount = Number(usd);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`ledger.${type}: usd must be a non-negative number, got ${usd}`);
  const entry = {
    ts: new Date().toISOString(),
    type,
    id,
    usd: amount,
    reason: reason || '',
  };
  if (tx_hash) entry.tx_hash = tx_hash;
  return entry;
}

// Money IN for a variant (e.g. a settled x402 sale). Returns the entry.
export function credit(id, usd, reason, tx_hash) {
  return appendEntry(makeEntry('credit', id, usd, reason, tx_hash));
}

// Money OUT for a variant (e.g. inference cost, stake draw). Returns the entry.
export function debit(id, usd, reason, tx_hash) {
  return appendEntry(makeEntry('debit', id, usd, reason, tx_hash));
}

// All entries, oldest first. Optionally filtered by variant id.
export function entries(id) {
  const p = ledgerPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!id || e.id === id) out.push(e);
    } catch {
      // skip corrupt line rather than crash the market
    }
  }
  return out;
}

// Net position for a variant: { id, credits, debits, net, count }.
export function pnl(id) {
  let credits = 0;
  let debits = 0;
  let count = 0;
  for (const e of entries(id)) {
    count += 1;
    if (e.type === 'credit') credits += e.usd;
    else if (e.type === 'debit') debits += e.usd;
  }
  return { id, credits: round6(credits), debits: round6(debits), net: round6(credits - debits), count };
}

function isSale(e) {
  return e.type === 'credit' && typeof e.reason === 'string' && e.reason.startsWith('sale');
}

// Rolling profit per 100 requests. A "request" is a sale credit (one paid buy).
// Walks backward until `window` sales are covered, nets everything in that span,
// and scales to 100 requests. Zero sales yields per100: 0 with requests: 0.
export function profitPer100(id, window = 100) {
  const all = entries(id);
  let sales = 0;
  let net = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const e = all[i];
    if (e.type === 'credit') net += e.usd;
    else if (e.type === 'debit') net -= e.usd;
    if (isSale(e)) {
      sales += 1;
      if (sales >= window) break;
    }
  }
  return {
    id,
    window,
    requests: sales,
    net: round6(net),
    per100: sales > 0 ? round6((net / sales) * 100) : 0,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Inline self-test against a scratch ledger file (never the real one).
if (process.env.SELF_TEST) {
  const tmp = path.join(os.tmpdir(), `ih-ledger-selftest-${process.pid}.jsonl`);
  const savedPath = process.env.LEDGER_PATH;
  process.env.LEDGER_PATH = tmp;
  try {
    credit('v1', 0.001, 'sale', '0xabc');
    credit('v1', 0.001, 'sale', '0xdef');
    debit('v1', 0.0005, 'inference_cost');
    const p = pnl('v1');
    const r = profitPer100('v1');
    const ok = p.net === 0.0015 && r.requests === 2 && r.per100 === 0.075;
    console.log(`[ledger self-test] ok=${ok} pnl=${JSON.stringify(p)} per100=${JSON.stringify(r)}`);
    if (!ok) process.exit(1);
  } finally {
    if (savedPath === undefined) delete process.env.LEDGER_PATH;
    else process.env.LEDGER_PATH = savedPath;
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
  }
}
