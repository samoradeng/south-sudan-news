const Parser = require('rss-parser');
const sources = require('./sources');

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'SouthSudanNews/1.0',
    Accept: 'application/rss+xml, application/xml, text/xml',
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['media:group', 'mediaGroup', { keepArray: false }],
    ],
  },
});

// Strong keywords: if found in title, article is definitely about South Sudan
const STRONG_KEYWORDS = [
  'south sudan',
  'south sudanese',
  'salva kiir',
  'riek machar',
  'unmiss',
];

// Supporting keywords: need 2+ matches in body to confirm South Sudan relevance
const SUPPORTING_KEYWORDS = [
  'south sudan',
  'south sudanese',
  'juba',
  'salva kiir',
  'riek machar',
  'unmiss',
  'igad',
  'malakal',
  'bentiu',
  'yambio',
  'torit',
  'aweil',
  'rumbek',
  'jonglei',
  'upper nile',
  'unity state',
  'equatoria',
  'bahr el ghazal',
  'abyei',
  'splm',
  'spla',
];

function isAboutSouthSudan(article) {
  const title = (article.title || '').toLowerCase();
  const body = `${article.contentSnippet || ''} ${article.content || ''}`.toLowerCase();

  // If title explicitly mentions South Sudan, it's relevant
  if (STRONG_KEYWORDS.some((kw) => title.includes(kw))) {
    return true;
  }

  // Otherwise, require at least 2 supporting keyword matches in the body
  // This prevents articles that only mention "Juba" or "IGAD" in passing
  const bodyMatches = SUPPORTING_KEYWORDS.filter((kw) => body.includes(kw)).length;
  return bodyMatches >= 2;
}

function extractImage(item) {
  // Try multiple RSS image fields
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image')) return item.enclosure.url;
  if (item.enclosure?.url) return item.enclosure.url;
  if (item.mediaContent?.$?.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;
  if (item.mediaGroup?.['media:content']?.$?.url) return item.mediaGroup['media:content'].$.url;

  // Try to extract image from any HTML field (Google News RSS puts images in description)
  const htmlSources = [
    item.content,
    item['content:encoded'],
    item.description,
    item.summary,
  ];
  for (const html of htmlSources) {
    if (!html) continue;
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/);
    if (imgMatch && imgMatch[1]) return imgMatch[1];
  }

  return null;
}

function normalizeArticle(item, sourceName, sourceCategory, sourceReliability) {
  // Clean description: strip HTML tags
  let desc = (item.contentSnippet || item.summary || item.content || '').slice(0, 500).trim();
  desc = desc.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

  return {
    id: item.guid || item.link || `${sourceName}-${item.title}`,
    title: (item.title || '').trim(),
    description: desc,
    url: item.link || '',
    image: extractImage(item),
    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
    source: sourceName,
    sourceCategory,
    sourceReliability,
  };
}

async function fetchFromSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const articles = (feed.items || [])
      .map((item) => normalizeArticle(item, source.name, source.category, source.reliability))
      .filter(isAboutSouthSudan);
    return articles;
  } catch (err) {
    console.warn(`Failed to fetch from ${source.name}: ${err.message}`);
    return [];
  }
}

async function fetchAllSources() {
  const results = await Promise.allSettled(sources.map(fetchFromSource));
  const articles = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Sort by date, newest first
  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Filter to last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return articles.filter((a) => new Date(a.publishedAt) >= weekAgo);
}

module.exports = { fetchAllSources, fetchFromSource };
