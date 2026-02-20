// Structured event extraction — runs in background after feed loads.
// Every cluster gets tagged with: eventType, subtype, severity, scope,
// verificationStatus, confidence, actors, country, regions, rationale.
// Failed/borderline extractions go to quarantine for learning.
// Results persist to SQLite. The front-end doesn't change.

const Groq = require('groq-sdk');
const { clusterHash, eventExists, insertEvent, insertQuarantine } = require('./db');

let groqClient = null;
const REQUEST_DELAY_MS = 3000;
const MAX_RETRIES = 3;

// ─── Provenance ─────────────────────────────────────────────────

const MODEL_VERSION = 'llama-3.3-70b-versatile';
const PROMPT_VERSION = 'v2'; // bump when you change EXTRACTION_PROMPT

// ─── Validation enums ──────────────────────────────────────────

const VALID_EVENT_TYPES = new Set([
  'security', 'political', 'economic', 'humanitarian', 'infrastructure', 'legal',
]);
const VALID_SCOPES = new Set(['local', 'state', 'national', 'cross_border']);
const VALID_VERIFICATION = new Set(['confirmed', 'reported', 'unverified']);

// ─── Actor normalization ────────────────────────────────────────

const ACTOR_ALIASES = {
  // Government variations
  'govt of south sudan': 'Government of South Sudan',
  'government of south sudan': 'Government of South Sudan',
  'goss': 'Government of South Sudan',
  'south sudan government': 'Government of South Sudan',
  'govt of sudan': 'Government of Sudan',
  'government of sudan': 'Government of Sudan',
  'sudan government': 'Government of Sudan',
  'sudanese government': 'Government of Sudan',
  'saf': 'Sudan Armed Forces (SAF)',
  'sudan armed forces': 'Sudan Armed Forces (SAF)',

  // Known orgs — normalize to canonical form
  'splm-io': 'SPLM-IO',
  'splm/a-io': 'SPLM-IO',
  'splm - io': 'SPLM-IO',
  'splm/spla-io': 'SPLM-IO',
  'splm': 'SPLM',
  'unmiss': 'UNMISS',
  'un mission in south sudan': 'UNMISS',
  'united nations mission in south sudan': 'UNMISS',
  'rsf': 'Rapid Support Forces (RSF)',
  'rapid support forces': 'Rapid Support Forces (RSF)',
  'igad': 'IGAD',
  'intergovernmental authority on development': 'IGAD',
  'unhcr': 'UNHCR',
  'un refugee agency': 'UNHCR',
  'wfp': 'WFP',
  'world food programme': 'WFP',
  'world food program': 'WFP',
  'icrc': 'ICRC',
  'international committee of the red cross': 'ICRC',
  'red cross': 'ICRC',
  'au': 'African Union',
  'african union': 'African Union',
  'ocha': 'UN OCHA',
  'unicef': 'UNICEF',
  'iom': 'IOM',
  'international organization for migration': 'IOM',
  'msf': 'MSF',
  'doctors without borders': 'MSF',
  'médecins sans frontières': 'MSF',
};

function normalizeActor(actor) {
  const key = actor.toLowerCase().trim();
  return ACTOR_ALIASES[key] || actor.trim();
}

function normalizeActors(actors) {
  if (!Array.isArray(actors)) return [];
  const seen = new Set();
  const result = [];
  for (const actor of actors) {
    const normalized = normalizeActor(actor);
    if (normalized && !seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase());
      result.push(normalized);
    }
  }
  return result;
}

// Source tier mapping (deterministic — no AI needed)
const SOURCE_TIERS = {
  // Tier 1: Major international / official
  'BBC Africa': 'tier1',
  'Reuters': 'tier1',
  'Al Jazeera': 'tier1',
  'The Guardian Africa': 'tier1',
  'France24 Africa': 'tier1',
  'UN News Africa': 'tier1',
  'VOA Africa': 'tier1',

  // Tier 2: Regional / established local
  'Radio Tamazuj': 'tier2',
  'Eye Radio': 'tier2',
  'Sudan Tribune': 'tier2',
  'Dabanga Radio': 'tier2',
  'Africanews': 'tier2',

  // Tier 3: Community / aggregated
  'Nyamilepedia': 'tier3',
  'Google News': 'tier3',
};

