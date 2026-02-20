const express = require('express');
const path = require('path');
const NodeCache = require('node-cache');
const { fetchAllSources } = require('./fetcher');
const { clusterArticles } = require('./cluster');
const { initGroq, extractiveSummary, deepSummarizeCluster, answerFollowUp } = require('./summarizer');
const { initDB, getEventStats, getAllEvents, getHighSeverityEvents, getTopActors, getEventsByRegion, getDataQuality } = require('./db');
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

// Parse JSON bodies
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// API: Get clustered, summarized news (feed view)
app.get('/api/news', async (req, res) => {
  try {
    const cached = cache.get('clusters');
    if (cached) {
      return res.json(cached);
    }

    console.log('Fetching articles from all sources...');
    const articles = await fetchAllSources();
    console.log(`Fetched ${articles.length} articles total`);

    if (articles.length === 0) {
      return res.json({ clusters: [], totalArticles: 0, sources: [] });
    }

    const clusters = clusterArticles(articles);
    console.log(`Grouped into ${clusters.length} story clusters`);

    // Use extractive summaries for instant feed loading (no AI calls).
    // AI summaries are generated on-demand when user clicks into a story.
    const summarized = clusters.map((c) => ({
      ...c,
      summary: extractiveSummary(c),
    }));

    const response = {
      clusters: summarized,
      totalArticles: articles.length,
      sources: [...new Set(articles.map((a) => a.source))],
      lastUpdated: new Date().toISOString(),
    };

    cache.set('clusters', response, CLUSTERS_TTL);
    res.json(response);

    // Background: extract structured event data for all clusters
    // This runs AFTER the response is sent — doesn't block the user
    extractAllEvents(summarized).catch((err) => {
      console.error('Background event extraction error:', err.message);
    });
  } catch (err) {
    console.error('Error in /api/news:', err);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// API: Deep summary for story detail view
app.get('/api/story/:index', async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const cached = cache.get('clusters');

    if (!cached || !cached.clusters[index]) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Check deep summary cache
    const deepKey = `deep-${index}`;
    const cachedDeep = cache.get(deepKey);
    if (cachedDeep) {
      return res.json(cachedDeep);
    }

    const cluster = cached.clusters[index];
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

// API: Follow-up question
app.post('/api/followup', async (req, res) => {
  try {
    const { question, storyIndex } = req.body;

    if (!question || typeof storyIndex !== 'number') {
      return res.status(400).json({ error: 'Missing question or storyIndex' });
    }

    const cached = cache.get('clusters');
    if (!cached || !cached.clusters[storyIndex]) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const cluster = cached.clusters[storyIndex];
    const answer = await answerFollowUp(cluster, question);

    res.json({ answer });
  } catch (err) {
    console.error('Error in /api/followup:', err);
    res.status(500).json({ error: 'Failed to answer question' });
  }
});

// API: Force refresh (bypass cache)
app.post('/api/news/refresh', async (req, res) => {
  cache.del('clusters');
  // Also clear all deep summary caches
  const keys = cache.keys();
  keys.filter((k) => k.startsWith('deep-')).forEach((k) => cache.del(k));
  res.json({ message: 'Cache cleared. Next request will fetch fresh data.' });
});

// API: Health check + event stats
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    aiEnabled: !!process.env.GROQ_API_KEY,
    cacheStats: cache.getStats(),
    eventStats: getEventStats(),
  });
});

// ─── Admin API endpoints ────────────────────────────────────────

app.get('/api/admin/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  res.json({ events: getAllEvents(limit, offset), stats: getEventStats() });
});

app.get('/api/admin/alerts', (req, res) => {
  const minSeverity = parseInt(req.query.minSeverity) || 4;
  const days = parseInt(req.query.days) || 7;
  res.json({ alerts: getHighSeverityEvents(minSeverity, days) });
});

app.get('/api/admin/actors', (req, res) => {
  res.json({ actors: getTopActors() });
});

app.get('/api/admin/regions', (req, res) => {
  res.json({ regions: getEventsByRegion() });
});

app.get('/api/admin/quality', (req, res) => {
  res.json(getDataQuality());
});

// ─── Digest endpoints ───────────────────────────────────────────

app.get('/api/admin/digest', (req, res) => {
  const digest = generateDigest();
  res.json(digest);
});

app.get('/api/admin/digest/html', (req, res) => {
  const digest = generateDigest();
  const html = renderDigestHTML(digest);
  res.type('html').send(html);
});

app.get('/api/admin/digest/text', (req, res) => {
  const digest = generateDigest();
  const text = renderDigestText(digest);
  res.type('text').send(text);
});

// API: Send digest email now (manual trigger)
app.post('/api/admin/digest/send', (req, res) => {
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

// Serve admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`South Sudan News running at http://localhost:${PORT}`);

  // ─── Background extraction: runs every 15 minutes independent of traffic ──
  const EXTRACTION_INTERVAL_MS = 15 * 60 * 1000;

  async function backgroundFetchAndExtract() {
    try {
      // Reuse cached clusters if available, otherwise fetch fresh
      let data = cache.get('clusters');
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
        cache.set('clusters', data, CLUSTERS_TTL);
      }
      await extractAllEvents(data.clusters);
    } catch (err) {
      console.error('[background] Extraction cycle error:', err.message);
    }
  }

  if (process.env.GROQ_API_KEY) {
    setInterval(backgroundFetchAndExtract, EXTRACTION_INTERVAL_MS);
    console.log(`Background extraction scheduled every ${EXTRACTION_INTERVAL_MS / 60000} minutes`);
  }

  // ─── Weekly digest email: Monday 7:00 AM (server timezone) ──────
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    const DIGEST_DAY = 1;  // Monday
    const DIGEST_HOUR = 7; // 7:00 AM

    function scheduleNextDigest() {
      const now = new Date();
      const next = new Date(now);
      next.setDate(next.getDate() + ((DIGEST_DAY + 7 - next.getDay()) % 7 || 7));
      next.setHours(DIGEST_HOUR, 0, 0, 0);

      // If it's Monday before 7 AM, send today
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
        // Schedule the next one
        scheduleNextDigest();
      }, msUntil);
    }

    scheduleNextDigest();
  }
});
