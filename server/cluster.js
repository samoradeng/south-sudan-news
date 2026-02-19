// Algorithmic article clustering — no AI needed
// Groups related articles about the same story using word overlap similarity

// Stopwords to ignore when computing similarity
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this', 'what',
  'which', 'who', 'whom', 'these', 'those', 'it', 'its', 'he', 'she',
  'they', 'them', 'his', 'her', 'their', 'we', 'us', 'south', 'sudan',
  'sudanese', 'says', 'said', 'new', 'also', 'about', 'up',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function getWordFrequency(tokens) {
  const freq = {};
  for (const token of tokens) {
    freq[token] = (freq[token] || 0) + 1;
  }
  return freq;
}

function cosineSimilarity(freqA, freqB) {
  const allWords = new Set([...Object.keys(freqA), ...Object.keys(freqB)]);
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (const word of allWords) {
    const a = freqA[word] || 0;
    const b = freqB[word] || 0;
    dotProduct += a * b;
    magA += a * a;
    magB += b * b;
  }

  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

function clusterArticles(articles, similarityThreshold = 0.35) {
  if (articles.length === 0) return [];

  // Precompute token frequencies for all articles
  const articleData = articles.map((article) => {
    const text = `${article.title} ${article.description}`;
    const tokens = tokenize(text);
    return { article, freq: getWordFrequency(tokens) };
  });

  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < articleData.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = {
      articles: [articleData[i].article],
      primaryArticle: articleData[i].article,
    };
    assigned.add(i);

    for (let j = i + 1; j < articleData.length; j++) {
      if (assigned.has(j)) continue;

      const similarity = cosineSimilarity(articleData[i].freq, articleData[j].freq);
      if (similarity >= similarityThreshold) {
        cluster.articles.push(articleData[j].article);
        assigned.add(j);
      }
    }

    // Pick the best primary article: prefer high-reliability sources
    const reliabilityOrder = { high: 3, medium: 2, aggregator: 1 };
    cluster.articles.sort((a, b) => {
      const relDiff = (reliabilityOrder[b.sourceReliability] || 0) - (reliabilityOrder[a.sourceReliability] || 0);
      if (relDiff !== 0) return relDiff;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    });
    cluster.primaryArticle = cluster.articles[0];

    // Derive cluster metadata
    cluster.sourceCount = new Set(cluster.articles.map((a) => a.source)).size;
    cluster.sources = [...new Set(cluster.articles.map((a) => a.source))];
    cluster.latestDate = cluster.articles
      .map((a) => new Date(a.publishedAt))
      .sort((a, b) => b - a)[0]
      .toISOString();
    cluster.category = cluster.primaryArticle.sourceCategory;

    // Pick the best available image from any article in the cluster
    cluster.image = cluster.articles.find((a) => a.image)?.image || null;

    clusters.push(cluster);
  }

  // Sort clusters by latest article date
  clusters.sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate));

  return clusters;
}

module.exports = { clusterArticles };
