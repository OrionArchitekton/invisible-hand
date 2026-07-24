// src/memory/actian.js
// Actian VectorAI DB client (REST, port 6573). Collections: genomes, estates, failures.
//
// HONESTY NOTES:
// - The official hackathon guide (gerimate.github.io/vectorai-agent-swarm-hacks)
//   documents a Python client whose surface (collections/points, VectorParams,
//   Distance.Cosine, PointStruct, points.upsert/search, PayloadSchema, scroll,
//   "search/groups not implemented") is the Qdrant-compatible API. We speak that
//   REST dialect directly on port 6573. A live container was NOT reachable at
//   build time (probe timed out), so the shape is coded to the documented surface
//   with a startup backoff for ENGINE_NOT_INITIALIZED (their guide's own gotcha).
//   Run SELF_TEST with a live container to confirm end to end.
// - Embeddings here are a DETERMINISTIC HASH EMBEDDING (token buckets, L2
//   normalized). It is not a semantic model like all-MiniLM; texts sharing tokens
//   land near each other, which is what our failure-cluster grouping needs.
//   Documented honestly per contract: working beats fancy.
// - If the server stays unreachable, we fall back to LOCAL MODE: in-memory store
//   with JSONL persistence at data/actian-local.jsonl, labeled honestly in logs
//   and in status(). Never faked as a live integration.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";

export const COLLECTIONS = ["genomes", "estates", "failures"];
export const EMBED_DIM = 64;

const DATA_DIR = new URL("../../data/", import.meta.url);
const LOCAL_FILE = new URL("actian-local.jsonl", DATA_DIR);

// Deterministic hash embedding: tokenize, hash each token into one of EMBED_DIM
// buckets (with a signed contribution), then L2 normalize. Deterministic and
// dependency free. NOT semantic; documented as such above.
export function hashEmbed(text, dim = EMBED_DIM) {
  const vec = new Array(dim).fill(0);
  const tokens = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    const h = createHash("sha1").update(tok).digest();
    const idx = ((h[0] << 8) | h[1]) % dim;
    const sign = h[2] % 2 === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are already L2 normalized
}

