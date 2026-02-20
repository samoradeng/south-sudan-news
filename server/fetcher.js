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

  if (STRONG_KEYWORDS.some((kw) => title.includes(kw))) {
    return true;
  }

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

  // Try to extract image from any HTML field
  const htmlSources = [
    item.content,
    item['content:encoded'],
    item.description,
    item.summary,
  ];
  for (const html of htmlSources) {
    if (!html) continue;
    // Find all img tags, skip 1x1 tracking pixels
    const imgRegex = /<img[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi;
    let match;
    while ((match = imgRegex.exec(html))) {
      const tag = match[0];
      let url = match[1];
      // Skip spacer/tracking pixels
      if (/width=["']?1["']?/i.test(tag) && /height=["']?1["']?/i.test(tag)) continue;
      // Fix protocol-relative URLs
      if (url.startsWith('//')) url = 'https:' + url;
      if (url.startsWith('http')) return url;
    }
  }

  return null;
}

// ─── og:image scraping for articles without images ──────────────

async function fetchOgImage(articleUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(articleUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const text = await res.text();
    const head = text.slice(0, 50000); // Only scan first 50KB

    // Try og:image (both attribute orders)
    const ogMatch =
      head.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    if (ogMatch && ogMatch[1]) {
      let imgUrl = ogMatch[1];
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
      return imgUrl;
    }

    // Try twitter:image as fallback
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
  const needImages = articles.filter((a) => !a.image);
  if (needImages.length === 0) return;

  // Only scrape top 15 to keep load time reasonable (~5s max in parallel)
  const toScrape = needImages.slice(0, 15);
  console.log(`Scraping og:image for ${toScrape.length} articles without images...`);

  const results = await Promise.allSettled(
    toScrape.map((a) => fetchOgImage(a.url))
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
  const filtered = articles.filter((a) => new Date(a.publishedAt) >= weekAgo);

  const withImages = filtered.filter((a) => a.image).length;
  console.log(`Images from RSS: ${withImages}/${filtered.length}`);

  // Scrape og:image for articles missing images
  await enrichWithImages(filtered);

  const withImagesAfter = filtered.filter((a) => a.image).length;
  console.log(`Images after og:image scraping: ${withImagesAfter}/${filtered.length}`);

  return filtered;
}

module.exports = { fetchAllSources, fetchFromSource };
