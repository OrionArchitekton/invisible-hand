// src/market/seller.js
// The product being sold: structured claim extraction over live web content.
// {url|text} -> {claims:[{text, source_url, confidence}], model, cost_est_usd}
// Inference: Pioneer (OpenAI-compatible, https://api.pioneer.ai/v1, X-API-Key auth,
// model from genome.model, 'Pioneer/Auto' router supported).
// Fallbacks are HONEST and labeled: no PIONEER_API_KEY -> Gemini JSON mode;
// no keys at all -> local mode (naive heuristic extractor, clearly labeled).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ledger from './ledger.js';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
export const PIONEER_BASE_URL = process.env.PIONEER_BASE_URL || 'https://api.pioneer.ai/v1';
// gemini-3.1-flash 404s on v1beta generateContent (verified 2026-07-24);
// gemini-flash-latest is the live stable-flash alias from ListModels.
const GEMINI_MODEL = `models/${process.env.SELLER_GEMINI_MODEL || 'gemini-flash-latest'}`;
const MAX_SOURCE_CHARS = 18000;

let priceTable = null;

// data/pioneer-prices.json: rough per-1M-token USD prices (labeled estimates).
export function loadPriceTable() {
  if (priceTable) return priceTable;
  try {
    priceTable = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pioneer-prices.json'), 'utf8'));
  } catch {
    priceTable = { models: {}, _meta: { note: 'price table missing; using default estimates' } };
  }
  return priceTable;
}

function priceFor(model) {
  const table = loadPriceTable();
  const models = table.models || {};
  const key = Object.keys(models).find((k) => k.toLowerCase() === String(model || '').toLowerCase());
  return models[key] || models.default || { input: 1.0, output: 4.0, estimate: true };
}

// usage: {prompt_tokens, completion_tokens} when the API returns it; else estimated.
export function estimateCostUsd(model, usage) {
  const p = priceFor(model);
  const inTok = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outTok = usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  const usd = (inTok * (p.input || 0) + outTok * (p.output || 0)) / 1e6;
  return Math.round(usd * 1e8) / 1e8;
}

function approxTokens(str) {
  return Math.ceil((str || '').length / 4);
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchSource(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'invisible-hand-seller/1.0 (+swarmhack demo)' },
  });
  if (!res.ok) throw new Error(`source fetch failed: ${res.status} ${url}`);
  const body = await res.text();
  const type = res.headers.get('content-type') || '';
  const text = type.includes('html') ? stripHtml(body) : body;
  return text.slice(0, MAX_SOURCE_CHARS);
}

function buildPrompt(sourceText, sourceUrl, genome) {
  const variantHint = genome && genome.prompt_variant ? `Style directive: ${genome.prompt_variant}.` : '';
  const niche = genome && genome.niche ? `Focus niche: ${genome.niche}.` : '';
  return [
    'You are a precise claim extraction engine.',
    'Extract the most important factual claims from the source text.',
    'Return STRICT JSON only, no prose, matching exactly:',
    '{"claims":[{"text":"<claim as a single sentence>","source_url":"<url>","confidence":<0..1>}]}',
    'Rules: 3 to 8 claims; each claim must be supported by the source text;',
    'confidence reflects how directly the source states it; use the provided source_url for every claim.',
    variantHint,
    niche,
    `source_url: ${sourceUrl || 'inline-text'}`,
    'SOURCE TEXT:',
    sourceText,
  ].filter(Boolean).join('\n');
}

