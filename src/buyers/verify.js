// src/buyers/verify.js
// Adversarial verification of seller output. Buyers are verifiers, not praise bots.
// Contract (ARCHITECTURE.md): schema = {claims:[{text, source_url, confidence}]};
// Gemini cross-check (model gemini-flash-latest, url_context tool when available,
// else fetch the page text ourselves) -> {verified, reasons[]}.
// Claim-level failures also append to data/failures.jsonl for Actian clustering.
//
// Honesty bar: no GEMINI_API_KEY means LOCAL MODE (lexical support heuristic against
// the fetched page), labeled as such in every reason string. Never faked as Gemini.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const FAILURES_PATH = path.join(DATA_DIR, "failures.jsonl");

// gemini-3.1-flash (stale alias) 404s on v1beta generateContent (verified 2026-07-24);
// gemini-flash-latest is the live stable-flash alias from ListModels.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const FETCH_TIMEOUT_MS = Number(process.env.VERIFY_FETCH_TIMEOUT_MS || 20000);
const MAX_PAGE_CHARS = 15000;
const MAX_CLAIMS_CHECKED = 20;

// ---------- schema ----------

export function validateSchema(payload) {
  const errors = [];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload is not an object"] };
  }
  if (!Array.isArray(payload.claims)) {
    return { ok: false, errors: ["payload.claims is not an array"] };
  }
  payload.claims.forEach((c, i) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      errors.push(`claims[${i}] is not an object`);
      return;
    }
    if (typeof c.text !== "string" || c.text.trim().length === 0) {
      errors.push(`claims[${i}].text missing or empty`);
    }
    if (typeof c.source_url !== "string" || c.source_url.trim().length === 0) {
      errors.push(`claims[${i}].source_url missing or empty`);
    }
    if (typeof c.confidence !== "number" || Number.isNaN(c.confidence) || c.confidence < 0 || c.confidence > 1) {
      errors.push(`claims[${i}].confidence not a number in [0,1]`);
    }
  });
  return { ok: errors.length === 0, errors };
}

// ---------- failure log ----------

function appendFailure(entry) {
  if (process.env.SELF_TEST) return; // keep the real data plane clean during self-tests
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(FAILURES_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("[verify] failed to append failures.jsonl:", err.message);
  }
}

// ---------- page fetch + text extraction ----------

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchPageText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "invisible-hand-verifier/1.0 (adversarial buyer fleet)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`page fetch ${res.status} for ${url}`);
  const raw = await res.text();
  return htmlToText(raw).slice(0, MAX_PAGE_CHARS);
}

// ---------- local (keyless) heuristic ----------

const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "will", "been", "were", "they",
  "their", "there", "which", "about", "into", "more", "than", "when", "what",
  "also", "some", "such", "only", "over", "after", "before", "because",
]);

function tokens(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

export function localSupportCheck(claimText, pageText) {
  const claimToks = [...new Set(tokens(claimText))];
  if (claimToks.length === 0) return { supported: false, ratio: 0 };
  const pageToks = new Set(tokens(pageText));
  const hit = claimToks.filter((t) => pageToks.has(t)).length;
  const ratio = hit / claimToks.length;
  return { supported: ratio >= 0.6 && hit >= 2, ratio: Number(ratio.toFixed(2)) };
}

// ---------- Gemini cross-check ----------

function verdictPrompt(claims, sourceUrl, pageText) {
  const list = claims
    .slice(0, MAX_CLAIMS_CHECKED)
    .map((c, i) => `${i}. ${c.text}`)
    .join("\n");
  const source = pageText
    ? `SOURCE PAGE TEXT (extracted from ${sourceUrl}):\n"""\n${pageText}\n"""`
    : `SOURCE URL: ${sourceUrl}\nUse the url context tool to read the source page.`;
  return [
    "You are an adversarial fact verifier in an agent marketplace. Sellers get paid",
    "for extraction claims; your job is to catch unsupported or fabricated claims.",
    "Be strict: a claim is supported ONLY if the source content directly backs it.",
    "",
    source,
    "",
    "CLAIMS:",
    list,
    "",
    'Reply with ONLY a JSON array, one entry per claim, shaped like:',
    '[{"index": 0, "verdict": "supported", "reason": "short reason"}, ...]',
    'verdict must be exactly "supported" or "unsupported".',
  ].join("\n");
}

function extractJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON array in model reply");
  return JSON.parse(text.slice(start, end + 1));
}

