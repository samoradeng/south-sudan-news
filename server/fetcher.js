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

// ─── Relevance filtering: South Sudan + Sudan ──────────────────

// Strong keywords: if found in title, article is definitely relevant
const STRONG_KEYWORDS_SS = [
  'south sudan',
  'south sudanese',
  'salva kiir',
  'riek machar',
  'unmiss',
];

const STRONG_KEYWORDS_SUDAN = [
  'sudan war',
  'sudan conflict',
  'sudan crisis',
  'sudanese army',
  'sudanese military',
  'khartoum',
  'rsf',
  'rapid support forces',
  'abdel fattah al-burhan',
  'al-burhan',
  'hemedti',
  'dagalo',
];

// Supporting keywords: need 2+ matches in body to confirm relevance
const SUPPORTING_KEYWORDS_SS = [
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

const SUPPORTING_KEYWORDS_SUDAN = [
  'sudan',
  'sudanese',
  'khartoum',
  'darfur',
  'el fasher',
  'al-fashir',
  'port sudan',
  'omdurman',
  'rsf',
  'rapid support forces',
  'al-burhan',
  'hemedti',
  'dagalo',
  'saf',
  'sudan armed forces',
  'north darfur',
  'south darfur',
  'west darfur',
  'south kordofan',
  'blue nile',
  'white nile',
  'red sea state',
  'kassala',
  'gedaref',
  'gezira',
  'sennar',
  'janjaweed',
];

function isRelevantArticle(article) {
  const title = (article.title || '').toLowerCase();
  const body = `${article.contentSnippet || ''} ${article.content || ''}`.toLowerCase();

  // South Sudan: strong keyword in title
  if (STRONG_KEYWORDS_SS.some((kw) => title.includes(kw))) return true;

  // Sudan: strong keyword in title
  if (STRONG_KEYWORDS_SUDAN.some((kw) => title.includes(kw))) return true;

  // "sudan" in title (but not "south sudan") — check it's about Sudan proper
  if (title.includes('sudan') && !title.includes('south sudan')) {
    const bodyMatches = SUPPORTING_KEYWORDS_SUDAN.filter((kw) => body.includes(kw)).length;
    if (bodyMatches >= 2) return true;
  }

  // Body-level matching for South Sudan
  const ssBodyMatches = SUPPORTING_KEYWORDS_SS.filter((kw) => body.includes(kw)).length;
  if (ssBodyMatches >= 2) return true;

  // Body-level matching for Sudan
  const sdBodyMatches = SUPPORTING_KEYWORDS_SUDAN.filter((kw) => body.includes(kw)).length;
  if (sdBodyMatches >= 3) return true; // Higher bar for Sudan body-only matches

  return false;
}

// ─── Google News URL resolution ─────────────────────────────────
// Modern Google News URLs (2024+) use encrypted protobuf encoding.
// The only reliable server-side decode method is Google's internal
// batchexecute API endpoint (DotsSplashUi/data/batchexecute).

let _gnDiagLogged = false;

function resolveGoogleNewsUrl(item) {
  const link = item.link || '';
  if (!link.includes('news.google.com/')) return link;

  // One-time diagnostic
  if (!_gnDiagLogged) {
    _gnDiagLogged = true;
    console.log(`  [GN] First item — content has <a>: ${/<a\s/i.test(item.content || '')}, hrefs point to: ${
      (item.content || '').includes('news.google.com') ? 'google (encrypted)' : 'publisher (decodable)'
    }`);
  }

  // Method 1: Extract real URL from description/content HTML (works for older format)
  const htmlSources = [item.content, item.description, item.summary, item['content:encoded']];
  for (const html of htmlSources) {
    if (!html) continue;
    const hrefMatch = html.match(/<a[^>]+href=["']([^"']+)["']/i);
    if (hrefMatch && hrefMatch[1] && !hrefMatch[1].includes('news.google.com')) {
      return hrefMatch[1];
    }
  }

  // Method 2: Scan Base64-decoded protobuf bytes for "http" (works for some formats)
  try {
    const pathMatch = link.match(/\/articles\/([A-Za-z0-9_-]+)/);
    if (pathMatch) {
      let encoded = pathMatch[1].replace(/-/g, '+').replace(/_/g, '/');
      while (encoded.length % 4) encoded += '=';
      const bytes = Buffer.from(encoded, 'base64');
      for (let i = 0; i < bytes.length - 10; i++) {
        if (bytes[i] === 0x68 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x74 && bytes[i + 3] === 0x70) {
          let end = i;
          while (end < bytes.length && bytes[end] >= 0x21 && bytes[end] <= 0x7e) end++;
          const candidate = bytes.slice(i, end).toString('utf8');
          if (/^https?:\/\/[a-z0-9]/.test(candidate) && !candidate.includes('news.google.com')) {
            return candidate;
          }
        }
      }
    }
  } catch {}

  return link; // Will be resolved async via batchexecute API
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

// ─── og:image scraping ──────────────────────────────────────────

function extractOgImage(html) {
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

// ─── Google News batchexecute API decoder ───────────────────────
// Modern Google News URLs use encrypted protobuf that can't be decoded
// locally. The only reliable approach is Google's internal batchexecute
// API (DotsSplashUi/data/batchexecute) with the "Fbv4je" RPC method.

async function fetchPage(url, timeout = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const res = await fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Referer: 'https://news.google.com/',
    },
    redirect: 'follow',
  });
  clearTimeout(timeoutId);
  if (!res.ok) return { html: null, finalUrl: res.url, status: res.status };
  const html = await res.text();
  return { html, finalUrl: res.url, status: res.status };
}

