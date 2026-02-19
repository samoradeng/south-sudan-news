const express = require('express');
const path = require('path');
const NodeCache = require('node-cache');
const { fetchAllSources } = require('./fetcher');
const { clusterArticles } = require('./cluster');
const { initGroq, summarizeClusters, deepSummarizeCluster, answerFollowUp } = require('./summarizer');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// Cache: articles for 15 minutes, summaries for 30 minutes
const cache = new NodeCache();
const ARTICLES_TTL = 15 * 60;
const CLUSTERS_TTL = 30 * 60;
const DEEP_TTL = 60 * 60; // Deep summaries cached 1 hour

// Initialize Groq if API key is available (free tier)
if (process.env.GROQ_API_KEY) {
  initGroq(process.env.GROQ_API_KEY);
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

    const summarized = await summarizeClusters(clusters);

    const response = {
      clusters: summarized,
      totalArticles: articles.length,
      sources: [...new Set(articles.map((a) => a.source))],
      lastUpdated: new Date().toISOString(),
    };

    cache.set('clusters', response, CLUSTERS_TTL);
    res.json(response);
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

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    aiEnabled: !!process.env.GROQ_API_KEY,
    cacheStats: cache.getStats(),
  });
});

app.listen(PORT, () => {
  console.log(`South Sudan News running at http://localhost:${PORT}`);
});
