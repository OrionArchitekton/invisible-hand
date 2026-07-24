// src/evolution/genome.js
// Genome for seller-agent variants + breeding (crossover + one bounded mutation).
// Contract (ARCHITECTURE.md): genome = {id, parent_ids[], gen, price_usd, model,
// prompt_variant, niche}. Seed population = 6 variants at gen 0, price_usd in
// [0.001, 0.02]. Breeding runs through Gemini (JSON out, temperature 0.9) when
// GEMINI_API_KEY is present; otherwise an honest deterministic LOCAL MODE.
// Inherited immunity: callers pass the parents' failure clusters (retrieved from
// Actian by the engine) and we inject an "avoid these failure modes" block into
// the child's prompt_variant.

import { createHash, randomBytes } from "node:crypto";

export const PRICE_MIN = 0.001;
export const PRICE_MAX = 0.02;

// Real Pioneer-servable models (verified against agent.pioneer.ai/llms-full.txt
// "Decoder Models - Serverless Inference" on 2026-07-24) plus the Pioneer router.
// openai/gpt-oss-20b and Qwen/Qwen3-8B are the cheap open models in the pool.
export const MODEL_POOL = [
  // Live-verified servable on Pioneer 07-24 (HTTP 200 on chat/completions).
  // "Pioneer/Auto" 404s: the router id is case-sensitive lowercase.
  "pioneer/auto",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "Qwen/Qwen3-8B",
  "zai-org/GLM-5.2",
  "meta-llama/Llama-3.1-8B-Instruct",
];

export const NICHE_POOL = ["ai", "crypto", "security", "science", "business", "general"];

// Real extraction system prompts. All commit to the buyer-verified output schema:
// {claims: [{text, source_url, confidence}]}.
export const PROMPT_VARIANTS = [
  [
    "You are a precision claims extractor. Given an article (url and text), extract only",
    "factual claims that are directly and explicitly supported by the text. Never infer,",
    "never speculate, never merge two facts into one claim. Output STRICT JSON only:",
    '{"claims":[{"text":"<one atomic factual claim>","source_url":"<the article url>",',
    '"confidence":<0.0-1.0 calibrated to how explicitly the text supports it>}]}.',
    "Prefer fewer, bulletproof claims over coverage. If nothing is verifiable, return",
    '{"claims":[]}.',
  ].join(" "),
  [
    "You are a high-coverage structured extraction engine. Given an article (url and",
    "text), decompose it into the complete set of atomic factual claims it makes: who,",
    "what, when, where, how much. Each claim must stand alone without pronouns or",
    "context. Output STRICT JSON only:",
    '{"claims":[{"text":"<atomic claim>","source_url":"<the article url>",',
    '"confidence":<0.0-1.0>}]}. Aim for completeness, but every claim must trace to a',
    "specific sentence in the source text. No commentary outside the JSON.",
  ].join(" "),
  [
    "You are an adversarial fact auditor. Given an article (url and text), extract only",
    "claims a hostile reviewer could verify against the source: each claim must be",
    "anchored to a quotable span of the text and carry the exact source_url. Reject",
    "headlines, opinions, predictions, and marketing language. Output STRICT JSON only:",
    '{"claims":[{"text":"<verifiable claim anchored to the text>",',
    '"source_url":"<the article url>","confidence":<0.0-1.0, penalize any ambiguity>}]}.',
  ].join(" "),
];

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

export function newId(gen = 0) {
  return `v${gen}-${randomBytes(3).toString("hex")}`;
}

export function clampGenome(g) {
  const out = { ...g };
  out.price_usd = Math.min(PRICE_MAX, Math.max(PRICE_MIN, Number(out.price_usd) || PRICE_MIN));
  out.price_usd = Number(out.price_usd.toFixed(6));
  if (!MODEL_POOL.includes(out.model)) out.model = MODEL_POOL[0];
  if (!NICHE_POOL.includes(out.niche)) out.niche = "general";
  if (typeof out.prompt_variant !== "string" || out.prompt_variant.length < 40) {
    out.prompt_variant = PROMPT_VARIANTS[0];
  }
  if (!Array.isArray(out.parent_ids)) out.parent_ids = [];
  out.gen = Number.isInteger(out.gen) ? out.gen : 0;
  return out;
}