async function decodeGoogleNewsArticle(articleUrl) {
  const idMatch = articleUrl.match(/\/articles\/([A-Za-z0-9_-]+)/);
  if (!idMatch) return null;
  const articleId = idMatch[1];

  // Build the batchexecute payload
  // Inner: ["garturlreq", [["en-US", "US", [articleId]], null x30]]
  const innerPayload = ['garturlreq', [[['en-US', 'US', [articleId]],
    ...new Array(30).fill(null)]]];
  const outerPayload = [[['Fbv4je', JSON.stringify(innerPayload), null, 'generic']]];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': BROWSER_UA,
      Referer: 'https://news.google.com/',
    },
    body: `f.req=${encodeURIComponent(JSON.stringify(outerPayload))}`,
  });
  clearTimeout(timeoutId);

  if (!res.ok) return null;

  const text = await res.text();

  // Response format: )]}'\n<length>\n[JSON with nested arrays containing the URL]
  // The decoded URL appears as a plain https:// string in the response
  // Try to find it — scan for URLs not on google domains
  const urlMatches = text.match(/https?:\/\/[^\s"\\,\]\)]+/g);
  if (urlMatches) {
    for (const url of urlMatches) {
      const clean = url.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      if (!clean.includes('google.com') && !clean.includes('gstatic.com') &&
          !clean.includes('googleapis.com') && /^https?:\/\/[a-z0-9]/.test(clean)) {
        return clean;
      }
    }
  }

  return null;
}

async function scrapeOgImage(articleUrl) {
  try {
    if (articleUrl.includes('news.google.com/')) return null; // Can't scrape Google SPA
    const { html } = await fetchPage(articleUrl);
    if (!html) return null;
    return extractOgImage(html);
  } catch {
    return null;
  }
}

// ─── Async Google News URL resolution (via batchexecute API) ────

async function resolveGoogleRedirects(articles) {
  const googleArticles = articles.filter(
    (a) => !a.image && a.url.includes('news.google.com/')
  );
  if (googleArticles.length === 0) return;

  console.log(`Decoding ${googleArticles.length} Google News URLs via batchexecute API...`);

  const BATCH_SIZE = 5; // Smaller batches to avoid rate limiting
  let resolved = 0;
  let errors = 0;
  let diagLogged = false;

  for (let i = 0; i < googleArticles.length; i += BATCH_SIZE) {
    const batch = googleArticles.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((a) => decodeGoogleNewsArticle(a.url))
    );
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value) {
        // One-time diagnostic
        if (!diagLogged) {
          diagLogged = true;
          console.log(`  [GN decode] Sample: ${batch[j].url.slice(0, 60)}... => ${r.value.slice(0, 80)}`);
        }
        batch[j].url = r.value;
        resolved++;
      } else {
        errors++;
        if (!diagLogged && r.status === 'rejected') {
          diagLogged = true;
          console.log(`  [GN decode] First error: ${r.reason?.message || 'unknown'}`);
        }
      }
    });

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < googleArticles.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`Decoded ${resolved}/${googleArticles.length} Google News URLs (${errors} failed)`);
}

async function enrichWithImages(articles) {
  const scrapable = articles.filter((a) => !a.image);
  if (scrapable.length === 0) return;

  // Scrape in batches of 10 to avoid overwhelming the network
  const BATCH_SIZE = 10;
  const toScrape = scrapable.slice(0, 60);
  console.log(`Scraping og:image for ${toScrape.length} articles without images...`);

  let found = 0;
  for (let i = 0; i < toScrape.length; i += BATCH_SIZE) {
    const batch = toScrape.slice(i, i + BATCH_SIZE);
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

  console.log(`Found ${found} og:images out of ${toScrape.length} scraped`);
}

// ─── Article normalization & fetching ───────────────────────────

function normalizeArticle(item, sourceName, sourceCategory, sourceReliability) {
  let desc = (item.contentSnippet || item.summary || item.content || '').slice(0, 500).trim();
  desc = desc.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

  // Resolve Google News redirect URLs to real article URLs
  const url = resolveGoogleNewsUrl(item);

  return {
    id: item.guid || item.link || `${sourceName}-${item.title}`,
    title: (item.title || '').trim(),
    description: desc,
    url,
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
      .filter(isRelevantArticle);
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
  const syncResolved = filtered.filter((a) => !a.url.includes('news.google.com/')).length - withImages;
  console.log(`Total: ${filtered.length} articles, ${withImages} with images from RSS`);

  // Phase 1: Decode Google News URLs via batchexecute API
  await resolveGoogleRedirects(filtered);

  // Phase 2: Scrape og:image for articles that now have real URLs
  await enrichWithImages(filtered);

  const finalImages = filtered.filter((a) => a.image).length;
  console.log(`Final: ${finalImages}/${filtered.length} articles have images`);

  return filtered;
}

module.exports = { fetchAllSources, fetchFromSource };
