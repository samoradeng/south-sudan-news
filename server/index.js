const express = require('express');
const path = require('path');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const { fetchAllSources } = require('./fetcher');
const { clusterArticles } = require('./cluster');
const { initGroq, extractiveSummary, deepSummarizeCluster, answerFollowUp } = require('./summarizer');
const { initDB, clusterHash, getEventByClusterHash, getIntelligenceSnapshot, getEventStats, getAllEvents, getHighSeverityEvents, getTopActors, getEventsByRegion, getDataQuality, generateUnsubToken, isUnsubscribed, addUnsubscribe } = require('./db');
const { initExtractor, extractAllEvents } = require('./extractor');
const { generateDigest, renderDigestHTML, renderDigestText } = require('./digest');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Cache: articles for 15 minutes, summaries for 30 minutes
const cache = new NodeCache();
const CLUSTERS_TTL = 30 * 60;
const DEEP_TTL = 60 * 60; // Deep summaries cached 1 hour

// Initialize database (structured event storage)
initDB();

// Initialize Groq if API key is available (free tier)
if (process.env.GROQ_API_KEY) {
  initGroq(process.env.GROQ_API_KEY);
  initExtractor(process.env.GROQ_API_KEY);
  console.log('Groq AI summarization enabled');
} else {
  console.log('No GROQ_API_KEY found — running without AI summaries (extractive fallback)');
  console.log('Get a free key at https://console.groq.com to enable AI summaries');
}

// ─── Middleware ──────────────────────────────────────────────────

app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Basic auth for /admin ──────────────────────────────────────
// Set ADMIN_TOKEN in .env. If not set, admin is open (dev mode).

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // No token configured = dev mode

  // Check Authorization: Bearer <token>
  const auth = req.headers.authorization;
  if (auth && auth === `Bearer ${ADMIN_TOKEN}`) return next();

  // Check ?token= query param (for browser access to /admin)
  if (req.query.token === ADMIN_TOKEN) return next();

  // Check Basic Auth
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const [, password] = decoded.split(':');
    if (password === ADMIN_TOKEN) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Horn Monitor Admin"');
  return res.status(401).json({ error: 'Unauthorized' });
}

// ─── Rate limiting ──────────────────────────────────────────────
// Simple in-memory rate limiter. No dependencies.

const rateLimitStore = {};

function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    if (!rateLimitStore[key]) rateLimitStore[key] = [];

    // Drop expired entries
    rateLimitStore[key] = rateLimitStore[key].filter(t => t > now - windowMs);

    if (rateLimitStore[key].length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please wait.' });
    }

    rateLimitStore[key].push(now);
    next();
  };
}

// Clean up rate limit store every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 600000;
  for (const key of Object.keys(rateLimitStore)) {
    rateLimitStore[key] = rateLimitStore[key].filter(t => t > cutoff);
    if (rateLimitStore[key].length === 0) delete rateLimitStore[key];
  }
}, 300000);

// Apply rate limits
const apiLimiter = rateLimit(60000, 30);     // 30 req/min for general API
const aiLimiter = rateLimit(60000, 5);       // 5 req/min for AI-powered endpoints
const sendLimiter = rateLimit(3600000, 3);   // 3 sends/hour for digest

// ─── Public API ─────────────────────────────────────────────────

// Enrich clusters with intelligence data from events DB (always fresh)
function enrichClusters(clusters) {
  const enriched = clusters.map((c) => {
    const hash = clusterHash(c);
    const event = getEventByClusterHash(hash);
    if (!event) return c;
    return {
      ...c,
      event: {
        severity: event.severity,
        eventType: event.event_type,
        eventSubtype: event.event_subtype,
        verificationStatus: event.verification_status,
        actors: JSON.parse(event.actors_normalized || event.actors || '[]'),
        regions: JSON.parse(event.regions || '[]'),
        scope: event.scope,
        rationale: event.rationale,
      },
    };
  });

  // Sort by severity (highest first), then recency
  enriched.sort((a, b) => {
    const sevA = a.event?.severity || 0;
    const sevB = b.event?.severity || 0;
    if (sevB !== sevA) return sevB - sevA;
    return new Date(b.latestDate) - new Date(a.latestDate);
  });

  return enriched;
}

