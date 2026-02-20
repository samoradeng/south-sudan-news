#!/usr/bin/env node
// ─── Backtest Pipeline ───────────────────────────────────────
// Tests the extraction pipeline against known historical events.
//
// Data sources (tried in order):
//   1. Local JSON file: data/backtest-articles/{event-id}.json
//   2. GDELT DOC API (free, no API key needed)
//   3. Synthetic articles from gold-label descriptions (fallback)
//
// Usage:
//   node server/backtest.js                   # Run all gold-label events
//   node server/backtest.js --event sudan-war-breakout-2023
//   node server/backtest.js --dry-run         # Fetch/generate articles, skip extraction
//   node server/backtest.js --synthetic       # Force synthetic articles (no network)
//
// Requires: GROQ_API_KEY in .env (for extraction, unless --dry-run)

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { clusterArticles } = require('./cluster');
const goldLabels = require('./gold-labels.json');

let Groq;
try { Groq = require('groq-sdk'); } catch { Groq = null; }

// ─── Config ──────────────────────────────────────────────────

const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MAX_ARTICLES_PER_EVENT = 50;
const REQUEST_DELAY_MS = 2000;
const LOCAL_ARTICLES_DIR = path.join(__dirname, '..', 'data', 'backtest-articles');

// ─── CLI args ────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forceSynthetic = args.includes('--synthetic');
const eventFilter = args.find((a) => a.startsWith('--event='))?.split('=')[1]
  || (args.indexOf('--event') !== -1 ? args[args.indexOf('--event') + 1] : null);

// ─── Data source 1: Local JSON files ────────────────────────

function loadLocalArticles(eventId) {
  const filePath = path.join(LOCAL_ARTICLES_DIR, `${eventId}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const articles = (data.articles || data).map((a) => ({
      id: a.url || a.id || `local-${Math.random()}`,
      title: a.title || '',
      description: a.description || a.snippet || '',
      url: a.url || '',
      image: a.image || null,
      publishedAt: a.publishedAt || a.date || new Date().toISOString(),
      source: a.source || a.domain || 'local',
      sourceCategory: a.sourceCategory || 'international',
      sourceReliability: a.sourceReliability || 'medium',
    }));
    console.log(`  Loaded ${articles.length} articles from local file`);
    return articles;
  } catch (err) {
    console.warn(`  Local file error: ${err.message}`);
    return null;
  }
}

// ─── Data source 2: GDELT DOC API ──────────────────────────

function buildGdeltQuery(goldEvent) {
  const parts = [];

  if (goldEvent.expected.country === 'Sudan') {
    parts.push('(sudan OR khartoum OR darfur OR RSF)');
    parts.push('NOT "south sudan"');
  } else if (goldEvent.expected.country === 'South Sudan') {
    parts.push('"south sudan"');
  }

  const regions = goldEvent.expected.regions || [];
  if (regions.length > 0) {
    const regionTerms = regions.map((r) => `"${r.toLowerCase()}"`).join(' OR ');
    parts.push(`(${regionTerms})`);
  }

  const actors = goldEvent.expected.actors || [];
  if (actors.length > 0) {
    const actorTerms = actors
      .map((a) => {
        const match = a.match(/\(([^)]+)\)/);
        return match ? match[1].toLowerCase() : a.toLowerCase();
      })
      .map((a) => `"${a}"`)
      .join(' OR ');
    parts.push(`(${actorTerms})`);
  }

  return parts.join(' ');
}

async function fetchFromGdelt(goldEvent) {
  const query = buildGdeltQuery(goldEvent);
  const [startDate, endDate] = goldEvent.dateRange;
  const start = startDate.replace(/-/g, '') + '000000';
  const end = endDate.replace(/-/g, '') + '235959';

  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(MAX_ARTICLES_PER_EVENT),
    startdatetime: start,
    enddatetime: end,
    sort: 'datedesc',
  });

  const url = `${GDELT_DOC_API}?${params}`;
  console.log(`  GDELT query: ${query}`);
  console.log(`  Date range: ${startDate} to ${endDate}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'HornMonitor-Backtest/1.0' },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`  GDELT HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const articles = (data.articles || []).map((a) => ({
      id: a.url,
      title: a.title || '',
      description: (a.seendate || '') + ' ' + (a.title || ''),
      url: a.url,
      image: a.socialimage || null,
      publishedAt: a.seendate ? new Date(a.seendate).toISOString() : new Date().toISOString(),
      source: a.domain || 'GDELT',
      sourceCategory: 'international',
      sourceReliability: mapGdeltReliability(a.domain),
    }));

    console.log(`  Found ${articles.length} articles from GDELT`);
    return articles.length > 0 ? articles : null;
  } catch (err) {
    console.warn(`  GDELT unavailable: ${err.message}`);
    return null;
  }
}

function mapGdeltReliability(domain) {
  if (!domain) return 'medium';
  const d = domain.toLowerCase();
  if (['reuters', 'bbc', 'aljazeera', 'theguardian', 'france24', 'apnews', 'voanews', 'un.org'].some((s) => d.includes(s))) return 'high';
  if (['sudantribune', 'dabanga', 'radiotamazuj'].some((s) => d.includes(s))) return 'medium';
  return 'medium';
}

// ─── Data source 3: Synthetic articles from gold labels ─────
// When no real data is available, generate representative article
// clusters from the gold-label descriptions. This tests extraction
// accuracy on known-structure input — not article discovery.

function generateSyntheticArticles(goldEvent) {
  const e = goldEvent.expected;
  const d = goldEvent.description;
  const date = goldEvent.date;

  // Generate 3-5 synthetic articles simulating multi-source coverage
  const syntheticSources = [
    { name: 'Reuters', reliability: 'high', category: 'international' },
    { name: 'BBC Africa', reliability: 'high', category: 'international' },
    { name: 'Al Jazeera', reliability: 'high', category: 'international' },
    { name: 'Sudan Tribune', reliability: 'medium', category: 'regional' },
    { name: 'Radio Tamazuj', reliability: 'medium', category: 'local' },
  ];

  const variations = buildSyntheticVariations(goldEvent);

  const articles = variations.map((v, i) => ({
    id: `synthetic-${goldEvent.id}-${i}`,
    title: v.title,
    description: v.body,
    url: `https://example.com/${goldEvent.id}/${i}`,
    image: null,
    publishedAt: new Date(date).toISOString(),
    source: syntheticSources[i % syntheticSources.length].name,
    sourceCategory: syntheticSources[i % syntheticSources.length].category,
    sourceReliability: syntheticSources[i % syntheticSources.length].reliability,
  }));

  console.log(`  Generated ${articles.length} synthetic articles`);
  return articles;
}

