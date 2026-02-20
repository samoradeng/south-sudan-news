// Structured event extraction — runs in background after feed loads.
// Every cluster gets tagged with: eventType, subtype, severity, scope,
// verificationStatus, confidence, actors, country, regions.
// Results persist to SQLite. The front-end doesn't change.

const Groq = require('groq-sdk');
const { clusterHash, eventExists, insertEvent } = require('./db');

let groqClient = null;
const REQUEST_DELAY_MS = 3000;
const MAX_RETRIES = 3;

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
  // Use the highest-tier source in the cluster
  for (const s of sources) {
    if (SOURCE_TIERS[s] === 'tier1') return 'tier1';
  }
  for (const s of sources) {
    if (SOURCE_TIERS[s] === 'tier2') return 'tier2';
  }
  return 'tier3';
}

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
  "actors": ["Array of key actors: organizations, governments, armed groups, individuals"]
}

Severity scale:
1 = Routine (scheduled meetings, statements)
2 = Notable (policy changes, localized incidents)
3 = Significant (regional displacement, major political shifts)
4 = Major (large-scale violence, state-level crisis)
5 = Critical (war escalation, mass atrocity, national emergency)

Rules:
- country should be the PRIMARY country affected
- regions should use standard admin names (states for South Sudan: Upper Nile, Jonglei, Unity, Warrap, Northern Bahr el Ghazal, Western Bahr el Ghazal, Lakes, Western Equatoria, Central Equatoria, Eastern Equatoria)
- eventSubtype should be a short lowercase slug
- confidence reflects how certain the extracted information is (0.5 = moderate, 0.8 = high, 1.0 = definitive)
- verificationStatus: "confirmed" if multiple sources or official source, "reported" if credible single source, "unverified" if uncertain
- Return ONLY the JSON object, nothing else`;

async function extractEventData(cluster) {
  if (!groqClient) return null;

  const hash = clusterHash(cluster);
  if (eventExists(hash)) return null; // Already extracted

  try {
    const articlesText = cluster.articles
      .slice(0, 5)
      .map((a) => `[${a.source}] ${a.title}\n${a.description || ''}`)
      .join('\n\n');

    const response = await callGroqWithRetry({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: `Extract structured event data from these articles:\n\n${articlesText}` },
      ],
      max_tokens: 400,
      temperature: 0.1, // Very low — we want consistent, deterministic extraction
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    // Parse JSON (strip any markdown fencing the model might add)
    const jsonStr = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    const data = JSON.parse(jsonStr);

    // Validate required fields
    if (!data.eventType || !data.country) return null;

    // Build event record
    const sources = [...new Set(cluster.articles.map((a) => a.source))];
    const event = {
      cluster_hash: hash,
      summary: data.summary || cluster.primaryArticle.title,
      country: data.country,
      regions: data.regions || [],
      event_type: data.eventType,
      event_subtype: data.eventSubtype || null,
      severity: Math.min(5, Math.max(1, data.severity || 2)),
      scope: data.scope || 'local',
      source_tier: getSourceTier(sources),
      verification_status: data.verificationStatus || 'reported',
      confidence: Math.min(1, Math.max(0, data.confidence || 0.5)),
      actors: data.actors || [],
      article_count: cluster.articles.length,
      sources,
      primary_url: cluster.primaryArticle.url,
      primary_title: cluster.primaryArticle.title,
      published_at: cluster.latestDate,
    };

    insertEvent(event);
    return event;
  } catch (err) {
    // Log but don't crash — extraction is best-effort
    console.warn(`  Event extraction failed for "${cluster.primaryArticle.title.slice(0, 50)}...": ${err.message}`);
    return null;
  }
}

// Background extraction: process all clusters, pacing API calls
async function extractAllEvents(clusters) {
  if (!groqClient) {
    console.log('Skipping event extraction (no Groq API key)');
    return;
  }

  // Count how many need extraction
  const pending = clusters.filter((c) => !eventExists(clusterHash(c)));
  if (pending.length === 0) {
    console.log('Event extraction: all clusters already in database');
    return;
  }

  console.log(`Extracting structured events for ${pending.length} new clusters (background)...`);

  let extracted = 0;
  let failed = 0;

  for (const cluster of pending) {
    const result = await extractEventData(cluster);
    if (result) {
      extracted++;
    } else {
      failed++;
    }

    // Rate limit pacing
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`Event extraction complete: ${extracted} extracted, ${failed} skipped/failed`);
}

module.exports = { initExtractor, extractAllEvents, getSourceTier };