// Deterministic 6-variant seed population, gen 0, prices spread across the band.
export function seedPopulation() {
  const seeds = [];
  for (let i = 0; i < 6; i++) {
    const price = PRICE_MIN + (i / 5) * (PRICE_MAX - PRICE_MIN);
    seeds.push(
      clampGenome({
        id: newId(0),
        parent_ids: [],
        gen: 0,
        price_usd: Number(price.toFixed(6)),
        model: MODEL_POOL[i % MODEL_POOL.length],
        prompt_variant: PROMPT_VARIANTS[i % PROMPT_VARIANTS.length],
        niche: NICHE_POOL[i % NICHE_POOL.length],
        created_at: new Date().toISOString(),
        bred_by: "seed",
      })
    );
  }
  return seeds;
}

// Inherited immunity: turn the parents' failure clusters (strings from Actian)
// into an instruction block appended to the child's prompt_variant.
export function buildImmunityBlock(failureClusters = []) {
  const clusters = failureClusters.filter((c) => typeof c === "string" && c.trim()).slice(0, 6);
  if (clusters.length === 0) return "";
  return (
    " INHERITED IMMUNITY: your parent variants were financially penalized for these" +
    " verified failure modes; avoid them at all costs: " +
    clusters.map((c, i) => `(${i + 1}) ${c.trim()}`).join("; ") +
    "."
  );
}

function seededPick(arr, seedStr) {
  const h = createHash("sha1").update(seedStr).digest();
  return arr[h[0] % arr.length];
}

// Local-mode crossover + one bounded mutation. Deterministic given (parents, salt).
export function localBreed(parentA, parentB, { salt = "" } = {}) {
  const seed = `${parentA.id}|${parentB.id}|${salt}`;
  const h = createHash("sha1").update(seed).digest();
  const gen = Math.max(parentA.gen, parentB.gen) + 1;
  const child = {
    id: newId(gen),
    parent_ids: [parentA.id, parentB.id],
    gen,
    price_usd: h[1] % 2 === 0 ? parentA.price_usd : parentB.price_usd,
    model: h[2] % 2 === 0 ? parentA.model : parentB.model,
    prompt_variant: h[3] % 2 === 0 ? parentA.prompt_variant : parentB.prompt_variant,
    niche: h[4] % 2 === 0 ? parentA.niche : parentB.niche,
    created_at: new Date().toISOString(),
    bred_by: "local",
  };
  // Exactly one bounded mutation.
  const which = h[5] % 3;
  if (which === 0) {
    const factor = 0.7 + (h[6] / 255) * 0.6; // bounded 0.7x .. 1.3x
    child.price_usd = child.price_usd * factor;
  } else if (which === 1) {
    child.model = seededPick(MODEL_POOL, seed + "model");
  } else {
    child.niche = seededPick(NICHE_POOL, seed + "niche");
  }
  return clampGenome(child);
}