function buildSyntheticVariations(goldEvent) {
  const e = goldEvent.expected;
  const regions = (e.regions || []).join(', ') || e.country;
  const actors = (e.actors || []).join(' and ') || 'local forces';

  // Create article variations that simulate real multi-source reporting
  const variations = [];

  // Wire-style breaking news
  variations.push({
    title: goldEvent.description,
    body: `${goldEvent.description}. The incident occurred in ${regions}, ${e.country}. ${actors} were involved in the events. Sources report the situation as ${e.scope === 'national' ? 'affecting the entire country' : e.scope === 'cross_border' ? 'crossing international borders' : `centered in ${regions}`}. International observers are monitoring the situation closely.`,
  });

  // Analysis-style article
  variations.push({
    title: `Analysis: ${e.country} faces ${e.eventType} crisis in ${regions}`,
    body: `The recent ${e.eventType} developments in ${regions}, ${e.country} mark a significant escalation. ${actors} have been at the center of events. ${goldEvent.description}. Aid agencies have expressed concern about the humanitarian impact of the ongoing situation. The ${e.scope} implications are being assessed by regional bodies.`,
  });

  // UN/NGO response article
  variations.push({
    title: `UN responds to ${e.country} ${e.eventType} situation`,
    body: `The United Nations has called for restraint following events in ${regions}, ${e.country}. ${goldEvent.description}. ${actors} have been urged to engage in dialogue. The situation has been classified as a ${e.scope}-level concern by international observers. Humanitarian organizations are mobilizing resources to respond.`,
  });

  // Regional impact article
  if (e.actors && e.actors.length > 0) {
    variations.push({
      title: `${e.actors[0]} implicated in ${regions} ${e.eventType} events`,
      body: `${e.actors[0]} has been directly involved in recent ${e.eventType} events in ${regions}. ${goldEvent.description}. The impact has been felt across ${e.country}, with particular concern for civilian populations. ${e.actors.length > 1 ? e.actors[1] + ' has also been identified as a key actor.' : ''} Regional analysts warn of potential escalation.`,
    });
  }

  return variations;
}