app.get('/api/news', apiLimiter, async (req, res) => {
  try {
    let rawData = cache.get('clusters-raw');

    if (!rawData) {
      console.log('Fetching articles from all sources...');
      const articles = await fetchAllSources();
      console.log(`Fetched ${articles.length} articles total`);

      if (articles.length === 0) {
        return res.json({ clusters: [], totalArticles: 0, sources: [] });
      }

      const clusters = clusterArticles(articles);
      console.log(`Grouped into ${clusters.length} story clusters`);

      const summarized = clusters.map((c) => ({
        ...c,
        summary: extractiveSummary(c),
      }));

      rawData = {
        clusters: summarized,
        totalArticles: articles.length,
        sources: [...new Set(articles.map((a) => a.source))],
        lastUpdated: new Date().toISOString(),
      };

      cache.set('clusters-raw', rawData, CLUSTERS_TTL);

      // Background: extract structured event data
      extractAllEvents(summarized).catch((err) => {
        console.error('Background event extraction error:', err.message);
      });
    }

    // Always enrich from events DB (picks up newly extracted events immediately)
    const enriched = enrichClusters(rawData.clusters);
    res.json({ ...rawData, clusters: enriched });
  } catch (err) {
    console.error('Error in /api/news:', err);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

app.get('/api/story/:index', aiLimiter, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const rawData = cache.get('clusters-raw');

    if (!rawData || !rawData.clusters) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Enrich to get sorted order matching what the frontend sees
    const enriched = enrichClusters(rawData.clusters);
    if (!enriched[index]) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const cluster = enriched[index];
    const deepKey = `deep-${cluster.primaryArticle.title.slice(0, 50)}`;
    const cachedDeep = cache.get(deepKey);
    if (cachedDeep) {
      return res.json(cachedDeep);
    }

    console.log(`Generating deep summary for story ${index}: "${cluster.primaryArticle.title.slice(0, 60)}..."`);

    const deepSummary = await deepSummarizeCluster(cluster);

    const response = {
      ...cluster,
      deepSummary,
    };

    cache.set(deepKey, response, DEEP_TTL);
    res.json(response);
  } catch (err) {
    console.error('Error in /api/story:', err);
    res.status(500).json({ error: 'Failed to generate story analysis' });
  }
});

app.post('/api/followup', aiLimiter, async (req, res) => {
  try {
    const { question, storyIndex } = req.body;

    if (!question || typeof storyIndex !== 'number') {
      return res.status(400).json({ error: 'Missing question or storyIndex' });
    }

    const rawData = cache.get('clusters-raw');
    if (!rawData || !rawData.clusters) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const enriched = enrichClusters(rawData.clusters);
    if (!enriched[storyIndex]) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const cluster = enriched[storyIndex];
    const answer = await answerFollowUp(cluster, question);

    res.json({ answer });
  } catch (err) {
    console.error('Error in /api/followup:', err);
    res.status(500).json({ error: 'Failed to answer question' });
  }
});

app.post('/api/news/refresh', apiLimiter, async (req, res) => {
  cache.del('clusters-raw');
  cache.del('intelligence');
  const keys = cache.keys();
  keys.filter((k) => k.startsWith('deep-')).forEach((k) => cache.del(k));
  res.json({ message: 'Cache cleared. Next request will fetch fresh data.' });
});

// Public intelligence snapshot (for homepage banner)
app.get('/api/intelligence', apiLimiter, (req, res) => {
  const cached = cache.get('intelligence');
  if (cached) return res.json(cached);

  const snapshot = getIntelligenceSnapshot();
  if (snapshot) {
    cache.set('intelligence', snapshot, 300); // 5 min cache
  }
  res.json(snapshot || { eventsThisWeek: 0, highSeverityCount: 0, topRegion: null, topActor: null, severityDistribution: [] });
});

// Health check (public — no auth, no rate limit)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    aiEnabled: !!process.env.GROQ_API_KEY,
    emailEnabled: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
    adminProtected: !!ADMIN_TOKEN,
  });
});

// ─── Unsubscribe endpoint (public) ─────────────────────────────

app.get('/unsubscribe', (req, res) => {
  const { email, token } = req.query;
  if (!email || !token) {
    return res.status(400).type('html').send('<html><body><h2>Invalid unsubscribe link.</h2></body></html>');
  }

  const expected = generateUnsubToken(email);
  if (token !== expected) {
    return res.status(400).type('html').send('<html><body><h2>Invalid unsubscribe link.</h2></body></html>');
  }

  addUnsubscribe(email, token);
  res.type('html').send(`<html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center">
    <h2>Unsubscribed</h2>
    <p style="color:#666">${email} has been removed from the Horn Risk Delta mailing list.</p>
  </body></html>`);
});

// ─── Admin API (auth-protected) ─────────────────────────────────

app.get('/api/admin/events', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  res.json({ events: getAllEvents(limit, offset), stats: getEventStats() });
});