function initExtractor(apiKey) {
  if (apiKey) {
    groqClient = new Groq({ apiKey });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGroqWithRetry(params) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await groqClient.chat.completions.create(params);
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      if (is429 && attempt < MAX_RETRIES) {
        const waitMs = Math.pow(2, attempt + 1) * 1000;
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

function getSourceTier(sources) {
  for (const s of sources) {
    if (SOURCE_TIERS[s] === 'tier1') return 'tier1';
  }
  for (const s of sources) {
    if (SOURCE_TIERS[s] === 'tier2') return 'tier2';
  }
  return 'tier3';
}

// ─── Validation ─────────────────────────────────────────────────
// Returns { hardErrors: [...], softErrors: [...] }
// Hard errors = invalid schema (reject entirely)
// Soft errors = borderline quality (quarantine, don't insert)

function validateExtraction(data) {
  const hardErrors = [];
  const softErrors = [];

  // Hard: schema violations
  if (!data.country || typeof data.country !== 'string') {
    hardErrors.push('missing country');
  }
  if (!data.eventType || !VALID_EVENT_TYPES.has(data.eventType)) {
    hardErrors.push(`invalid eventType: ${data.eventType}`);
  }
  if (data.severity == null || data.severity < 1 || data.severity > 5) {
    hardErrors.push(`invalid severity: ${data.severity}`);
  }
  if (data.scope && !VALID_SCOPES.has(data.scope)) {
    hardErrors.push(`invalid scope: ${data.scope}`);
  }
  if (data.verificationStatus && !VALID_VERIFICATION.has(data.verificationStatus)) {
    hardErrors.push(`invalid verificationStatus: ${data.verificationStatus}`);
  }
  if (data.confidence != null && (data.confidence < 0 || data.confidence > 1)) {
    hardErrors.push(`invalid confidence: ${data.confidence}`);
  }

  // Soft: borderline quality
  if (data.confidence != null && data.confidence < 0.3) {
    softErrors.push(`confidence too low: ${data.confidence}`);
  }
  if (!data.regions || (Array.isArray(data.regions) && data.regions.length === 0)) {
    softErrors.push('missing regions');
  }

  return { hardErrors, softErrors };
}

// ─── Extraction prompt ──────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a structured data extractor for a Horn of Africa risk monitoring system.
Given news articles about a story, extract structured event data as JSON.

Return ONLY valid JSON (no markdown, no explanation) with these fields:

{
  "summary": "1-2 sentence factual summary",
  "country": "Primary country (e.g. South Sudan, Sudan, Uganda)",
  "regions": ["Array of specific regions/states mentioned, e.g. Upper Nile, Jonglei"],
  "eventType": "One of: security, political, economic, humanitarian, infrastructure, legal",
  "eventSubtype": "Specific subtype, e.g. clash, ceasefire, peace_talks, displacement, flooding, legislation",
  "severity": 1-5,
  "scope": "One of: local, state, national, cross_border",
  "verificationStatus": "One of: confirmed, reported, unverified",
  "confidence": 0.0-1.0,
  "actors": ["Array of key actors: organizations, governments, armed groups, individuals"],
  "rationale": "1-2 sentences explaining WHY you chose this severity, scope, and verification status"
}

Severity scale:
1 = Routine (scheduled meetings, statements, routine reports)
2 = Notable (policy changes, localized incidents, organizational changes)
3 = Significant (regional displacement, major political shifts, economic disruptions)
4 = Major (large-scale violence, state-level crisis, major international intervention)
5 = Critical (war escalation, mass atrocity, national emergency)

Rules:
- country should be the PRIMARY country affected
- regions should use standard admin names (South Sudan states: Upper Nile, Jonglei, Unity, Warrap, Northern Bahr el Ghazal, Western Bahr el Ghazal, Lakes, Western Equatoria, Central Equatoria, Eastern Equatoria)
- eventSubtype should be a short lowercase slug
- confidence reflects how certain the extracted information is (0.5 = moderate, 0.8 = high, 1.0 = definitive)
- verificationStatus: "confirmed" if multiple sources or official source, "reported" if credible single source, "unverified" if uncertain
- rationale MUST explain the severity and verification choices — this is used for quality auditing
- Return ONLY the JSON object, nothing else`;

async function extractEventData(cluster) {
  if (!groqClient) return null;

  const hash = clusterHash(cluster);
  if (eventExists(hash)) return null; // Already extracted or quarantined

  const sources = [...new Set(cluster.articles.map((a) => a.source))];
  const articleUrls = cluster.articles.map((a) => a.url).filter(Boolean);
  let rawOutput = null;

  try {
    const articlesText = cluster.articles
      .slice(0, 5)
      .map((a) => `[${a.source}] ${a.title}\n${a.description || ''}`)
      .join('\n\n');

    const response = await callGroqWithRetry({
      model: MODEL_VERSION,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: `Extract structured event data from these articles:\n\n${articlesText}` },
      ],
      max_tokens: 500,
      temperature: 0.1,
    });

    rawOutput = response.choices[0]?.message?.content?.trim();
    if (!rawOutput) return null;

    // Parse JSON (strip any markdown fencing the model might add)
    const jsonStr = rawOutput.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    const data = JSON.parse(jsonStr);

    // ── Validate ──────────────────────────────────────────────
    const { hardErrors, softErrors } = validateExtraction(data);

    // Hard errors: reject and quarantine
    if (hardErrors.length > 0) {
      console.warn(`  Rejected "${cluster.primaryArticle.title.slice(0, 40)}...": ${hardErrors.join(', ')}`);
      insertQuarantine({
        cluster_hash: hash,
        raw_output: rawOutput,
        error_reasons: hardErrors,
        primary_title: cluster.primaryArticle.title,
        primary_url: cluster.primaryArticle.url,
        sources,
        article_urls: articleUrls,
        model_version: MODEL_VERSION,
        prompt_version: PROMPT_VERSION,
      });
      return null;
    }

    // Soft errors with low confidence: quarantine instead of insert
    if (softErrors.length > 0 && data.confidence != null && data.confidence < 0.3) {
      console.warn(`  Quarantined "${cluster.primaryArticle.title.slice(0, 40)}...": ${softErrors.join(', ')}`);
      insertQuarantine({
        cluster_hash: hash,
        raw_output: rawOutput,
        error_reasons: softErrors,
        primary_title: cluster.primaryArticle.title,
        primary_url: cluster.primaryArticle.url,
        sources,
        article_urls: articleUrls,
        model_version: MODEL_VERSION,
        prompt_version: PROMPT_VERSION,
      });
      return null;
    }

    // Build event record with provenance + normalized actors
    const rawActors = data.actors || [];
    const event = {
      cluster_hash: hash,
      summary: data.summary || cluster.primaryArticle.title,
      country: data.country,
      regions: data.regions || [],
      event_type: data.eventType,
      event_subtype: data.eventSubtype || null,
      severity: Math.min(5, Math.max(1, Math.round(data.severity))),
      scope: VALID_SCOPES.has(data.scope) ? data.scope : 'local',
      source_tier: getSourceTier(sources),
      verification_status: VALID_VERIFICATION.has(data.verificationStatus) ? data.verificationStatus : 'reported',
      confidence: Math.min(1, Math.max(0, data.confidence || 0.5)),
      rationale: data.rationale || null,
      actors: rawActors,
      actors_normalized: normalizeActors(rawActors),
      model_version: MODEL_VERSION,
      prompt_version: PROMPT_VERSION,
      article_urls: articleUrls,
      article_count: cluster.articles.length,
      sources,
      primary_url: cluster.primaryArticle.url,
      primary_title: cluster.primaryArticle.title,
      published_at: cluster.latestDate,
    };

    insertEvent(event);
    return event;
  } catch (err) {
    // JSON parse failures or API errors: quarantine with raw output
    console.warn(`  Event extraction failed for "${cluster.primaryArticle.title.slice(0, 50)}...": ${err.message}`);
    insertQuarantine({
      cluster_hash: hash,
      raw_output: rawOutput,
      error_reasons: [err.message],
      primary_title: cluster.primaryArticle.title,
      primary_url: cluster.primaryArticle.url,
      sources,
      article_urls: articleUrls,
      model_version: MODEL_VERSION,
      prompt_version: PROMPT_VERSION,
    });
    return null;
  }
}

// Background extraction: process all clusters, pacing API calls
async function extractAllEvents(clusters) {
  if (!groqClient) {
    console.log('Skipping event extraction (no Groq API key)');
    return;
  }

  const pending = clusters.filter((c) => !eventExists(clusterHash(c)));
  if (pending.length === 0) {
    console.log('Event extraction: all clusters already in database');
    return;
  }

  console.log(`Extracting structured events for ${pending.length} new clusters (background)...`);

  let extracted = 0;
  let quarantined = 0;

  for (const cluster of pending) {
    const result = await extractEventData(cluster);
    if (result) {
      extracted++;
    } else {
      quarantined++;
    }

    // Rate limit pacing
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`Event extraction complete: ${extracted} extracted, ${quarantined} skipped/quarantined`);
}

module.exports = { initExtractor, extractAllEvents, getSourceTier };