// ─── Extraction ─────────────────────────────────────────────

const MODEL_VERSION = 'llama-3.3-70b-versatile';
const PROMPT_VERSION = 'v2-backtest';

const EXTRACTION_PROMPT = `You are a structured data extractor for a Horn of Africa risk monitoring system.
Given news articles about a story, extract structured event data as JSON.

Return ONLY valid JSON (no markdown, no explanation) with these fields:

{
  "summary": "1-2 sentence factual summary",
  "country": "Primary country (e.g. South Sudan, Sudan, Uganda)",
  "regions": ["Array of specific regions/states mentioned"],
  "eventType": "One of: security, political, economic, humanitarian, infrastructure, legal",
  "eventSubtype": "Specific subtype",
  "severity": 1-5,
  "scope": "One of: local, state, national, cross_border",
  "verificationStatus": "One of: confirmed, reported, unverified",
  "confidence": 0.0-1.0,
  "actors": ["Array of key actors"],
  "rationale": "1-2 sentences explaining severity choice"
}

Severity scale:
1 = Routine  2 = Notable  3 = Significant  4 = Major  5 = Critical

Rules:
- country should be the PRIMARY country affected
- regions should use standard admin names:
  South Sudan states: Upper Nile, Jonglei, Unity, Warrap, Northern Bahr el Ghazal, Western Bahr el Ghazal, Lakes, Western Equatoria, Central Equatoria, Eastern Equatoria
  Sudan states: Khartoum, North Darfur, South Darfur, West Darfur, Central Darfur, East Darfur, South Kordofan, North Kordofan, West Kordofan, Blue Nile, White Nile, Gezira, Sennar, Kassala, Gedaref, Red Sea, River Nile, Northern
- Return ONLY the JSON object, nothing else`;

let groqClient = null;

async function extractCluster(cluster) {
  if (!groqClient) return null;

  const articlesText = cluster.articles
    .slice(0, 5)
    .map((a) => `[${a.source}] ${a.title}\n${a.description || ''}`)
    .join('\n\n');

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const response = await groqClient.chat.completions.create({
        model: MODEL_VERSION,
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: `Extract structured event data:\n\n${articlesText}` },
        ],
        max_tokens: 500,
        temperature: 0.1,
      });

      const raw = response.choices[0]?.message?.content?.trim();
      if (!raw) return null;

      const jsonStr = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
      return JSON.parse(jsonStr);
    } catch (err) {
      if (err.status === 429 && attempt < 2) {
        console.warn(`  Rate limited, waiting ${(attempt + 1) * 3}s...`);
        await sleep((attempt + 1) * 3000);
        continue;
      }
      console.warn(`  Extraction failed: ${err.message}`);
      return null;
    }
  }
  return null;
}

// ─── Scoring ────────────────────────────────────────────────