app.get('/api/admin/alerts', requireAdmin, (req, res) => {
  const minSeverity = parseInt(req.query.minSeverity) || 4;
  const days = parseInt(req.query.days) || 7;
  res.json({ alerts: getHighSeverityEvents(minSeverity, days) });
});

app.get('/api/admin/actors', requireAdmin, (req, res) => {
  res.json({ actors: getTopActors() });
});

app.get('/api/admin/regions', requireAdmin, (req, res) => {
  res.json({ regions: getEventsByRegion() });
});

app.get('/api/admin/quality', requireAdmin, (req, res) => {
  res.json(getDataQuality());
});

app.get('/api/admin/digest', requireAdmin, (req, res) => {
  const digest = generateDigest();
  res.json(digest);
});

app.get('/api/admin/digest/html', requireAdmin, (req, res) => {
  const digest = generateDigest();
  const html = renderDigestHTML(digest);
  res.type('html').send(html);
});

app.get('/api/admin/digest/text', requireAdmin, (req, res) => {
  const digest = generateDigest();
  const text = renderDigestText(digest);
  res.type('text').send(text);
});

app.post('/api/admin/digest/send', requireAdmin, sendLimiter, (req, res) => {
  const { exec } = require('child_process');
  const mode = req.query.test === 'true' ? '--test' : '';
  exec(`node ${path.join(__dirname, 'send-digest.js')} ${mode}`, (err, stdout, stderr) => {
    const output = (stdout || '') + (stderr || '');
    if (err) {
      return res.status(500).json({ error: 'Send failed', output: output.trim() });
    }
    res.json({ message: 'Digest sent', output: output.trim() });
  });
});

// Serve admin dashboard (auth-protected)
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ─── Start server ──────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Horn Monitor running at http://localhost:${PORT}`);
  if (ADMIN_TOKEN) {
    console.log('Admin dashboard protected (ADMIN_TOKEN set)');
  } else {
    console.log('WARNING: Admin dashboard is OPEN (set ADMIN_TOKEN in .env to protect it)');
  }

  // ─── Background extraction: runs every 15 minutes ──────────
  const EXTRACTION_INTERVAL_MS = 15 * 60 * 1000;

  async function backgroundFetchAndExtract() {
    try {
      let data = cache.get('clusters-raw');
      if (!data) {
        console.log('[background] Fetching fresh articles for extraction...');
        const articles = await fetchAllSources();
        if (articles.length === 0) return;
        const clusters = clusterArticles(articles);
        const summarized = clusters.map((c) => ({
          ...c,
          summary: extractiveSummary(c),
        }));
        data = {
          clusters: summarized,
          totalArticles: articles.length,
          sources: [...new Set(articles.map((a) => a.source))],
          lastUpdated: new Date().toISOString(),
        };
        cache.set('clusters-raw', data, CLUSTERS_TTL);
      }
      await extractAllEvents(data.clusters);
      // Clear intelligence cache so banner updates after extraction
      cache.del('intelligence');
    } catch (err) {
      console.error('[background] Extraction cycle error:', err.message);
    }
  }

  if (process.env.GROQ_API_KEY) {
    setInterval(backgroundFetchAndExtract, EXTRACTION_INTERVAL_MS);
    console.log(`Background extraction scheduled every ${EXTRACTION_INTERVAL_MS / 60000} minutes`);
  }

  // ─── Weekly digest email: Monday 7:00 AM (server timezone) ──
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    const DIGEST_DAY = 1;  // Monday
    const DIGEST_HOUR = 7; // 7:00 AM

    function scheduleNextDigest() {
      const now = new Date();
      const next = new Date(now);
      next.setDate(next.getDate() + ((DIGEST_DAY + 7 - next.getDay()) % 7 || 7));
      next.setHours(DIGEST_HOUR, 0, 0, 0);

      if (now.getDay() === DIGEST_DAY && now.getHours() < DIGEST_HOUR) {
        next.setDate(now.getDate());
      }

      const msUntil = next - now;
      console.log(`Weekly digest scheduled for ${next.toLocaleString()} (in ${Math.round(msUntil / 3600000)}h)`);

      setTimeout(async () => {
        try {
          console.log('[digest] Sending weekly email digest...');
          const { exec } = require('child_process');
          exec('node ' + path.join(__dirname, 'send-digest.js'), (err, stdout, stderr) => {
            if (stdout) console.log(stdout.trim());
            if (stderr) console.error(stderr.trim());
            if (err) console.error('[digest] Send failed:', err.message);
          });
        } catch (err) {
          console.error('[digest] Error:', err.message);
        }
        scheduleNextDigest();
      }, msUntil);
    }

    scheduleNextDigest();
  }
});
