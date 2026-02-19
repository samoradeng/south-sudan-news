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

// Keywords to filter articles that are actually about South Sudan
const SOUTH_SUDAN_KEYWORDS = [
  'south sudan',
  'south sudanese',
  'juba',
  'salva kiir',
  'riek machar',
  'unmiss',
  'igad',
  'bor',
  'malakal',
  'bentiu',
  'wau',
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
  const text = `${article.title || ''} ${article.contentSnippet || ''} ${article.content || ''}`.toLowerCase();
  return SOUTH_SUDAN_KEYWORDS.some((kw) => text.includes(kw));
}

function extractImage(item) {
  // Try multiple RSS image fields
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image')) return item.enclosure.url;
  if (item.enclosure?.url) return item.enclosure.url;
  if (item.mediaContent?.$?.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;
  if (item.mediaGroup?.['media:content']?.$?.url) return item.mediaGroup['media:content'].$.url;

  // Try to extract image from HTML content
  const html = item.content || item['content:encoded'] || '';
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/);
  if (imgMatch) return imgMatch[1];

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
