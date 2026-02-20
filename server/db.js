// SQLite persistence for structured event data
// This is the "data asset" — every article becomes a tagged, queryable datapoint.
// The news site keeps running unchanged; this layer grows quietly underneath.

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

let db = null;

function initDB() {
  const dbPath = path.join(__dirname, '..', 'data', 'events.db');

  // Ensure data directory exists
  const fs = require('fs');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Dedup: hash of sorted article titles in cluster
      cluster_hash TEXT NOT NULL UNIQUE,

      -- AI-generated summary
      summary TEXT,

      -- Geo
      country TEXT NOT NULL DEFAULT 'South Sudan',
      regions TEXT,              -- JSON array: ["Upper Nile", "Jonglei"]

      -- Classification
      event_type TEXT NOT NULL,  -- security, political, economic, humanitarian, infrastructure, legal
      event_subtype TEXT,        -- e.g. clash, peace_talks, displacement

      -- Severity & scope
      severity INTEGER CHECK(severity BETWEEN 1 AND 5),
      scope TEXT CHECK(scope IN ('local', 'state', 'national', 'cross_border')),

      -- Source quality
      source_tier TEXT CHECK(source_tier IN ('tier1', 'tier2', 'tier3')),
      verification_status TEXT CHECK(verification_status IN ('confirmed', 'reported', 'unverified')),
      confidence REAL CHECK(confidence BETWEEN 0.0 AND 1.0),

      -- AI rationale for severity/verification decisions
      rationale TEXT,

      -- Actors
      actors TEXT,               -- JSON array: ["SPLM-IO", "UNMISS"]

      -- Article metadata
      article_count INTEGER,
      sources TEXT,              -- JSON array of source names
      primary_url TEXT,
      primary_title TEXT,

      -- Timestamps
      published_at TEXT,
      extracted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_country ON events(country);
    CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);
    CREATE INDEX IF NOT EXISTS idx_events_published ON events(published_at);
  `);

  // Migration: add rationale column if missing (for existing DBs)
  try {
    db.exec('ALTER TABLE events ADD COLUMN rationale TEXT');
  } catch {
    // Column already exists — ignore
  }

  console.log('Event database initialized');
  return db;
}

// Generate a stable hash for a cluster based on its article titles
function clusterHash(cluster) {
  const titles = cluster.articles
    .map((a) => a.title.toLowerCase().trim())
    .sort()
    .join('|');
  return crypto.createHash('md5').update(titles).digest('hex');
}

// Check if this cluster has already been extracted
function eventExists(hash) {
  if (!db) return false;
  const row = db.prepare('SELECT 1 FROM events WHERE cluster_hash = ?').get(hash);
  return !!row;
}

// Insert a structured event
function insertEvent(event) {
  if (!db) return;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events (
      cluster_hash, summary, country, regions,
      event_type, event_subtype, severity, scope,
      source_tier, verification_status, confidence, rationale,
      actors, article_count, sources, primary_url, primary_title,
      published_at
    ) VALUES (
      @cluster_hash, @summary, @country, @regions,
      @event_type, @event_subtype, @severity, @scope,
      @source_tier, @verification_status, @confidence, @rationale,
      @actors, @article_count, @sources, @primary_url, @primary_title,
      @published_at
    )
  `);

  stmt.run({
    cluster_hash: event.cluster_hash,
    summary: event.summary,
    country: event.country,
    regions: JSON.stringify(event.regions || []),
    event_type: event.event_type,
    event_subtype: event.event_subtype || null,
    severity: event.severity,
    scope: event.scope || 'local',
    source_tier: event.source_tier,
    verification_status: event.verification_status || 'reported',
    confidence: event.confidence || 0.5,
    rationale: event.rationale || null,
    actors: JSON.stringify(event.actors || []),
    article_count: event.article_count || 1,
    sources: JSON.stringify(event.sources || []),
    primary_url: event.primary_url,
    primary_title: event.primary_title,
    published_at: event.published_at,
  });
}

// ─── Query functions for admin dashboard ────────────────────────

function getEventStats() {
  if (!db) return null;

  const total = db.prepare('SELECT COUNT(*) as count FROM events').get();
  const byType = db.prepare(
    'SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC'
  ).all();
  const bySeverity = db.prepare(
    'SELECT severity, COUNT(*) as count FROM events GROUP BY severity ORDER BY severity'
  ).all();
  const recent = db.prepare(
    "SELECT COUNT(*) as count FROM events WHERE extracted_at > datetime('now', '-7 days')"
  ).get();
  const byCountry = db.prepare(
    'SELECT country, COUNT(*) as count FROM events GROUP BY country ORDER BY count DESC'
  ).all();
  const avgConfidence = db.prepare(
    'SELECT ROUND(AVG(confidence), 2) as avg FROM events'
  ).get();
  const missingRegions = db.prepare(
    "SELECT COUNT(*) as count FROM events WHERE regions = '[]' OR regions IS NULL"
  ).get();

  return {
    totalEvents: total.count,
    byType,
    bySeverity,
    byCountry,
    lastWeek: recent.count,
    avgConfidence: avgConfidence.avg,
    missingRegions: missingRegions.count,
  };
}

function getAllEvents(limit = 100, offset = 0) {
  if (!db) return [];
  return db.prepare(
    'SELECT * FROM events ORDER BY published_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}

function getHighSeverityEvents(minSeverity = 4, days = 7) {
  if (!db) return [];
  return db.prepare(
    `SELECT * FROM events
     WHERE severity >= ?
       AND extracted_at > datetime('now', '-' || ? || ' days')
     ORDER BY severity DESC, published_at DESC`
  ).all(minSeverity, days);
}

function getTopActors(limit = 20) {
  if (!db) return [];
  const events = db.prepare('SELECT actors FROM events').all();

  const counts = {};
  for (const row of events) {
    try {
      const actors = JSON.parse(row.actors || '[]');
      for (const actor of actors) {
        const normalized = actor.trim();
        if (normalized) counts[normalized] = (counts[normalized] || 0) + 1;
      }
    } catch { /* skip malformed */ }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([actor, count]) => ({ actor, count }));
}

function getEventsByRegion() {
  if (!db) return [];
  const events = db.prepare('SELECT regions FROM events').all();

  const counts = {};
  for (const row of events) {
    try {
      const regions = JSON.parse(row.regions || '[]');
      for (const region of regions) {
        const normalized = region.trim();
        if (normalized) counts[normalized] = (counts[normalized] || 0) + 1;
      }
    } catch { /* skip malformed */ }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([region, count]) => ({ region, count }));
}

module.exports = {
  initDB, clusterHash, eventExists, insertEvent,
  getEventStats, getAllEvents, getHighSeverityEvents, getTopActors, getEventsByRegion,
};
