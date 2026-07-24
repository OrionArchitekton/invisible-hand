// src/mesh/band.js
// Coordination mesh client for BAND (docs.band.ai).
//
// Live mode (BAND_API_KEY set): posts market events into a BAND chat room via the
// Agent REST API (base https://app.band.ai, auth header X-API-Key). Verified shape
// from docs.band.ai/openapi.json (2026-07-24):
//   POST /api/v1/agent/chats                       {chat:{title}}            -> room
//   POST /api/v1/agent/chats/{id}/events           {event:{content, message_type, metadata}}
//   POST /api/v1/agent/chats/{id}/messages         {message:{content, mentions:[{handle}]}}
// BAND event message_type enum: tool_call | tool_result | thought | error | task | attention.
// Our honest domain event types (announce/buy_order/settlement/bankruptcy/breeding)
// ride in metadata.type; the BAND message_type is a mapped envelope.
//
// Local mode (no key): identical event objects append to data/mesh.jsonl only,
// logged as [mesh:local]. The JSONL file is ALWAYS written, live or local, so the
// dashboard tails one file either way. Live delivery is additive, never faked.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BAND_API_URL = (process.env.BAND_API_URL || 'https://app.band.ai').replace(/\/+$/, '');
const ROOM_TITLE = process.env.BAND_ROOM_TITLE || 'Invisible Hand Market';
const HTTP_TIMEOUT_MS = 8000;

// Honest domain event types the room/audit feed carries.
export const EVENT_TYPES = ['announce', 'buy_order', 'settlement', 'bankruptcy', 'breeding'];

// Domain type -> BAND ChatEventMessageType envelope.
const BAND_TYPE_MAP = {
  announce: 'task',
  buy_order: 'task',
  settlement: 'tool_result',
  bankruptcy: 'error',
  breeding: 'task',
};

function dataDir() {
  return process.env.IH_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}
export function meshFile() {
  return path.join(dataDir(), 'mesh.jsonl');
}
function roomCacheFile() {
  return path.join(dataDir(), 'band-room.json');
}