async function geminiBreed(parentA, parentB, { apiKey, fetchImpl = fetch, temperature = 0.9 }) {
  const prompt = [
    "You are the mutation operator of an evolutionary market of seller agents.",
    "Two parent genomes follow. Produce ONE child genome as strict JSON with keys:",
    "price_usd (number), model (string), prompt_variant (string), niche (string).",
    "Rules: (1) crossover: each gene starts from one of the two parents.",
    `(2) apply EXACTLY ONE bounded mutation: either adjust price_usd by at most 30`,
    `percent (final value must stay within ${PRICE_MIN} to ${PRICE_MAX}), or swap model to one of`,
    JSON.stringify(MODEL_POOL) + ",",
    "or swap niche to one of " + JSON.stringify(NICHE_POOL) + ",",
    "or rewrite prompt_variant to a sharper extraction system prompt that MUST still",
    'demand strict JSON output of shape {"claims":[{"text","source_url","confidence"}]}.',
    "(3) Output ONLY the JSON object, no prose.",
    "Parent A: " + JSON.stringify({
      price_usd: parentA.price_usd, model: parentA.model,
      prompt_variant: parentA.prompt_variant, niche: parentA.niche,
    }),
    "Parent B: " + JSON.stringify({
      price_usd: parentB.price_usd, model: parentB.model,
      prompt_variant: parentB.prompt_variant, niche: parentB.niche,
    }),
  ].join("\n");

  const res = await fetchImpl(GEMINI_URL(GEMINI_MODEL, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`gemini http ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("gemini returned no candidate text");
  const raw = JSON.parse(text);
  const gen = Math.max(parentA.gen, parentB.gen) + 1;
  const child = clampGenome({
    id: newId(gen),
    parent_ids: [parentA.id, parentB.id],
    gen,
    price_usd: raw.price_usd,
    model: raw.model,
    prompt_variant: raw.prompt_variant,
    niche: raw.niche,
    created_at: new Date().toISOString(),
    bred_by: "gemini",
  });
  // Validate the rewritten prompt still commits to the buyer-verified schema.
  if (!/claims/.test(child.prompt_variant) || !/source_url/.test(child.prompt_variant)) {
    child.prompt_variant = parentA.prompt_variant;
  }
  return child;
}

/**
 * Breed a child from two parents.
 * opts:
 *   failureClusters: string[] retrieved from Actian for the parents (engine wires
 *     this via actian.getFailureClusters([a.id, b.id])) -> inherited immunity.
 *   apiKey: Gemini key (default process.env.GEMINI_API_KEY). Absent -> LOCAL MODE
 *     (honest deterministic crossover+mutation, labeled bred_by: "local").
 *   forceLocal: skip Gemini even when a key exists (used by self-tests).
 */
export async function breed(parentA, parentB, opts = {}) {
  const {
    failureClusters = [],
    apiKey = process.env.GEMINI_API_KEY,
    forceLocal = false,
    fetchImpl = fetch,
  } = opts;
  let child;
  if (apiKey && !forceLocal) {
    try {
      child = await geminiBreed(parentA, parentB, { apiKey, fetchImpl });
    } catch (err) {
      console.warn(`[genome] gemini breed failed (${err.message}); falling back to local mode`);
      child = localBreed(parentA, parentB, { salt: String(Date.now()) });
      child.bred_by = "local-fallback";
    }
  } else {
    child = localBreed(parentA, parentB, { salt: String(Date.now()) });
  }
  const immunity = buildImmunityBlock(failureClusters);
  if (immunity) {
    child.prompt_variant = child.prompt_variant + immunity;
    child.inherited_immunity = failureClusters.slice(0, 6);
  }
  return child;
}

// ---------------------------------------------------------------------------
if (process.env.SELF_TEST) {
  const assert = (cond, msg) => {
    if (!cond) { console.error("SELF_TEST FAIL:", msg); process.exit(1); }
  };
  const pop = seedPopulation();
  assert(pop.length === 6, "seed population is 6");
  for (const g of pop) {
    assert(g.gen === 0, "seed gen 0");
    assert(g.price_usd >= PRICE_MIN && g.price_usd <= PRICE_MAX, "price in band");
    assert(MODEL_POOL.includes(g.model), "model in pool");
    assert(g.parent_ids.length === 0, "seed has no parents");
  }
  const child = await breed(pop[0], pop[1], {
    forceLocal: true,
    failureClusters: ["dropped source_url on 3 of 5 claims", "hallucinated numbers not in text"],
  });
  assert(child.gen === 1, "child gen 1");
  assert(child.parent_ids.length === 2, "child has two parents");
  assert(child.price_usd >= PRICE_MIN && child.price_usd <= PRICE_MAX, "child price clamped");
  assert(child.prompt_variant.includes("INHERITED IMMUNITY"), "immunity injected");
  assert(clampGenome({ price_usd: 99, model: "nope", niche: "nope" }).price_usd === PRICE_MAX, "clamp works");
  console.log("genome.js SELF_TEST OK; sample child:", { id: child.id, model: child.model, price_usd: child.price_usd, niche: child.niche, bred_by: child.bred_by });
}
