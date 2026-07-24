// src/governance/guild.js
// Governed mutation gate. The policy rules are REAL and enforced LOCALLY on every
// breed attempt; approval is decided here, deterministically, from the rules below.
//
// Guild AI surface (recon 2026-07-24, docs.guild.ai): Guild exposes no general
// REST API for logging arbitrary decisions. Its one public HTTP entry point is
// the trigger sessions API:
//   POST https://app.guild.ai/api/workspaces/{owner}/{workspace}/sessions
//   Basic auth "api_key_id:api_key_secret", body:
//   {"session_type": "api_trigger", "agent_input": {...}}
// So "register with Guild" here means: start an api_trigger session on a Guild
// agent in our workspace, carrying the decision trace as agent_input. That needs
// GUILD_API_KEY in id:secret form AND GUILD_WORKSPACE ("owner/workspace") AND a
// Guild agent configured with an HTTP trigger. Anything less runs in honest
// local mode; local policy remains authoritative in BOTH modes.
//
// Every decision (approved or rejected, local or registered) appends one line to
// data/governance.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GUILD_API_URL = (process.env.GUILD_API_URL || 'https://app.guild.ai').replace(/\/+$/, '');
const HTTP_TIMEOUT_MS = 8000;

// Union of the mesh defaults and genome.js NICHE_POOL (ai, crypto, security,
// science, business, general) so bred children inheriting a seed niche pass.
const DEFAULT_NICHE_ALLOWLIST = ['hn', 'rss', 'news', 'tech', 'ai', 'crypto', 'science', 'dev', 'general', 'security', 'business'];

function dataDir() {
  return process.env.IH_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}
export function governanceFile() {
  return path.join(dataDir(), 'governance.jsonl');
}

// Policy is computed per call so env tuning applies without restart.
export function getPolicy() {
  return {
    price_floor_usd: 0.0005,
    price_ceiling_usd: 0.05,
    max_price_delta_pct: 50,
    spend_cap_usd: numEnv('GUILD_SPEND_CAP_USD', 2.0),
    default_child_stake_usd: numEnv('BANKROLL_USD', 0.25),
    niche_allowlist: (process.env.NICHE_ALLOWLIST || DEFAULT_NICHE_ALLOWLIST.join(','))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export function isGuildLive() {
  return Boolean(process.env.GUILD_API_KEY) && !process.env.GUILD_FORCE_LOCAL;
}

// Sum of stakes already approved for bred children (reads data/governance.jsonl).
export function spendCommitted() {
  let total = 0;
  let raw;
  try {
    raw = fs.readFileSync(governanceFile(), 'utf8');
  } catch {
    return 0;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'guild_decision' && rec.approved && Number.isFinite(rec.child_stake_usd)) {
        total += rec.child_stake_usd;
      }
    } catch { /* skip corrupt line */ }
  }
  return total;
}

async function parentSolvency(parent, isSolvent) {
  if (typeof isSolvent === 'function') {
    try {
      return { known: true, solvent: Boolean(await isSolvent(parent)) };
    } catch (err) {
      return { known: false, why: `opts.isSolvent threw: ${err.message}` };
    }
  }
  if (typeof parent.solvent === 'boolean') return { known: true, solvent: parent.solvent };
  const bank = Number.isFinite(parent.bankroll_usd) ? parent.bankroll_usd
    : Number.isFinite(parent.balance_usd) ? parent.balance_usd
      : null;
  if (bank !== null) return { known: true, solvent: bank > 0 };
  return { known: false, why: 'no solvency evidence on genome' };
}