// String-aware balanced scan: returns the first parseable block delimited by
// open/close. Needed because pool models 200 with trailing prose or a second
// object after the JSON, which a first-{-to-last-} slice spans.
function scanBalanced(text, open, close) {
  let attempts = 0;
  for (let i = 0; i < text.length && attempts < 12; i++) {
    if (text[i] !== open) continue;
    attempts++;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(i, j + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

// {"claims":[...]} | bare [...] (Qwen emits the array unwrapped) -> claims[].
function claimsFrom(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.claims)) return parsed.claims;
  return null;
}

function parseClaimsJson(raw, sourceUrl) {
  let text = String(raw || '').trim();
  // Reasoning models (e.g. Qwen3) may prefix a <think> block whose braces
  // would confuse brace scanning; strip it before extraction.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  let claims = null;
  try { claims = claimsFrom(JSON.parse(text)); } catch { /* scan below */ }
  if (!claims) claims = claimsFrom(scanBalanced(text, '{', '}'));
  if (!claims) claims = claimsFrom(scanBalanced(text, '[', ']'));
  if (!claims) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    claims = claimsFrom(JSON.parse(text)) || [];
  }
  return claims
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .map((c) => ({
      text: c.text.trim(),
      source_url: typeof c.source_url === 'string' && c.source_url ? c.source_url : (sourceUrl || 'inline-text'),
      confidence: clamp01(Number(c.confidence)),
    }));
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function resolveModel(genomeModel) {
  const m = String(genomeModel || 'pioneer/auto');
  if (m.toLowerCase() === 'pioneer/auto') return 'pioneer/auto';
  return m;
}

async function pioneerExtract(prompt, model, apiKey) {
  const res = await fetch(`${PIONEER_BASE_URL}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    // No response_format: 4 of 6 pool models (incl. the pioneer/auto router)
    // reject json_object with HTTP 400 "Invalid input" (live-probed 07-24);
    // the prompt demands strict JSON and parseClaimsJson tolerates fences.
    // max_tokens bounds the completion so prompt+completion always fits the
    // window (unbounded default overflowed: "maximum context length" 400s).
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      // Reasoning models (Qwen3) spend tokens thinking before the JSON; give
      // them headroom or they return 0 claims and starve on verification.
      max_tokens: /qwen/i.test(model) ? 3072 : 1024,
    }),
  });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 300);
    throw new Error(`Pioneer inference failed: HTTP ${res.status} ${errBody}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  const routedModel = data.model || model;
  const usage = data.usage
    ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens }
    : { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(content) };
  return { content, model: routedModel, usage, usage_estimated: !data.usage };
}

async function geminiExtract(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 300);
    throw new Error(`Gemini fallback failed: HTTP ${res.status} ${errBody}`);
  }
  const data = await res.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts || []
    : [];
  const content = parts.map((p) => p.text || '').join('');
  const um = data.usageMetadata || {};
  const usage = {
    prompt_tokens: um.promptTokenCount || approxTokens(prompt),
    completion_tokens: um.candidatesTokenCount || approxTokens(content),
  };
  return { content, model: GEMINI_MODEL, usage, usage_estimated: !data.usageMetadata };
}

// Local mode: NO inference API available. Heuristic sentence picker, honestly labeled.
function localExtract(sourceText, sourceUrl) {
  const sentences = String(sourceText || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 300);
  const claims = sentences.slice(0, 3).map((s) => ({
    text: s,
    source_url: sourceUrl || 'inline-text',
    confidence: 0.2,
  }));
  return {
    claims,
    model: 'local-mode-extractor (no inference API key present)',
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    local_mode: true,
  };
}

// Core extraction. input: { url?, text?, genome }. Exactly one of url|text required.
// Returns { claims, model, cost_est_usd, variant_id, local_mode? }.
export async function extract({ url, text, genome = {} }) {
  if (!url && !text) throw new Error('extract: provide url or text');
  const sourceUrl = url || null;
  const sourceText = text || await fetchSource(url);
  const prompt = buildPrompt(sourceText, sourceUrl, genome);

  const pioneerKey = process.env.PIONEER_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  let result;
  let pioneerError = null;
  if (pioneerKey) {
    const model = resolveModel(genome.model);
    try {
      const r = await pioneerExtract(prompt, model, pioneerKey);
      result = {
        claims: parseClaimsJson(r.content, sourceUrl),
        model: r.model,
        usage: r.usage,
      };
    } catch (err) {
      // Honest degradation: a keyed-but-failing Pioneer account (e.g. HTTP 403
      // card_required before a billing plan is active) must not kill every sale.
      // Fall through to Gemini with the failure labeled; rethrow if no fallback.
      if (!geminiKey) throw err;
      pioneerError = String(err.message || err).slice(0, 120);
      console.warn(`[seller] Pioneer failed (${pioneerError}); falling back to Gemini (labeled)`);
    }
  }
  if (!result && pioneerKey && geminiKey && pioneerError) {
    const r = await geminiExtract(prompt, geminiKey);
    result = {
      claims: parseClaimsJson(r.content, sourceUrl),
      model: `${r.model} (fallback: Pioneer failed: ${pioneerError})`,
      usage: r.usage,
    };
  }
  if (!result && !pioneerKey && geminiKey) {
    const r = await geminiExtract(prompt, geminiKey);
    result = {
      claims: parseClaimsJson(r.content, sourceUrl),
      model: `${r.model} (fallback: PIONEER_API_KEY missing)`,
      usage: r.usage,
    };
  }
  if (!result) {
    result = localExtract(sourceText, sourceUrl);
  }

  const costModel = result.local_mode ? 'local-mode-extractor' : (genome.model || result.model);
  const cost_est_usd = estimateCostUsd(result.local_mode ? 'local-mode-extractor' : costModel, result.usage);
  return {
    claims: result.claims,
    model: result.model,
    cost_est_usd,
    variant_id: genome.id || null,
    ...(result.local_mode ? { local_mode: true } : {}),
  };
}