// Qdrant point ids must be unsigned ints or UUIDs; derive a stable UUID from a
// string id so re-upserts of the same genome/estate overwrite instead of duping.
export function uuidFromString(s) {
  const h = createHash("sha1").update(String(s)).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join("-");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createActian(opts = {}) {
  const baseUrl = (opts.baseUrl || process.env.ACTIAN_URL || "http://localhost:6573").replace(/\/$/, "");
  const dim = opts.dim || EMBED_DIM;
  const fetchImpl = opts.fetchImpl || fetch;
  const persistLocal = opts.persistLocal !== false;
  const maxRetries = opts.maxRetries ?? 4;

  let mode = opts.forceLocal ? "local" : "unknown"; // unknown -> live | local
  let warned = false;
  // Write-through mirror: everything we write also lands here, so retrieval
  // (failure clusters) keeps working even if the server dies mid-demo.
  const mirror = { genomes: [], estates: [], failures: [] };

  function localAppend(collection, point) {
    mirror[collection].push(point);
    if (!persistLocal) return;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(LOCAL_FILE, JSON.stringify({ collection, ...point }) + "\n");
    } catch (err) {
      console.warn(`[actian] local persist failed: ${err.message}`);
    }
  }

  function goLocal(reason) {
    if (mode !== "local" && !warned) {
      console.warn(`[actian] LOCAL MODE: VectorAI server unreachable (${reason}). ` +
        "Storing vectors in-process + data/actian-local.jsonl. This is NOT a live Actian integration until the container is up.");
      warned = true;
    }
    mode = "local";
  }

  // REST request with backoff for ENGINE_NOT_INITIALIZED (documented startup
  // gotcha) and 5xx. Connection failure after retries flips to local mode.
  async function request(method, path, body) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchImpl(baseUrl + path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(4000),
        });
        const text = await res.text();
        let json;
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        if (!res.ok) {
          const msg = JSON.stringify(json).slice(0, 300);
          if (/ENGINE_NOT_INITIALIZED/i.test(msg) || res.status >= 500) {
            lastErr = new Error(`http ${res.status}: ${msg}`);
            await sleep(250 * 2 ** attempt);
            continue;
          }
          throw new Error(`http ${res.status}: ${msg}`);
        }
        return json;
      } catch (err) {
        lastErr = err;
        if (err.name === "TimeoutError" || err.cause?.code === "ECONNREFUSED" ||
            err.cause?.code === "ETIMEDOUT" || /fetch failed/i.test(err.message)) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error("actian request failed");
  }

  async function ensureReady() {
    if (mode === "local") return { mode };
    try {
      for (const name of COLLECTIONS) {
        const existing = await request("GET", `/collections/${name}`).catch(() => null);
        if (!existing) {
          await request("PUT", `/collections/${name}`, {
            vectors: { size: dim, distance: "Cosine" },
          });
        }
      }
      mode = "live";
    } catch (err) {
      goLocal(err.message);
    }
    return { mode };
  }

  async function upsertPoint(collection, id, text, payload) {
    const point = { id: uuidFromString(id), vector: hashEmbed(text, dim), payload };
    localAppend(collection, point); // write-through mirror always
    if (mode === "unknown") await ensureReady();
    if (mode !== "live") return { mode, id: point.id };
    try {
      await request("PUT", `/collections/${collection}/points?wait=true`, { points: [point] });
      return { mode: "live", id: point.id };
    } catch (err) {
      goLocal(err.message);
      return { mode, id: point.id };
    }
  }

  async function search(collection, queryText, { limit = 10 } = {}) {
    if (mode === "unknown") await ensureReady();
    const qvec = hashEmbed(queryText, dim);
    if (mode === "live") {
      try {
        const res = await request("POST", `/collections/${collection}/points/search`, {
          vector: qvec,
          limit,
          with_payload: true,
        });
        const rows = res?.result || res?.points || [];
        return rows.map((r) => ({ id: r.id, score: r.score, payload: r.payload }));
      } catch (err) {
        goLocal(err.message);
      }
    }
    return mirror[collection]
      .map((p) => ({ id: p.id, score: cosine(qvec, p.vector), payload: p.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // --- domain API ---------------------------------------------------------

  async function upsertGenome(genome) {
    const text = `${genome.model} ${genome.niche} ${genome.prompt_variant}`;
    return upsertPoint("genomes", `genome:${genome.id}`, text, { kind: "genome", ...genome });
  }

  async function writeEstate(estate) {
    const text = `estate ${estate.variant_id} ${estate.cause || ""} pnl ${estate.final_pnl}`;
    return upsertPoint("estates", `estate:${estate.variant_id}`, text, { kind: "estate", ...estate });
  }

  async function recordFailure(failure) {
    const id = failure.id || randomUUID();
    const text = `${failure.reason || ""} ${failure.detail || ""}`;
    return upsertPoint("failures", `failure:${id}`, text, {
      kind: "failure",
      variant_id: failure.variant_id,
      reason: failure.reason,
      detail: failure.detail || "",
      task_url: failure.task_url || "",
      ts: failure.ts || new Date().toISOString(),
    });
  }

  // Ingest buyers/verify.js output (data/failures.jsonl) into the failures
  // collection. Tracks how many lines were already ingested; safe to re-call.
  let ingestedLines = 0;
  async function ingestFailuresFile(path = new URL("failures.jsonl", DATA_DIR)) {
    try {
      if (!existsSync(path)) return { ingested: 0 };
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const fresh = lines.slice(ingestedLines);
      let ok = 0;
      for (const line of fresh) {
        try {
          const f = JSON.parse(line);
          await recordFailure({
            variant_id: f.variant_id || f.seller_id || f.id,
            reason: (f.reasons && f.reasons.join("; ")) || f.reason || "unverified output",
            detail: f.detail || "",
            task_url: f.task_url || f.url || "",
            ts: f.ts,
          });
          ok++;
        } catch { /* skip malformed line */ }
      }
      ingestedLines = lines.length;
      return { ingested: ok };
    } catch (err) {
      console.warn(`[actian] ingestFailuresFile failed: ${err.message}`);
      return { ingested: 0, error: err.message };
    }
  }

  // Failure clusters for a set of variants (the breeding parents): retrieve
  // their failures, group by normalized reason, return the top clusters as
  // human-readable strings for prompt injection (inherited immunity).
  async function getFailureClusters(variantIds, { limit = 4 } = {}) {
    await ingestFailuresFile().catch(() => {});
    const idSet = new Set(variantIds);
    let rows = [];
    if (mode !== "local") {
      // Search per variant id keeps us on the plain search endpoint (grouped
      // search is documented as NOT implemented server-side).
      for (const vid of variantIds) {
        const hits = await search("failures", `failure ${vid}`, { limit: 50 }).catch(() => []);
        rows.push(...hits);
      }
    }
    if (rows.length === 0) {
      rows = mirror.failures.map((p) => ({ id: p.id, score: 1, payload: p.payload }));
    }
    const counts = new Map();
    for (const r of rows) {
      const p = r.payload || {};
      if (p.kind !== "failure" || !idSet.has(p.variant_id)) continue;
      const key = String(p.reason || "unknown").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim().slice(0, 120);
      if (!key) continue;
      const cur = counts.get(key) || { reason: p.reason, n: 0 };
      cur.n++;
      counts.set(key, cur);
    }
    return [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, limit)
      .map((c) => `${c.reason} (seen ${c.n}x)`);
  }

  function status() {
    return {
      mode: mode === "unknown" ? "unprobed" : mode,
      baseUrl,
      dim,
      counts: Object.fromEntries(COLLECTIONS.map((c) => [c, mirror[c].length])),
      note: mode === "local"
        ? "LOCAL MODE: honest fallback store, not a live Actian server"
        : "live = Actian VectorAI REST on " + baseUrl,
    };
  }

  return {
    ensureReady, upsertGenome, writeEstate, recordFailure,
    ingestFailuresFile, getFailureClusters, search, status,
    hashEmbed: (t) => hashEmbed(t, dim),
  };
}

// Default shared client for module consumers (engine.js, run-market.js).
let defaultClient = null;
export function getActian() {
  if (!defaultClient) defaultClient = createActian();
  return defaultClient;
}

// ---------------------------------------------------------------------------
if (process.env.SELF_TEST) {
  const assert = (cond, msg) => {
    if (!cond) { console.error("SELF_TEST FAIL:", msg); process.exit(1); }
  };
  // Embedding invariants.
  const e1 = hashEmbed("dropped source_url on claims");
  const e2 = hashEmbed("dropped source_url on claims");
  const e3 = hashEmbed("completely different topic about pelicans");
  assert(JSON.stringify(e1) === JSON.stringify(e2), "hashEmbed deterministic");
  assert(Math.abs(Math.sqrt(e1.reduce((s, v) => s + v * v, 0)) - 1) < 1e-9, "hashEmbed L2 normalized");
  assert(cosine(e1, e2) > cosine(e1, e3), "similar text scores higher than dissimilar");

  // Local-mode roundtrip (no server needed, no disk writes).
  const a = createActian({ forceLocal: true, persistLocal: false });
  await a.upsertGenome({ id: "vTest", model: "Pioneer/Auto", niche: "ai", prompt_variant: "extract claims with source_url", gen: 0 });
  await a.recordFailure({ variant_id: "vTest", reason: "missing source_url" });
  await a.recordFailure({ variant_id: "vTest", reason: "missing source_url" });
  await a.recordFailure({ variant_id: "vTest", reason: "hallucinated numbers" });
  await a.recordFailure({ variant_id: "OTHER", reason: "should not appear" });
  const clusters = await a.getFailureClusters(["vTest"]);
  assert(clusters.length === 2, `two clusters for vTest, got ${JSON.stringify(clusters)}`);
  assert(/missing source_url \(seen 2x\)/.test(clusters[0]), "top cluster ranked by frequency");
  await a.writeEstate({ variant_id: "vTest", final_pnl: -0.25, cause: "insolvent" });
  const st = a.status();
  assert(st.mode === "local" && st.counts.failures === 4, "status reflects local mode + counts");
  console.log("actian.js SELF_TEST OK (local mode):", st, "clusters:", clusters);
  console.log("NOTE: run again with the VectorAI container up to exercise live REST mode.");
}
