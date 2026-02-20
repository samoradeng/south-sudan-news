const Parser = require('rss-parser');
const sources = require('./sources');

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['media:group', 'mediaGroup', { keepArray: false }],
    ],
  },
});

// Fetch XML with browser UA, strip BOM, then parse with rss-parser
async function fetchFeed(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const res = await fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    redirect: 'follow',
  });
  clearTimeout(timeoutId);

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let xml = await res.text();
  // Strip BOM and any leading whitespace/garbage before XML declaration
  xml = xml.replace(/^[\s\S]*?(<\?xml|<rss|<feed)/, '$1');

  return parser.parseString(xml);
}

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

  if (STRONG_KEYWORDS.some((kw) => title.includes(kw))) {
    return true;
  }

  const bodyMatches = SUPPORTING_KEYWORDS.filter((kw) => body.includes(kw)).length;
  return bodyMatches >= 2;
}

// ─── Image extraction from RSS fields ───────────────────────────

function extractImage(item) {
  // Standard RSS image fields
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image')) return item.enclosure.url;
  if (item.mediaContent?.$?.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;
  if (item.mediaGroup?.['media:content']?.$?.url) return item.mediaGroup['media:content'].$.url;
  if (item.enclosure?.url) return item.enclosure.url;

  // Extract from HTML content (WordPress feeds, etc.)
  const htmlSources = [
    item['content:encoded'],
    item.content,
    item.description,
    item.summary,
  ];
  for (const html of htmlSources) {
    if (!html) continue;
    const imgRegex = /<img[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi;
    let match;
    while ((match = imgRegex.exec(html))) {
      const tag = match[0];
      let url = match[1];
      // Skip 1x1 tracking pixels
      if (/width=["']?1["']?/i.test(tag) && /height=["']?1["']?/i.test(tag)) continue;
      // Fix protocol-relative URLs
      if (url.startsWith('//')) url = 'https:' + url;
      if (url.startsWith('http')) return url;
    }
  }

  return null;
}

// ─── og:image scraping (for non-Google-News URLs only) ──────────

async function scrapeOgImage(articleUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(articleUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html',
      },
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const text = await res.text();
    const head = text.slice(0, 50000);

    // og:image (both attribute orders)
    const ogMatch =
      head.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch && ogMatch[1]) {
      let imgUrl = ogMatch[1];
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
      return imgUrl;
    }

    // twitter:image fallback
    const twMatch =
      head.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
      head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (twMatch && twMatch[1]) {
      let imgUrl = twMatch[1];
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
      return imgUrl;
    }

    return null;
  } catch {
    return null;
  }
}

async function enrichWithImages(articles) {
  // Only scrape og:image for non-Google-News articles (Google URLs can't be resolved server-side)
  const scrapable = articles.filter(
    (a) => !a.image && !a.url.includes('news.google.com/')
  );
  if (scrapable.length === 0) return;

  const toScrape = scrapable.slice(0, 40);
  console.log(`Scraping og:image for ${toScrape.length} direct-feed articles...`);

  const results = await Promise.allSettled(
    toScrape.map((a) => scrapeOgImage(a.url))
  );

  let found = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      toScrape[i].image = r.value;
      found++;
    }
  });

  console.log(`Found ${found} og:images out of ${toScrape.length} scraped`);
}

// ─── Article normalization & fetching ───────────────────────────

function normalizeArticle(item, sourceName, sourceCategory, sourceReliability) {
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
    const feed = await fetchFeed(source.url);
    const articles = (feed.items || [])
      .map((item) => normalizeArticle(item, source.name, source.category, source.reliability))
      .filter(isAboutSouthSudan);
    console.log(`  ${source.name}: ${articles.length} articles (${articles.filter((a) => a.image).length} with images)`);
    return articles;
  } catch (err) {
    console.warn(`  ${source.name}: FAILED - ${err.message}`);
    return [];
  }
}

async function fetchAllSources() {
  console.log('Fetching from sources...');
  const results = await Promise.allSettled(sources.map(fetchFromSource));
  const articles = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Sort by date, newest first
  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Filter to last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const filtered = articles.filter((a) => new Date(a.publishedAt) >= weekAgo);

  const withImages = filtered.filter((a) => a.image).length;
  console.log(`Total: ${filtered.length} articles, ${withImages} with images from RSS`);

  // Scrape og:image for direct-feed articles missing images
  await enrichWithImages(filtered);

  const finalImages = filtered.filter((a) => a.image).length;
  console.log(`Final: ${finalImages}/${filtered.length} articles have images`);

  return filtered;
}

module.exports = { fetchAllSources, fetchFromSource };
