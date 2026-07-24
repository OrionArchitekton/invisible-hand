// src/publish/senso.js
// Senso ("Context OS") integration: publish a per-generation market report
// into the org knowledge base, where it is agent-discoverable/searchable.
// Surface verified 2026-07-24 from the official CLI source
// (github.com/AI-Template-SDK/senso-user-cli): base https://apiv2.senso.ai/api/v1,
// auth X-API-Key, POST /org/kb/upload -> presigned S3 PUT per file.
// HONESTY BAR: no SENSO_API_KEY -> local mode (data/senso-local.jsonl), labeled,
// never pretended live.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const LOCAL_FILE = path.join(DATA_DIR, 'senso-local.jsonl');
const BASE_URL = process.env.SENSO_BASE_URL || 'https://apiv2.senso.ai/api/v1';

export function isSensoLive() {
  return Boolean(process.env.SENSO_API_KEY);
}

// Render the market state into an honest markdown report. Testnet is called
// testnet; self-play demand disclosure is part of the report body itself.
export function renderMarketReport(state, { events = [] } = {}) {
  const living = (state.population || []).filter((r) => r.alive);
  const dead = (state.population || []).filter((r) => !r.alive);
  const champion = [...living].sort((a, b) => b.fitness - a.fitness)[0];
  const modelCounts = {};
  for (const r of living) modelCounts[r.model] = (modelCounts[r.model] || 0) + 1;
  const ts = new Date().toISOString();
  const lines = [
    `# Invisible Hand market report (generation ${state.generation})`,
    '',
    `Generated ${ts} by the Invisible Hand agent economy (SwarmHack 2026-07-24).`,
    'An evolving population of seller agents sells claim extraction behind x402',
    'paywalls settled with TESTNET USDC on Base Sepolia. Demand is disclosed',
    'self-play: adversarial verifier-buyers, not external customers.',
    '',
    `- Living variants: ${living.length}; delisted (bankrupt): ${dead.length}`,
    `- Generation: ${state.generation}`,
    champion
      ? `- Champion: ${champion.id} (gen ${champion.gen}, model ${champion.model}, price $${champion.price_usd}, fitness ${Number(champion.fitness).toFixed(4)}, pnl $${Number(champion.pnl).toFixed(4)})`
      : '- Champion: none (no living variants)',
    `- Price range: $${Math.min(...living.map((r) => r.price_usd), Infinity)} to $${Math.max(...living.map((r) => r.price_usd), 0)}`,
    `- Model distribution: ${Object.entries(modelCounts).map(([m, n]) => `${m} x${n}`).join(', ') || 'none'}`,
    '',
    '## Population',
    '',
    '| id | gen | model | price | pnl | fitness | status |',
    '|---|---|---|---|---|---|---|',
    ...(state.population || []).map((r) =>
      `| ${r.id} | ${r.gen} | ${r.model} | $${r.price_usd} | $${Number(r.pnl).toFixed(4)} | ${Number(r.fitness).toFixed(4)} | ${r.alive ? 'live' : `delisted (${r.delist_reason || 'bankrupt'})`} |`),
    '',
    ...(events.length ? ['## Recent events', '', ...events.slice(-12).map((e) => `- ${e}`)] : []),
  ];
  return lines.join('\n');
}

async function sensoRequest(method, apiPath, body) {
  const res = await fetch(BASE_URL + apiPath, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      'X-API-Key': process.env.SENSO_API_KEY,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 200);
    throw new Error(`senso ${method} ${apiPath} -> HTTP ${res.status} ${errBody}`);
  }
  return res.json();
}

// Publish one report into the Senso KB. Returns {mode, filename, status?}.
export async function publishMarketReport(state, opts = {}) {
  const markdown = renderMarketReport(state, opts);
  const filename = `invisible-hand-report-gen${state.generation}-${Date.now()}.md`;
  if (!isSensoLive()) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(LOCAL_FILE, JSON.stringify({ ts: new Date().toISOString(), filename, markdown }) + '\n');
    } catch (err) {
      console.warn(`[senso:local] persist failed: ${err.message}`);
    }
    console.log(`[senso:local] no SENSO_API_KEY; report appended to data/senso-local.jsonl (${filename})`);
    return { mode: 'local', filename };
  }
  const buffer = Buffer.from(markdown, 'utf8');
  const meta = {
    filename,
    file_size_bytes: buffer.length,
    content_type: 'text/markdown',
    content_hash_md5: createHash('md5').update(buffer).digest('hex'),
  };
  const prep = await sensoRequest('POST', '/org/kb/upload', { files: [meta] });
  const item = (prep.results || [])[0];
  if (!item || item.status !== 'upload_pending' || !item.upload_url) {
    throw new Error(`senso upload not accepted: ${JSON.stringify(item || prep).slice(0, 200)}`);
  }
  const put = await fetch(item.upload_url, {
    method: 'PUT',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': meta.content_type },
    body: buffer,
  });
  if (!put.ok) throw new Error(`senso S3 PUT -> HTTP ${put.status}`);
  console.log(`[senso:live] published ${filename} to org KB (gen ${state.generation})`);
  return { mode: 'live', filename, status: 'uploaded' };
}

// Inline self-test: local-mode rendering only (no key, no network).
if (process.env.SELF_TEST) {
  const saved = process.env.SENSO_API_KEY;
  delete process.env.SENSO_API_KEY;
  const state = {
    generation: 2,
    population: [
      { id: 'v0-a', gen: 0, model: 'pioneer/auto', price_usd: 0.01, pnl: 0.05, fitness: 0.5, alive: true },
      { id: 'v1-b', gen: 1, model: 'Qwen/Qwen3-8B', price_usd: 0.02, pnl: -0.25, fitness: -2.5, alive: false, delist_reason: 'insolvent' },
    ],
  };
  const md = renderMarketReport(state, { events: ['child_born v1-b'] });
  const ok = md.includes('generation 2') && md.includes('TESTNET') && md.includes('self-play')
    && md.includes('v1-b') && md.includes('delisted (insolvent)') && !isSensoLive();
  const out = await publishMarketReport(state);
  console.log(`[senso self-test] ok=${ok && out.mode === 'local'} mode=${out.mode} file=${out.filename}`);
  if (saved) process.env.SENSO_API_KEY = saved;
  if (!(ok && out.mode === 'local')) process.exit(1);
}
