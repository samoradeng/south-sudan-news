const Parser = require('rss-parser');
const https = require('https');
const http = require('http');
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

// ─── Google News URL resolution ─────────────────────────────────
// Google News RSS links are redirect wrappers. We resolve them to
// real article URLs in two ways:
// 1. Fast: base64-decode the protobuf token (works for older format)
// 2. HTTP: follow the redirect chain via https module (works for all)

function decodeGoogleNewsUrl(url) {
  if (!url || !url.includes('news.google.com/')) return url;

  try {
    const match = url.match(/\/articles\/([A-Za-z0-9_-]+)/);
    if (!match) return url;

    let b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';

    const decoded = Buffer.from(b64, 'base64').toString('latin1');
    const urlStart = decoded.indexOf('http');
    if (urlStart === -1) return url;

    let realUrl = '';
    for (let i = urlStart; i < decoded.length; i++) {
      const ch = decoded.charCodeAt(i);
      if (ch < 0x20 || ch > 0x7e) break;
      realUrl += decoded[i];
    }

    if (realUrl.match(/^https?:\/\/[a-zA-Z0-9]/) && !realUrl.includes('news.google.com')) {
      return realUrl;
    }
  } catch {}

  return url;
}

// Follow HTTP redirects + meta-refresh to resolve Google News URLs
function resolveGoogleNewsRedirect(gnUrl) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000);

    const tryUrl = (url, hops) => {
      if (hops > 5) { clearTimeout(timer); resolve(null); return; }

      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      }, (res) => {
        // HTTP 3xx redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          if (!next.includes('news.google.com') && !next.includes('consent.google.com')) {
            clearTimeout(timer);
            resolve(next);
          } else {
            tryUrl(next, hops + 1);
          }
          return;
        }

        // 200 OK — check HTML for meta-refresh or JS redirect
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 30000) res.destroy();
        });
        res.on('end', () => {
          clearTimeout(timer);

          // meta http-equiv="refresh" content="0;url=..."
          const metaMatch = body.match(
            /http-equiv=["']?refresh["']?[^>]+?url=["']?([^"'\s>]+)/i
          );
          if (metaMatch && metaMatch[1] && !metaMatch[1].includes('news.google.com')) {
            resolve(metaMatch[1]);
            return;
          }

          // window.location = "..."
          const jsMatch = body.match(/window\.location\s*=\s*["']([^"']+)["']/);
          if (jsMatch && jsMatch[1] && !jsMatch[1].includes('news.google.com')) {
            resolve(jsMatch[1]);
            return;
          }

          // data-url attribute (Google News uses this sometimes)
          const dataMatch = body.match(/data-url=["']([^"']+)["']/);
          if (dataMatch && dataMatch[1] && !dataMatch[1].includes('news.google.com')) {
            resolve(dataMatch[1]);
            return;
          }

          // <a href="..."> with the real URL
          const linkMatch = body.match(/<a[^>]+href=["'](https?:\/\/(?!news\.google\.com)[^"']+)["']/);
          if (linkMatch && linkMatch[1]) {
            resolve(linkMatch[1]);
            return;
          }

          resolve(null);
        });
        res.on('error', () => { clearTimeout(timer); resolve(null); });
      });

      req.on('error', () => { clearTimeout(timer); resolve(null); });
      req.setTimeout(6000, () => { req.destroy(); clearTimeout(timer); resolve(null); });
    };

    tryUrl(gnUrl, 0);
  });
}

// ─── Image extraction from RSS fields ───────────────────────────

function extractImage(item) {
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image')) return item.enclosure.url;
  if (item.enclosure?.url) return item.enclosure.url;
  if (item.mediaContent?.$?.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;
  if (item.mediaGroup?.['media:content']?.$?.url) return item.mediaGroup['media:content'].$.url;

  const htmlSources = [
    item.content,
    item['content:encoded'],
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
      if (/width=["']?1["']?/i.test(tag) && /height=["']?1["']?/i.test(tag)) continue;
      if (url.startsWith('//')) url = 'https:' + url;
      if (url.startsWith('http')) return url;
    }
  }

  return null;
}

// ─── og:image scraping ──────────────────────────────────────────

function extractOgImageFromHtml(html) {
  const head = html.slice(0, 50000);

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
}

async function scrapeOgImage(articleUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(articleUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const text = await res.text();
    return extractOgImageFromHtml(text);
  } catch {
    return null;
  }
}

// ─── Image enrichment pipeline ──────────────────────────────────

async function enrichWithImages(articles) {
  const needImages = articles.filter((a) => !a.image);
  if (needImages.length === 0) return;

  // Step 1: Resolve Google News URLs to real article URLs
  const unresolved = needImages.filter((a) => a.url.includes('news.google.com/'));
  if (unresolved.length > 0) {
    console.log(`Resolving ${unresolved.length} Google News URLs via HTTP...`);

    // Process in batches of 10 to avoid overwhelming Google
    let resolved = 0;
    for (let i = 0; i < unresolved.length; i += 10) {
      const batch = unresolved.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map((a) => resolveGoogleNewsRedirect(a.url))
      );
      results.forEach((r, j) => {
        if (r.status === 'fulfilled' && r.value) {
          batch[j].url = r.value;
          resolved++;
        }
      });
    }
    console.log(`Resolved ${resolved}/${unresolved.length} Google News URLs`);
  }

  // Step 2: Scrape og:image from real article URLs (skip still-unresolved Google URLs)
  const scrapable = needImages
    .filter((a) => !a.url.includes('news.google.com/'))
    .slice(0, 30);

  if (scrapable.length === 0) {
    console.log('No resolvable URLs to scrape og:image from');
    return;
  }

  console.log(`Scraping og:image for ${scrapable.length} articles...`);

  // Scrape in batches of 10
  let found = 0;
  for (let i = 0; i < scrapable.length; i += 10) {
    const batch = scrapable.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map((a) => scrapeOgImage(a.url))
    );
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value) {
        batch[j].image = r.value;
        found++;
      }
    });
  }

  console.log(`Found ${found} og:images out of ${scrapable.length} scraped`);
}

// ─── Article normalization & fetching ───────────────────────────

function normalizeArticle(item, sourceName, sourceCategory, sourceReliability) {
  let desc = (item.contentSnippet || item.summary || item.content || '').slice(0, 500).trim();
  desc = desc.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

  // Try fast base64 decode for Google News URLs
  const realUrl = decodeGoogleNewsUrl(item.link || '');

  return {
    id: item.guid || item.link || `${sourceName}-${item.title}`,
    title: (item.title || '').trim(),
    description: desc,
    url: realUrl,
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
  const googleUrls = filtered.filter((a) => a.url.includes('news.google.com/')).length;
  console.log(`Images from RSS: ${withImages}/${filtered.length} (${googleUrls} unresolved Google URLs)`);

  // Resolve Google News URLs and scrape og:image
  await enrichWithImages(filtered);

  const withImagesAfter = filtered.filter((a) => a.image).length;
  console.log(`Images after enrichment: ${withImagesAfter}/${filtered.length}`);

  return filtered;
}

module.exports = { fetchAllSources, fetchFromSource };