// gateMutation(childGenome, parentGenomes, opts) -> {approved, trace}
// opts.isSolvent: optional (sync or async) predicate (parentGenome) -> boolean,
//   used for the parents-solvent rule; otherwise parent.solvent / bankroll_usd /
//   balance_usd on the genome are used. Unknown solvency FAILS CLOSED.
// opts.stakeUsd: stake the child would receive (defaults child.stake_usd, then
//   BANKROLL_USD env, then 0.25); counted against the cumulative spend cap.
export async function gateMutation(childGenome, parentGenomes = [], opts = {}) {
  if (!childGenome || typeof childGenome !== 'object') {
    throw new Error('gateMutation requires a childGenome object');
  }
  const policy = getPolicy();
  const parents = Array.isArray(parentGenomes) ? parentGenomes : [];
  const trace = [];
  const price = Number(childGenome.price_usd);
  const stake = Number.isFinite(opts.stakeUsd) ? opts.stakeUsd
    : Number.isFinite(childGenome.stake_usd) ? childGenome.stake_usd
      : policy.default_child_stake_usd;

  // Rule 1: price floor
  trace.push({
    rule: 'price_floor',
    ok: Number.isFinite(price) && price >= policy.price_floor_usd,
    detail: Number.isFinite(price)
      ? `price ${price} vs floor ${policy.price_floor_usd}`
      : `price_usd is not a finite number (${childGenome.price_usd})`,
  });

  // Rule 2: price ceiling
  trace.push({
    rule: 'price_ceiling',
    ok: Number.isFinite(price) && price <= policy.price_ceiling_usd,
    detail: Number.isFinite(price)
      ? `price ${price} vs ceiling ${policy.price_ceiling_usd}`
      : 'price_usd is not a finite number',
  });

  // Rule 3: max mutation delta on price, plus or minus 50 percent of the mean parent price
  const parentPrices = parents.map((p) => Number(p && p.price_usd)).filter(Number.isFinite);
  if (parentPrices.length === 0) {
    trace.push({
      rule: 'price_mutation_delta',
      ok: true,
      detail: 'no parent prices (seed generation), delta rule not applicable',
    });
  } else {
    const mean = parentPrices.reduce((a, b) => a + b, 0) / parentPrices.length;
    const deltaPct = mean > 0 ? (Math.abs(price - mean) / mean) * 100 : Infinity;
    trace.push({
      rule: 'price_mutation_delta',
      ok: Number.isFinite(price) && deltaPct <= policy.max_price_delta_pct + 1e-9,
      detail: `child ${price} vs parent mean ${mean.toFixed(6)} = ${deltaPct.toFixed(1)}% delta (max ${policy.max_price_delta_pct}%)`,
    });
  }

  // Rule 4: niche allowlist
  const niche = typeof childGenome.niche === 'string' ? childGenome.niche.trim().toLowerCase() : '';
  trace.push({
    rule: 'niche_allowlist',
    ok: Boolean(niche) && policy.niche_allowlist.includes(niche),
    detail: niche
      ? `niche "${niche}" ${policy.niche_allowlist.includes(niche) ? 'in' : 'NOT in'} allowlist [${policy.niche_allowlist.join(', ')}]`
      : 'genome has no niche (fail closed)',
  });

  // Rule 5: spend cap on child stakes. The cap governs capital CONCURRENTLY
  // at risk: when the caller reports the stake deployed across LIVING
  // variants (opts.deployedStakeUsd), that is the committed base; dead
  // variants' stakes are no longer deployed. Without that report we fall
  // back to the lifetime approved-stake ledger (stricter, grow-only). The
  // trace names which basis was used.
  const deployed = Number.isFinite(opts.deployedStakeUsd) ? opts.deployedStakeUsd : null;
  const committed = deployed !== null ? deployed : spendCommitted();
  trace.push({
    rule: 'spend_cap',
    ok: committed + stake <= policy.spend_cap_usd + 1e-9,
    detail: `${deployed !== null ? 'deployed(live)' : 'lifetime-approved'} ${committed.toFixed(4)} + stake ${stake} vs cap ${policy.spend_cap_usd}`,
  });

  // Rule 6: parents solvent at breed time (fail closed on unknown)
  if (parents.length === 0) {
    trace.push({
      rule: 'parents_solvent',
      ok: true,
      detail: 'no parents (seed generation)',
    });
  } else {
    const results = [];
    let allOk = true;
    for (const parent of parents) {
      const s = await parentSolvency(parent || {}, opts.isSolvent);
      const pid = (parent && parent.id) || 'unknown-id';
      if (!s.known) {
        allOk = false;
        results.push(`${pid}: solvency UNKNOWN, fail closed (${s.why}); pass bankroll_usd, solvent, or opts.isSolvent`);
      } else if (!s.solvent) {
        allOk = false;
        results.push(`${pid}: INSOLVENT`);
      } else {
        results.push(`${pid}: solvent`);
      }
    }
    trace.push({ rule: 'parents_solvent', ok: allOk, detail: results.join('; ') });
  }

  const approved = trace.every((t) => t.ok);

  const record = {
    ts: new Date().toISOString(),
    type: 'guild_decision',
    child_id: childGenome.id ?? null,
    parent_ids: parents.map((p) => (p && p.id) || null),
    gen: childGenome.gen ?? null,
    approved,
    child_stake_usd: stake,
    child: {
      price_usd: childGenome.price_usd,
      model: childGenome.model,
      niche: childGenome.niche,
      prompt_variant: childGenome.prompt_variant,
    },
    policy,
    trace,
    mode: isGuildLive() ? 'guild' : 'local',
  };

  record.guild = await registerWithGuild(record);
  appendJsonl(governanceFile(), record);

  const failed = trace.filter((t) => !t.ok).map((t) => t.rule);
  const tag = record.guild.registered ? '[guild:live]' : '[guild:local]';
  if (approved) {
    console.log(`${tag} APPROVED child ${record.child_id} (${trace.length}/${trace.length} rules)`);
  } else {
    console.log(`${tag} REJECTED child ${record.child_id}: ${failed.join(', ')}`);
  }

  return { approved, trace };
}