// Express handler factory for one variant. Body: {url} or {text}.
// Debits the variant's inference cost on success; sale revenue is credited by the
// registry when the x402 settlement lands (with tx_hash). A failed inference
// returns 502 BEFORE settlement, so the buyer is never charged for junk-errors.
export function makeExtractHandler(variant) {
  const genome = variant && variant.genome ? variant.genome : variant || {};
  return async function extractHandler(req, res) {
    const { url, text } = req.body || {};
    if (!url && !text) {
      res.status(400).json({ error: 'body must include url or text' });
      return;
    }
    try {
      const out = await extract({ url, text, genome });
      if (genome.id && out.cost_est_usd > 0) {
        try {
          ledger.debit(genome.id, out.cost_est_usd, `inference_cost:${out.model}`);
        } catch (e) {
          console.error(`[seller] ledger debit failed for ${genome.id}: ${e.message}`);
        }
      }
      res.json(out);
    } catch (err) {
      res.status(502).json({ error: 'extraction failed', detail: String(err.message || err).slice(0, 300) });
    }
  };
}

// Inline self-test: parser robustness + local-mode path (no keys, no network).
if (process.env.SELF_TEST) {
  const passert = (cond, msg) => {
    if (!cond) { console.error('[seller self-test] PARSER FAIL:', msg); process.exit(1); }
  };
  const good = '{"claims":[{"text":"A claim.","source_url":"http://x","confidence":0.9}]}';
  // Observed live 07-24: trailing prose / second object after valid JSON.
  passert(parseClaimsJson(`${good}\n\nNote: I extracted {1} claim as requested.`, 'u').length === 1, 'trailing prose with braces');
  passert(parseClaimsJson(`${good}\n{"debug":true}`, 'u').length === 1, 'second JSON object after claims');
  passert(parseClaimsJson(`<think>Let me think {about} this.</think>${good}`, 'u').length === 1, 'think block stripped');
  passert(parseClaimsJson('```json\n' + good + '\n```', 'u').length === 1, 'fenced JSON');
  passert(parseClaimsJson(`Here you go: ${good}`, 'u').length === 1, 'leading prose');
  passert(parseClaimsJson('{"claims":[{"text":"Brace } in \\"string\\".","source_url":"http://x","confidence":1}]} extra', 'u').length === 1, 'brace inside string literal');
  // Observed live 07-24: Qwen3-8B emits the claims array UNWRAPPED.
  passert(parseClaimsJson('[{"text":"Bare array claim.","source_url":"http://x","confidence":1}]', 'u').length === 1, 'bare top-level array');
  passert(parseClaimsJson('Sure:\n[{"text":"Prefixed bare array.","source_url":"http://x","confidence":1}] done', 'u').length === 1, 'bare array with surrounding prose');
  console.log('[seller self-test] parser robustness OK (8 cases)');
  const savedP = process.env.PIONEER_API_KEY;
  const savedG = process.env.GEMINI_API_KEY;
  delete process.env.PIONEER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const sample = 'The market opened at generation zero today. Six seller variants were staked with testnet USDC on Base Sepolia. Insolvent variants are delisted and their endpoints return 410 GONE. Survivors breed and children inherit their genomes.';
  const out = await extract({ text: sample, genome: { id: 'selftest', model: 'Pioneer/Auto' } });
  const ok = out.local_mode === true && out.claims.length >= 1 && out.model.includes('local-mode');
  console.log(`[seller self-test] ok=${ok} claims=${out.claims.length} model="${out.model}" cost=${out.cost_est_usd}`);
  if (savedP) process.env.PIONEER_API_KEY = savedP;
  if (savedG) process.env.GEMINI_API_KEY = savedG;
  if (!ok) process.exit(1);
}
