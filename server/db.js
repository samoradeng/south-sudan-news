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
      actors_normalized TEXT,    -- JSON array: normalized actor names

      -- Provenance: audit trail for every extraction
      model_version TEXT,        -- e.g. "llama-3.3-70b-versatile"
      prompt_version TEXT,       -- e.g. "v2"
      article_urls TEXT,         -- JSON array of source article URLs

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

    -- Quarantine: borderline/failed extractions kept for learning
    CREATE TABLE IF NOT EXISTS quarantine_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_hash TEXT NOT NULL,
      raw_output TEXT,           -- raw model response
      error_reasons TEXT,        -- JSON array of why it failed
      primary_title TEXT,
      primary_url TEXT,
      sources TEXT,              -- JSON array
      article_urls TEXT,         -- JSON array
      model_version TEXT,
      prompt_version TEXT,
      quarantined_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_quarantine_hash ON quarantine_events(cluster_hash);
  `);

  // Migrations: add columns if missing (for existing DBs)
  const migrations = [
    'ALTER TABLE events ADD COLUMN rationale TEXT',
    'ALTER TABLE events ADD COLUMN actors_normalized TEXT',
    'ALTER TABLE events ADD COLUMN model_version TEXT',
    'ALTER TABLE events ADD COLUMN prompt_version TEXT',
    'ALTER TABLE events ADD COLUMN article_urls TEXT',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
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

// Check if this cluster has already been extracted (or quarantined)
function eventExists(hash) {
  if (!db) return false;
  const inEvents = db.prepare('SELECT 1 FROM events WHERE cluster_hash = ?').get(hash);
  if (inEvents) return true;
  const inQuarantine = db.prepare('SELECT 1 FROM quarantine_events WHERE cluster_hash = ?').get(hash);
  return !!inQuarantine;
}

// Insert a structured event
function insertEvent(event) {
  if (!db) return;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events (
      cluster_hash, summary, country, regions,
      event_type, event_subtype, severity, scope,
      source_tier, verification_status, confidence, rationale,
      actors, actors_normalized,
      model_version, prompt_version, article_urls,
      article_count, sources, primary_url, primary_title,
      published_at
    ) VALUES (
      @cluster_hash, @summary, @country, @regions,
      @event_type, @event_subtype, @severity, @scope,
      @source_tier, @verification_status, @confidence, @rationale,
      @actors, @actors_normalized,
      @model_version, @prompt_version, @article_urls,
      @article_count, @sources, @primary_url, @primary_title,
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
    actors_normalized: JSON.stringify(event.actors_normalized || []),
    model_version: event.model_version || null,
    prompt_version: event.prompt_version || null,
    article_urls: JSON.stringify(event.article_urls || []),
    article_count: event.article_count || 1,
    sources: JSON.stringify(event.sources || []),
    primary_url: event.primary_url,
    primary_title: event.primary_title,
    published_at: event.published_at,
  });
}

// Insert a quarantined extraction (borderline/failed)
function insertQuarantine(record) {
  if (!db) return;

  db.prepare(`
    INSERT INTO quarantine_events (
      cluster_hash, raw_output, error_reasons,
      primary_title, primary_url, sources, article_urls,
      model_version, prompt_version
    ) VALUES (
      @cluster_hash, @raw_output, @error_reasons,
      @primary_title, @primary_url, @sources, @article_urls,
      @model_version, @prompt_version
    )
  `).run({
    cluster_hash: record.cluster_hash,
    raw_output: record.raw_output || null,
    error_reasons: JSON.stringify(record.error_reasons || []),
    primary_title: record.primary_title || null,
    primary_url: record.primary_url || null,
    sources: JSON.stringify(record.sources || []),
    article_urls: JSON.stringify(record.article_urls || []),
    model_version: record.model_version || null,
    prompt_version: record.prompt_version || null,
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
  // Prefer normalized actors, fall back to raw
  const events = db.prepare('SELECT actors, actors_normalized FROM events').all();

  const counts = {};
  for (const row of events) {
    try {
      const actors = JSON.parse(row.actors_normalized || row.actors || '[]');
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

// ─── Data quality metrics ───────────────────────────────────────

function getDataQuality() {
  if (!db) return null;

  const quarantineTotal = db.prepare('SELECT COUNT(*) as count FROM quarantine_events').get();
  const quarantine24h = db.prepare(
    "SELECT COUNT(*) as count FROM quarantine_events WHERE quarantined_at > datetime('now', '-1 day')"
  ).get();
  const quarantine7d = db.prepare(
    "SELECT COUNT(*) as count FROM quarantine_events WHERE quarantined_at > datetime('now', '-7 days')"
  ).get();

  const eventsTotal = db.prepare('SELECT COUNT(*) as count FROM events').get();
  const events24h = db.prepare(
    "SELECT COUNT(*) as count FROM events WHERE extracted_at > datetime('now', '-1 day')"
  ).get();

  // Confidence trend: average per day for last 7 days
  const confidenceTrend = db.prepare(`
    SELECT DATE(extracted_at) as day, ROUND(AVG(confidence), 2) as avg_confidence, COUNT(*) as count
    FROM events
    WHERE extracted_at > datetime('now', '-7 days')
    GROUP BY DATE(extracted_at)
    ORDER BY day
  `).all();

  // Missing regions by source
  const missingBySource = db.prepare(`
    SELECT s.value as source_name,
           COUNT(*) as total,
           SUM(CASE WHEN e.regions = '[]' OR e.regions IS NULL THEN 1 ELSE 0 END) as missing
    FROM events e, json_each(e.sources) s
    GROUP BY s.value
    ORDER BY missing DESC
  `).all();

  // Severity distribution sanity
  const sevDistrib = db.prepare(
    'SELECT severity, COUNT(*) as count FROM events GROUP BY severity ORDER BY severity'
  ).all();

  // Recent quarantine reasons
  const recentQuarantine = db.prepare(
    'SELECT primary_title, error_reasons, quarantined_at FROM quarantine_events ORDER BY quarantined_at DESC LIMIT 10'
  ).all();

  return {
    quarantine: { total: quarantineTotal.count, last24h: quarantine24h.count, last7d: quarantine7d.count },
    events: { total: eventsTotal.count, last24h: events24h.count },
    acceptRate: eventsTotal.count + quarantineTotal.count > 0
      ? Math.round((eventsTotal.count / (eventsTotal.count + quarantineTotal.count)) * 100) : 100,
    confidenceTrend,
    missingBySource,
    sevDistrib,
    recentQuarantine,
  };
}

// ─── Week-over-week comparison queries (for Risk Delta) ────────

function getEventsForPeriod(startDate, endDate) {
  if (!db) return [];
  return db.prepare(
    `SELECT * FROM events
     WHERE extracted_at >= ? AND extracted_at < ?
     ORDER BY severity DESC, published_at DESC`
  ).all(startDate, endDate);
}

function getTypeCountsForPeriod(startDate, endDate) {
  if (!db) return [];
  return db.prepare(
    `SELECT event_type, COUNT(*) as count, ROUND(AVG(severity), 1) as avg_severity
     FROM events
     WHERE extracted_at >= ? AND extracted_at < ?
     GROUP BY event_type ORDER BY count DESC`
  ).all(startDate, endDate);
}

function getRegionSeverityForPeriod(startDate, endDate) {
  if (!db) return [];
  const events = db.prepare(
    `SELECT regions, severity FROM events
     WHERE extracted_at >= ? AND extracted_at < ?`
  ).all(startDate, endDate);

  const regionScores = {};
  for (const row of events) {
    try {
      const regions = JSON.parse(row.regions || '[]');
      for (const region of regions) {
        const r = region.trim();
        if (!r) continue;
        if (!regionScores[r]) regionScores[r] = { count: 0, severitySum: 0 };
        regionScores[r].count++;
        regionScores[r].severitySum += row.severity;
      }
    } catch { /* skip */ }
  }

  return Object.entries(regionScores)
    .map(([region, data]) => ({
      region,
      count: data.count,
      severityWeighted: Math.round(data.severitySum * 10) / 10,
      avgSeverity: Math.round((data.severitySum / data.count) * 10) / 10,
    }))
    .sort((a, b) => b.severityWeighted - a.severityWeighted);
}

function getActorCountsForPeriod(startDate, endDate) {
  if (!db) return [];
  const events = db.prepare(
    `SELECT actors_normalized, actors FROM events
     WHERE extracted_at >= ? AND extracted_at < ?`
  ).all(startDate, endDate);

  const counts = {};
  for (const row of events) {
    try {
      const actors = JSON.parse(row.actors_normalized || row.actors || '[]');
      for (const actor of actors) {
        const a = actor.trim();
        if (a) counts[a] = (counts[a] || 0) + 1;
      }
    } catch { /* skip */ }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([actor, count]) => ({ actor, count }));
}

module.exports = {
  initDB, clusterHash, eventExists, insertEvent, insertQuarantine,
  getEventStats, getAllEvents, getHighSeverityEvents, getTopActors, getEventsByRegion,
  getDataQuality,
  getEventsForPeriod, getTypeCountsForPeriod, getRegionSeverityForPeriod, getActorCountsForPeriod,
};