export function isLive() {
  return Boolean(process.env.BAND_API_KEY) && !process.env.MESH_FORCE_LOCAL;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function summarize(event) {
  const bits = [event.type];
  if (event.variant_id) bits.push(event.variant_id);
  if (event.seller_id) bits.push('seller=' + event.seller_id);
  if (event.child_id) bits.push('child=' + event.child_id);
  if (Number.isFinite(event.price_usd)) bits.push('$' + event.price_usd);
  return bits.join(' ');
}

function agentsFile() {
  return path.join(dataDir(), 'band-agents.json');
}

const AGENT_ROLES = {
  'ih-market': 'Invisible Hand market herald: announces variants, settlements, bankruptcies, breeding',
  'ih-buyer': 'Invisible Hand buyer fleet: posts buy orders into the market room and pays sellers via x402',
};
const cachedAgentKeys = new Map();

// BAND auth model (live-verified 07-24): BAND_API_KEY is a HUMAN key, valid only on
// /api/v1/me/*. Agent endpoints (/api/v1/agent/*) require a per-agent key minted via
// POST /api/v1/me/agents/register (key returned exactly once). We mint one agent per
// ROLE (market herald + buyer), persist them in data/band-agents.json (gitignored),
// and reuse them, so the room shows a real two-identity exchange.
async function ensureAgentKey(name = 'ih-market') {
  if (cachedAgentKeys.has(name)) return cachedAgentKeys.get(name);
  let store = { agents: {} };
  try { store = JSON.parse(fs.readFileSync(agentsFile(), 'utf8')); } catch { /* fresh */ }
  const existing = store.agents && (store.agents[name] || (name === 'ih-market' ? store.agents['ih-probe'] : null));
  if (existing && existing.api_key) {
    cachedAgentKeys.set(name, existing.api_key);
    return existing.api_key;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(BAND_API_URL + '/api/v1/me/agents/register', {
      method: 'POST',
      headers: { 'X-API-Key': process.env.BAND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: { name, description: AGENT_ROLES[name] || 'Invisible Hand agent' } }),
      signal: ctl.signal,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`BAND agent mint (${name}) -> HTTP ${res.status}`);
    const key = json && json.data && json.data.credentials && json.data.credentials.api_key;
    const agentObj = json && json.data && json.data.agent;
    if (!key) throw new Error('BAND agent mint returned no api_key');
    store.agents = store.agents || {};
    store.agents[name] = { id: agentObj && agentObj.id, handle: agentObj && agentObj.handle, api_key: key };
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(agentsFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
    cachedAgentKeys.set(name, key);
    return key;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve an agent's BAND identity {id, handle} from the persisted store. The
// register response omits the handle, so we also learn it from the room's
// participant list (cached back into the store by ensureParticipants).
function agentIdentity(name) {
  try {
    const store = JSON.parse(fs.readFileSync(agentsFile(), 'utf8'));
    const a = store.agents && store.agents[name];
    if (a && a.id) return { id: a.id, handle: a.handle || name };
  } catch { /* fall through */ }
  return { id: null, handle: name };
}

// The herald identity is whichever agent actually holds the herald key
// (ih-market if minted, else the ih-probe fallback that owns the room).
function heraldIdentity() {
  const m = agentIdentity('ih-market');
  if (m.id) return m;
  return agentIdentity('ih-probe');
}

function agentId(name) {
  try {
    const store = JSON.parse(fs.readFileSync(agentsFile(), 'utf8'));
    return (store.agents && store.agents[name] && store.agents[name].id) || null;
  } catch {
    return null;
  }
}

// The room is

async function bandRequest(method, apiPath, body, { agentName = 'ih-market' } = {}) {
  const key = apiPath.startsWith('/api/v1/me/')
    ? process.env.BAND_API_KEY
    : await ensureAgentKey(agentName);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(BAND_API_URL + apiPath, {
      method,
      headers: {
        'X-API-Key': key,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error(`BAND ${method} ${apiPath} -> HTTP ${res.status}`);
      err.status = res.status;
      err.body = json ?? text.slice(0, 300);
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

let cachedRoomId = null;

// Resolve the market room: BAND_ROOM_ID env > data/band-room.json cache > create one.
export async function ensureRoom() {
  if (process.env.BAND_ROOM_ID) return process.env.BAND_ROOM_ID;
  if (cachedRoomId) return cachedRoomId;
  try {
    const cached = JSON.parse(fs.readFileSync(roomCacheFile(), 'utf8'));
    if (cached && cached.chat_id) {
      cachedRoomId = cached.chat_id;
      await ensureParticipants(cachedRoomId);
      return cachedRoomId;
    }
  } catch { /* no cache yet */ }
  const created = await bandRequest('POST', '/api/v1/agent/chats', {
    chat: { title: ROOM_TITLE },
  });
  const chat = created && (created.chat || created.data || created);
  const id = chat && (chat.id || chat.chat_id);
  if (!id) throw new Error('BAND room create returned no id');
  cachedRoomId = id;
  appendRoomCache(id);
  await ensureParticipants(id);
  return id;
}

// Add both role agents to the room so the buyer's @mention and the herald's
// reply are real participant messages (BAND 404/422s messages to non-members).
// Best-effort and idempotent: an already-present agent just no-ops.
let participantsJoined = false;
async function ensureParticipants(chatId) {
  if (participantsJoined) return;
  // Mint the buyer identity so there are two distinct agents in the room.
  await ensureAgentKey('ih-buyer').catch(() => null);
  let store = { agents: {} };
  try { store = JSON.parse(fs.readFileSync(agentsFile(), 'utf8')); } catch { /* fresh */ }
  for (const name of ['ih-market', 'ih-buyer']) {
    const id = store.agents && store.agents[name] && store.agents[name].id;
    if (!id) continue;
    try {
      await bandRequest('POST', `/api/v1/agent/chats/${chatId}/participants`,
        { participant: { participant_id: id, role: 'member' } });
    } catch (err) {
      if (err.status !== 409 && err.status !== 422) {
        console.warn(`[mesh] add participant ${name} failed: ${err.message}`);
      }
    }
  }
  // Learn real handles from the participant list and cache them back so
  // @mentions carry a resolvable {id, handle} (BAND 422s a handle-only mention).
  try {
    const list = await bandRequest('GET', `/api/v1/agent/chats/${chatId}/participants`);
    const rows = (list && (list.data || list.participants)) || [];
    const byId = new Map(rows.map((p) => [p.id, p.handle]));
    let changed = false;
    for (const [name, a] of Object.entries(store.agents || {})) {
      if (a && a.id && byId.has(a.id) && a.handle !== byId.get(a.id)) {
        a.handle = byId.get(a.id);
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(agentsFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn(`[mesh] participant handle sync failed: ${err.message}`);
  }
  participantsJoined = true;
}

function appendRoomCache(id) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(roomCacheFile(), JSON.stringify({ chat_id: id, title: ROOM_TITLE }) + '\n');
  } catch (err) {
    console.warn('[mesh] could not cache BAND room id:', err.message);
  }
}

function toBandEvent(record) {
  // BAND caps: content 16384 chars, metadata 65536 serialized bytes.
  let metadata = record;
  if (JSON.stringify(metadata).length > 60000) {
    metadata = { type: record.type, ts: record.ts, truncated: true };
  }
  return {
    content: summarize(record).slice(0, 16000),
    message_type: BAND_TYPE_MAP[record.type] || 'task',
    metadata,
  };
}

// Core emit: append the event to data/mesh.jsonl (always), then deliver to the
// BAND room when live. Returns the recorded event object.
export async function emit(event) {
  if (!event || typeof event.type !== 'string' || !event.type) {
    throw new Error('emit(event) requires an event object with a string type');
  }
  if (!EVENT_TYPES.includes(event.type)) {
    console.warn(`[mesh] non-standard event type "${event.type}" (known: ${EVENT_TYPES.join(', ')})`);
  }
  const record = {
    ts: new Date().toISOString(),
    mode: isLive() ? 'live' : 'local',
    ...event,
  };
  appendJsonl(meshFile(), record);
  if (!isLive()) {
    console.log('[mesh:local]', summarize(record));
    return record;
  }
  try {
    const chatId = await ensureRoom();
    // Settlements answer the buyer's @mention as a herald MESSAGE, completing
    // the visible two-agent exchange; other types stay audit events.
    if (record.type === 'settlement') {
      // Herald answers the buyer: an @mention message back to ih-buyer closes
      // the two-agent exchange (buyer requested, herald reports the sale).
      const buyer = agentIdentity('ih-buyer');
      if (buyer.id) {
        try {
          await bandRequest('POST', `/api/v1/agent/chats/${chatId}/messages`, {
            message: {
              content: `@${buyer.handle} settlement: ${record.variant_id} sold extraction for $${record.price_usd}${record.tx_hash ? ` (tx ${record.tx_hash})` : ''}`,
              mentions: [{ id: buyer.id, handle: buyer.handle }],
            },
          }, { agentName: 'ih-market' });
          console.log('[mesh:live]', summarize(record), '(as ih-market reply to buyer)');
          return record;
        } catch (err) {
          console.warn(`[mesh] herald settlement message failed (${err.message}); posting as event`);
        }
      }
    }
    await bandRequest('POST', `/api/v1/agent/chats/${chatId}/events`, {
      event: toBandEvent(record),
    });
    console.log('[mesh:live]', summarize(record));
  } catch (err) {
    console.warn(`[mesh] BAND delivery failed (event kept in mesh.jsonl): ${err.message}`);
  }
  return record;
}

// Announce a variant (new listing or bred child) to the mesh.
export async function announce(variant) {
  if (!variant || !variant.id) throw new Error('announce(variant) requires variant.id');
  return emit({
    type: 'announce',
    variant_id: variant.id,
    handle: variant.handle || `variant-${variant.id}`,
    gen: variant.gen ?? 0,
    parent_ids: variant.parent_ids || [],
    price_usd: variant.price_usd,
    model: variant.model,
    niche: variant.niche,
    prompt_variant: variant.prompt_variant,
    endpoint: variant.endpoint || `/v/${variant.id}/extract`,
  });
}

// Post a buy order. In live mode, when the task names a seller handle that is a
// real BAND room participant, we first try a true @mention MESSAGE (that is what
// routes/triggers agents on BAND); if the handle does not resolve (422) or the
// message post fails, we fall back to the event feed. The JSONL record is written
// first either way.
export async function buyOrder(task) {
  if (!task) throw new Error('buyOrder(task) requires a task object');
  const sellerHandle = task.seller_handle || task.mention || null;
  const record = {
    ts: new Date().toISOString(),
    mode: isLive() ? 'live' : 'local',
    type: 'buy_order',
    task_id: task.id ?? task.task_id ?? null,
    url: task.url ?? null,
    niche: task.niche ?? null,
    seller_id: task.seller_id ?? null,
    seller_handle: sellerHandle,
    price_usd: task.price_usd,
  };
  appendJsonl(meshFile(), record);
  if (!isLive()) {
    console.log('[mesh:local]', summarize(record));
    return record;
  }
  try {
    const chatId = await ensureRoom();
    let delivered = false;
    // Two-identity exchange: the BUYER agent posts the order as a real
    // @mention message to the market herald (mention carries {id, handle} so
    // BAND can resolve it); the herald answers with the settlement. Any
    // failure falls back to the herald's event feed.
    const herald = heraldIdentity();
    try {
      await bandRequest('POST', `/api/v1/agent/chats/${chatId}/messages`, {
        message: {
          content: `@${herald.handle} buy order: extract ${record.url || 'task'} from ${record.seller_id || 'a seller'} at $${record.price_usd}`,
          mentions: [{ id: herald.id, handle: herald.handle }],
        },
      }, { agentName: 'ih-buyer' });
      delivered = true;
      console.log('[mesh:live]', summarize(record), '(as ih-buyer @mention message)');
    } catch (err) {
      console.warn(`[mesh] buyer @mention failed (${err.message}); posting as herald event`);
    }
    if (!delivered) {
      await bandRequest('POST', `/api/v1/agent/chats/${chatId}/events`, {
        event: toBandEvent(record),
      });
      console.log('[mesh:live]', summarize(record));
    }
  } catch (err) {
    console.warn(`[mesh] BAND delivery failed (event kept in mesh.jsonl): ${err.message}`);
  }
  return record;
}

// Inline self-test: SELF_TEST=1 node src/mesh/band.js  (forces local mode; set
// IH_DATA_DIR to keep the real data plane clean).
if (process.env.SELF_TEST) {
  process.env.MESH_FORCE_LOCAL = '1';
  if (!process.env.IH_DATA_DIR) {
    const os = await import('node:os');
    process.env.IH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-mesh-'));
  }
  const before = countLines(meshFile());
  await announce({ id: 'v-test-1', gen: 0, price_usd: 0.002, model: 'test/model', niche: 'hn' });
  await buyOrder({ id: 't-1', url: 'https://example.com/a', seller_id: 'v-test-1', price_usd: 0.002 });
  await emit({ type: 'settlement', variant_id: 'v-test-1', price_usd: 0.002, tx_hash: '0xtest' });
  await emit({ type: 'bankruptcy', variant_id: 'v-test-1', reason: 'bankroll exhausted' });
  await emit({ type: 'breeding', child_id: 'v-test-2', parent_ids: ['v-test-1'] });
  const after = countLines(meshFile());
  if (after - before !== 5) throw new Error(`SELF_TEST FAIL: expected 5 new lines, got ${after - before}`);
  const lines = fs.readFileSync(meshFile(), 'utf8').trim().split('\n').slice(-5).map((l) => JSON.parse(l));
  const types = lines.map((l) => l.type);
  const expected = ['announce', 'buy_order', 'settlement', 'bankruptcy', 'breeding'];
  if (JSON.stringify(types) !== JSON.stringify(expected)) {
    throw new Error(`SELF_TEST FAIL: types ${types.join(',')}`);
  }
  console.log('SELF_TEST OK band.js (local mode, 5 events ->', meshFile(), ')');
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}