function scoreExtraction(extracted, expected) {
  const scores = {};
  let total = 0;
  let correct = 0;

  // Country match
  total++;
  const countryMatch = extracted.country?.toLowerCase().includes(expected.country.toLowerCase());
  if (countryMatch) correct++;
  scores.country = countryMatch ? 'PASS' : `FAIL (got "${extracted.country}", expected "${expected.country}")`;

  // Event type match
  total++;
  const typeMatch = extracted.eventType === expected.eventType;
  if (typeMatch) correct++;
  scores.eventType = typeMatch ? 'PASS' : `FAIL (got "${extracted.eventType}", expected "${expected.eventType}")`;

  // Severity meets minimum
  total++;
  const sevMet = extracted.severity >= expected.severityMin;
  if (sevMet) correct++;
  scores.severity = sevMet ? `PASS (${extracted.severity} >= ${expected.severityMin})` : `FAIL (got ${extracted.severity}, expected >= ${expected.severityMin})`;

  // Scope match
  if (expected.scope) {
    total++;
    const scopeMatch = extracted.scope === expected.scope;
    if (scopeMatch) correct++;
    scores.scope = scopeMatch ? 'PASS' : `FAIL (got "${extracted.scope}", expected "${expected.scope}")`;
  }

  // Region overlap
  if (expected.regions && expected.regions.length > 0) {
    total++;
    const extractedRegions = (extracted.regions || []).map((r) => r.toLowerCase());
    const expectedRegions = expected.regions.map((r) => r.toLowerCase());
    const overlap = expectedRegions.filter((r) => extractedRegions.some((er) => er.includes(r) || r.includes(er)));
    const regionMatch = overlap.length > 0;
    if (regionMatch) correct++;
    scores.regions = regionMatch
      ? `PASS (matched: ${overlap.join(', ')})`
      : `FAIL (got [${extractedRegions.join(', ')}], expected [${expectedRegions.join(', ')}])`;
  }

  // Actor overlap
  if (expected.actors && expected.actors.length > 0) {
    total++;
    const extractedActors = (extracted.actors || []).map((a) => a.toLowerCase());
    const expectedActors = expected.actors.map((a) => a.toLowerCase());
    const actorOverlap = expectedActors.filter((ea) =>
      extractedActors.some((xa) => {
        if (xa.includes(ea) || ea.includes(xa)) return true;
        const eaAbbrev = ea.match(/\(([^)]+)\)/)?.[1]?.toLowerCase();
        const xaAbbrev = xa.match(/\(([^)]+)\)/)?.[1]?.toLowerCase();
        if (eaAbbrev && (xa.includes(eaAbbrev) || eaAbbrev === xa)) return true;
        if (xaAbbrev && (ea.includes(xaAbbrev) || xaAbbrev === ea)) return true;
        return false;
      })
    );
    const actorMatch = actorOverlap.length > 0;
    if (actorMatch) correct++;
    scores.actors = actorMatch
      ? `PASS (matched: ${actorOverlap.join(', ')})`
      : `FAIL (got [${extractedActors.join(', ')}], expected [${expectedActors.join(', ')}])`;
  }

  return { scores, accuracy: total > 0 ? Math.round((correct / total) * 100) : 0, correct, total };
}

// ─── Article fetching (cascading sources) ───────────────────

async function getArticlesForEvent(goldEvent) {
  // 1. Try local file first
  if (!forceSynthetic) {
    const local = loadLocalArticles(goldEvent.id);
    if (local && local.length > 0) return { articles: local, source: 'local' };

    // 2. Try GDELT
    const gdelt = await fetchFromGdelt(goldEvent);
    if (gdelt && gdelt.length > 0) return { articles: gdelt, source: 'gdelt' };
  }

  // 3. Fall back to synthetic
  const synthetic = generateSyntheticArticles(goldEvent);
  return { articles: synthetic, source: 'synthetic' };
}