// Register the decision trace with Guild via its trigger sessions API. Never
// throws and never affects the local verdict; returns a status object stored on
// the decision record.
async function registerWithGuild(record) {
  if (!isGuildLive()) {
    return { registered: false, mode: 'local', reason: process.env.GUILD_API_KEY ? 'GUILD_FORCE_LOCAL set' : 'no GUILD_API_KEY' };
  }
  const key = process.env.GUILD_API_KEY;
  const workspace = process.env.GUILD_WORKSPACE;
  if (!workspace) {
    return { registered: false, mode: 'local', reason: 'GUILD_WORKSPACE not set (need "owner/workspace" for the trigger sessions URL)' };
  }
  if (!key.includes(':')) {
    return { registered: false, mode: 'local', reason: 'GUILD_API_KEY must be "api_key_id:api_key_secret" for basic auth' };
  }
  const url = `${GUILD_API_URL}/api/workspaces/${workspace}/sessions`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(key).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_type: 'api_trigger',
        agent_input: {
          source: 'invisible-hand',
          kind: 'governance_decision',
          decision: {
            child_id: record.child_id,
            parent_ids: record.parent_ids,
            approved: record.approved,
            trace: record.trace,
            ts: record.ts,
          },
        },
      }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      console.warn(`[guild] trace registration failed: HTTP ${res.status} (decision still logged locally)`);
      return { registered: false, mode: 'guild_attempted', status: res.status };
    }
    const sessionId = json && (json.session_id || json.id) || null;
    return { registered: true, mode: 'guild', session_id: sessionId, workspace };
  } catch (err) {
    console.warn(`[guild] trace registration failed: ${err.message} (decision still logged locally)`);
    return { registered: false, mode: 'guild_attempted', reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Inline self-test: SELF_TEST=1 node src/governance/guild.js (forces local mode
// and a temp data dir unless IH_DATA_DIR is set).
if (process.env.SELF_TEST) {
  process.env.GUILD_FORCE_LOCAL = '1';
  if (!process.env.IH_DATA_DIR) {
    const os = await import('node:os');
    process.env.IH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-guild-'));
  }
  const solventParents = [
    { id: 'p1', price_usd: 0.002, bankroll_usd: 0.2 },
    { id: 'p2', price_usd: 0.004, bankroll_usd: 0.1 },
  ];
  const good = await gateMutation(
    { id: 'c1', gen: 1, price_usd: 0.003, niche: 'hn', model: 'm', stake_usd: 0.25 },
    solventParents,
  );
  if (!good.approved) throw new Error('SELF_TEST FAIL: good child rejected: ' + JSON.stringify(good.trace));

  const badPrice = await gateMutation(
    { id: 'c2', gen: 1, price_usd: 0.09, niche: 'hn', stake_usd: 0.25 },
    solventParents,
  );
  if (badPrice.approved) throw new Error('SELF_TEST FAIL: over-ceiling child approved');

  const badDelta = await gateMutation(
    { id: 'c3', gen: 1, price_usd: 0.03, niche: 'hn', stake_usd: 0.25 },
    solventParents,
  );
  if (badDelta.approved) throw new Error('SELF_TEST FAIL: over-delta child approved');

  const badNiche = await gateMutation(
    { id: 'c4', gen: 1, price_usd: 0.003, niche: 'forbidden-topic', stake_usd: 0.25 },
    solventParents,
  );
  if (badNiche.approved) throw new Error('SELF_TEST FAIL: off-allowlist niche approved');

  const unknownSolvency = await gateMutation(
    { id: 'c5', gen: 1, price_usd: 0.003, niche: 'hn', stake_usd: 0.25 },
    [{ id: 'p3', price_usd: 0.003 }],
  );
  if (unknownSolvency.approved) throw new Error('SELF_TEST FAIL: unknown solvency should fail closed');

  const insolvent = await gateMutation(
    { id: 'c6', gen: 1, price_usd: 0.003, niche: 'hn', stake_usd: 0.25 },
    [{ id: 'p4', price_usd: 0.003, bankroll_usd: 0 }],
  );
  if (insolvent.approved) throw new Error('SELF_TEST FAIL: insolvent parent approved');

  // spend cap: only c1 was approved above (0.25); an 8.0 stake must blow the 2.0 cap
  const bigStake = await gateMutation(
    { id: 'c7', gen: 1, price_usd: 0.003, niche: 'hn', stake_usd: 8.0 },
    solventParents,
  );
  if (bigStake.approved) throw new Error('SELF_TEST FAIL: spend cap not enforced');

  const lines = countLines(governanceFile());
  if (lines < 7) throw new Error(`SELF_TEST FAIL: expected >=7 governance lines, got ${lines}`);
  console.log('SELF_TEST OK guild.js (7 decisions ->', governanceFile(), ')');
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}