async function geminiCall(body) {
  const res = await fetch(GEMINI_URL(GEMINI_MODEL), {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`gemini: ${msg}`);
    err.status = res.status;
    throw err;
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

async function geminiVerdicts(claims, sourceUrl) {
  // Attempt 1: url_context tool, Gemini fetches the page itself.
  try {
    const text = await geminiCall({
      contents: [{ role: "user", parts: [{ text: verdictPrompt(claims, sourceUrl, null) }] }],
      tools: [{ url_context: {} }],
    });
    return { verdicts: extractJsonArray(text), via: "gemini+url_context" };
  } catch (err) {
    console.error(`[verify] url_context path failed (${err.message}); falling back to manual page fetch`);
  }
  // Attempt 2: we fetch the page text ourselves and inline it.
  const pageText = await fetchPageText(sourceUrl);
  const text = await geminiCall({
    contents: [{ role: "user", parts: [{ text: verdictPrompt(claims, sourceUrl, pageText) }] }],
    generationConfig: { responseMimeType: "application/json" },
  });
  return { verdicts: extractJsonArray(text), via: "gemini+manual_fetch" };
}

// ---------- main entry ----------

/**
 * Adversarially verify a seller payload.
 * @param {object} payload seller response, expected {claims:[{text, source_url, confidence}]}
 * @param {object} ctx {url, text?, variant_id?} the task the buyer paid for.
 *   ctx.text, when present, is used as source content (no network; used by self-test).
 * @returns {Promise<{verified: boolean, reasons: string[], mode: string, infra_error?: boolean}>}
 *   infra_error true means OUR verification infra failed; callers must not credit
 *   the seller as verified, but should not hard-punish them either.
 */
export async function verify(payload, ctx = {}) {
  const reasons = [];
  const variantId = ctx.variant_id || "unknown";
  const taskUrl = ctx.url || null;

  const schema = validateSchema(payload);
  if (!schema.ok) {
    schema.errors.forEach((e) => reasons.push(`schema: ${e}`));
    appendFailure({
      ts: new Date().toISOString(),
      variant_id: variantId,
      task_url: taskUrl,
      claim: "(schema invalid)",
      reason: schema.errors.join("; "),
      mode: "schema",
    });
    return { verified: false, reasons, mode: "schema" };
  }
  if (payload.claims.length === 0) {
    reasons.push("empty claims array: paid for nothing");
    appendFailure({
      ts: new Date().toISOString(),
      variant_id: variantId,
      task_url: taskUrl,
      claim: "(no claims returned)",
      reason: "empty claims array",
      mode: "schema",
    });
    return { verified: false, reasons, mode: "schema" };
  }

  const claims = payload.claims.slice(0, MAX_CLAIMS_CHECKED);
  const sourceUrl = taskUrl || claims[0].source_url;

  // Path A: Gemini cross-check (live mode).
  if (process.env.GEMINI_API_KEY && !ctx.text) {
    try {
      const { verdicts, via } = await geminiVerdicts(claims, sourceUrl);
      const failed = [];
      claims.forEach((c, i) => {
        const v = verdicts.find((x) => Number(x.index) === i);
        if (!v || String(v.verdict).toLowerCase() !== "supported") {
          failed.push({ claim: c, reason: v?.reason || "no verdict returned for claim" });
        }
      });
      for (const f of failed) {
        reasons.push(`claim unsupported (${via}): "${f.claim.text.slice(0, 120)}" (${f.reason})`);
        appendFailure({
          ts: new Date().toISOString(),
          variant_id: variantId,
          task_url: taskUrl,
          claim: f.claim.text,
          reason: f.reason,
          mode: via,
        });
      }
      if (failed.length === 0) reasons.push(`all ${claims.length} claims supported (${via})`);
      return { verified: failed.length === 0, reasons, mode: via };
    } catch (err) {
      reasons.push(`verification infra error: ${err.message}`);
      // fall through to local heuristic as best-effort backstop
    }
  }

  // Path B: LOCAL MODE. Keyless lexical heuristic, honestly labeled.
  try {
    const pageText = ctx.text || (await fetchPageText(sourceUrl));
    const mode = "local_heuristic";
    const failed = [];
    for (const c of claims) {
      const { supported, ratio } = localSupportCheck(c.text, pageText);
      if (!supported) failed.push({ claim: c, ratio });
    }
    for (const f of failed) {
      reasons.push(
        `local mode heuristic (no Gemini): claim lexical support ${f.ratio} below bar: "${f.claim.text.slice(0, 120)}"`
      );
      appendFailure({
        ts: new Date().toISOString(),
        variant_id: variantId,
        task_url: taskUrl,
        claim: f.claim.text,
        reason: `lexical support ratio ${f.ratio}`,
        mode,
      });
    }
    if (failed.length === 0) {
      reasons.push(`local mode heuristic (no Gemini): all ${claims.length} claims lexically supported`);
    }
    return { verified: failed.length === 0, reasons, mode };
  } catch (err) {
    reasons.push(`verification unavailable: ${err.message}`);
    return { verified: false, reasons, mode: "unavailable", infra_error: true };
  }
}

// ---------- self-test ----------

if (process.env.SELF_TEST) {
  const assert = (cond, label) => {
    if (!cond) {
      console.error(`SELF_TEST FAIL: ${label}`);
      process.exitCode = 1;
    } else {
      console.log(`SELF_TEST ok: ${label}`);
    }
  };

  const bad = validateSchema({ claims: [{ text: "", source_url: "x", confidence: 2 }] });
  assert(!bad.ok && bad.errors.length === 2, "schema rejects empty text + out of range confidence");
  assert(validateSchema({ claims: [] }).ok, "schema accepts empty claims array (verify rejects it later)");
  assert(!validateSchema({}).ok, "schema rejects missing claims");

  const page = "The Rust compiler team released version 2.0 with faster incremental builds today.";
  const good = localSupportCheck("Rust compiler version 2.0 released with faster incremental builds", page);
  assert(good.supported, "local heuristic supports grounded claim");
  const fab = localSupportCheck("Python foundation bankruptcy announcement shocks markets", page);
  assert(!fab.supported, "local heuristic rejects fabricated claim");

  const run = async () => {
    const r1 = await verify(
      { claims: [{ text: "Rust compiler version 2.0 released with faster incremental builds", source_url: "http://example.test", confidence: 0.9 }] },
      { text: page, variant_id: "selftest", url: "http://example.test" }
    );
    assert(r1.verified === true && r1.mode === "local_heuristic", "verify passes grounded claim in local mode");
    const r2 = await verify(
      { claims: [{ text: "Python foundation bankruptcy announcement shocks markets", source_url: "http://example.test", confidence: 0.9 }] },
      { text: page, variant_id: "selftest", url: "http://example.test" }
    );
    assert(r2.verified === false, "verify rejects fabricated claim in local mode");
    const r3 = await verify({ claims: [] }, { text: page, variant_id: "selftest" });
    assert(r3.verified === false, "verify rejects empty claims");
    console.log("verify.js self-test done");
  };
  run();
}