// ─── Main ───────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBacktest() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' HORN MONITOR — BACKTEST PIPELINE');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no extraction)' : 'FULL RUN'}`);
  console.log(`Source: ${forceSynthetic ? 'SYNTHETIC ONLY' : 'local → GDELT → synthetic'}`);
  console.log(`Events: ${eventFilter || 'ALL'}\n`);

  // Init Groq
  if (!dryRun) {
    if (!Groq) {
      console.error('ERROR: groq-sdk not installed. Run: npm install groq-sdk');
      process.exit(1);
    }
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error('ERROR: GROQ_API_KEY required for extraction. Use --dry-run to skip.');
      process.exit(1);
    }
    groqClient = new Groq({ apiKey });
  }

  // Filter events
  let events = goldLabels.events;
  if (eventFilter) {
    events = events.filter((e) => e.id === eventFilter);
    if (events.length === 0) {
      console.error(`No event found with id: ${eventFilter}`);
      console.log('Available:', goldLabels.events.map((e) => e.id).join(', '));
      process.exit(1);
    }
  }

  // Ensure output directory
  fs.mkdirSync(LOCAL_ARTICLES_DIR, { recursive: true });

  const results = [];

  for (const goldEvent of events) {
    console.log(`\n─── ${goldEvent.id} ───────────────────────────`);
    console.log(`  ${goldEvent.description}`);
    console.log(`  Expected: ${goldEvent.expected.country} | ${goldEvent.expected.eventType} | sev >= ${goldEvent.expected.severityMin}`);

    // Step 1: Get articles
    const { articles, source: dataSource } = await getArticlesForEvent(goldEvent);
    console.log(`  Data source: ${dataSource}`);

    if (articles.length === 0) {
      results.push({ event: goldEvent.id, status: 'no_articles', accuracy: 0 });
      continue;
    }

    // Step 2: Cluster
    const clusters = clusterArticles(articles);
    console.log(`  Clusters: ${clusters.length} (from ${articles.length} articles)`);

    if (dryRun) {
      console.log('  DRY RUN: Skipping extraction');
      console.log(`  Top cluster: "${clusters[0]?.primaryArticle?.title?.slice(0, 80)}..."`);
      results.push({
        event: goldEvent.id,
        status: 'dry_run',
        dataSource,
        articles: articles.length,
        clusters: clusters.length,
        topClusterTitle: clusters[0]?.primaryArticle?.title,
      });
      continue;
    }

    // Step 3: Extract top cluster
    const topCluster = clusters[0];
    if (!topCluster) {
      results.push({ event: goldEvent.id, status: 'no_clusters', accuracy: 0, dataSource });
      continue;
    }

    console.log(`  Extracting: "${topCluster.primaryArticle.title.slice(0, 80)}..."`);
    const extracted = await extractCluster(topCluster);

    if (!extracted) {
      results.push({ event: goldEvent.id, status: 'extraction_failed', accuracy: 0, dataSource });
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    console.log(`  Extracted: ${extracted.country} | ${extracted.eventType} | sev ${extracted.severity} | ${extracted.scope}`);
    console.log(`  Actors: ${(extracted.actors || []).join(', ')}`);
    console.log(`  Regions: ${(extracted.regions || []).join(', ')}`);

    // Step 4: Score
    const score = scoreExtraction(extracted, goldEvent.expected);
    console.log(`\n  SCORE: ${score.accuracy}% (${score.correct}/${score.total})`);
    for (const [field, result] of Object.entries(score.scores)) {
      const icon = result.startsWith('PASS') ? '  +' : '  -';
      console.log(`  ${icon} ${field}: ${result}`);
    }

    results.push({
      event: goldEvent.id,
      status: 'scored',
      dataSource,
      accuracy: score.accuracy,
      details: score.scores,
      extracted: {
        summary: extracted.summary,
        country: extracted.country,
        eventType: extracted.eventType,
        severity: extracted.severity,
        scope: extracted.scope,
        actors: extracted.actors,
        regions: extracted.regions,
        confidence: extracted.confidence,
      },
    });

    await sleep(REQUEST_DELAY_MS);
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' BACKTEST RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════\n');

  const scored = results.filter((r) => r.status === 'scored');
  const failed = results.filter((r) => r.status !== 'scored' && r.status !== 'dry_run');
  const dryResults = results.filter((r) => r.status === 'dry_run');

  if (scored.length > 0) {
    const avgAccuracy = Math.round(scored.reduce((sum, r) => sum + r.accuracy, 0) / scored.length);
    console.log(`Overall accuracy: ${avgAccuracy}% across ${scored.length} events\n`);

    // Field-level breakdown
    const fieldTotals = {};
    for (const r of scored) {
      for (const [field, result] of Object.entries(r.details)) {
        if (!fieldTotals[field]) fieldTotals[field] = { pass: 0, total: 0 };
        fieldTotals[field].total++;
        if (result.startsWith('PASS')) fieldTotals[field].pass++;
      }
    }
    console.log('Field-level accuracy:');
    for (const [field, data] of Object.entries(fieldTotals)) {
      const pct = Math.round((data.pass / data.total) * 100);
      console.log(`  ${field}: ${pct}% (${data.pass}/${data.total})`);
    }
    console.log('');

    for (const r of scored) {
      const icon = r.accuracy >= 80 ? 'PASS' : r.accuracy >= 60 ? 'PARTIAL' : 'FAIL';
      console.log(`  [${icon}] ${r.event}: ${r.accuracy}% (${r.dataSource})`);
    }
  }

  if (failed.length > 0) {
    console.log(`\nFailed/skipped: ${failed.length}`);
    for (const r of failed) {
      console.log(`  [SKIP] ${r.event}: ${r.status}`);
    }
  }

  if (dryResults.length > 0) {
    console.log('\nDry run results:');
    for (const r of dryResults) {
      console.log(`  ${r.event}: ${r.articles} articles, ${r.clusters} clusters (${r.dataSource})`);
    }
  }

  // Write results to file
  const outputPath = path.join(__dirname, '..', 'data', 'backtest-results.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    runAt: new Date().toISOString(),
    mode: dryRun ? 'dry_run' : 'full',
    eventsTotal: events.length,
    eventsScored: scored.length,
    overallAccuracy: scored.length > 0
      ? Math.round(scored.reduce((sum, r) => sum + r.accuracy, 0) / scored.length)
      : null,
    results,
  }, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

runBacktest().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
