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
// Google News RSS items use encoded redirect URLs. The real article URL
// is extractable from the description HTML or from decoding the URL.

let _gnDiagLogged = false; // Log diagnostic for first Google News item only

function resolveGoogleNewsUrl(item) {
  const link = item.link || '';
  if (!link.includes('news.google.com/')) return link;

  // One-time diagnostic: show what data rss-parser gives us for Google News items
  if (!_gnDiagLogged) {
    _gnDiagLogged = true;
    console.log(`  [GN diagnostic] link: ${link.slice(0, 100)}...`);
    console.log(`  [GN diagnostic] item.content length: ${(item.content || '').length}, has <a: ${/<a\s/i.test(item.content || '')}`);
    console.log(`  [GN diagnostic] item.summary length: ${(item.summary || '').length}`);
    console.log(`  [GN diagnostic] item.description: ${typeof item.description}, length: ${(item.description || '').length}`);
    console.log(`  [GN diagnostic] item.content first 300: ${(item.content || '').slice(0, 300)}`);
    // Check for source field (Google News RSS has <source url="...">)
    console.log(`  [GN diagnostic] item.source: ${JSON.stringify(item.source || null)}`);
    console.log(`  [GN diagnostic] item.sourceUrl: ${item.sourceUrl || 'n/a'}`);
  }

  // Method 1: Extract real URL from description/content HTML
  // Google News RSS descriptions contain: <a href="https://real-url.com">Title</a>
  const htmlSources = [item.content, item.description, item.summary, item['content:encoded']];
  for (const html of htmlSources) {
    if (!html) continue;
    const hrefMatch = html.match(/<a[^>]+href=["']([^"']+)["']/i);
    if (hrefMatch && hrefMatch[1] && !hrefMatch[1].includes('news.google.com')) {
      return hrefMatch[1];
    }
  }

  // Method 2: Decode from Google News URL path (Base64-encoded protobuf)
  // Scan decoded bytes for "http" pattern instead of relying on string matching
  try {
    const pathMatch = link.match(/\/articles\/([A-Za-z0-9_-]+)/);
    if (pathMatch) {
      let encoded = pathMatch[1].replace(/-/g, '+').replace(/_/g, '/');
      while (encoded.length % 4) encoded += '=';
      const bytes = Buffer.from(encoded, 'base64');

      // Scan for "http" (0x68 0x74 0x74 0x70) in the raw bytes
      for (let i = 0; i < bytes.length - 10; i++) {
        if (bytes[i] === 0x68 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x74 && bytes[i + 3] === 0x70) {
          // Found "http" — read until non-URL byte
          let end = i;
          while (end < bytes.length && bytes[end] >= 0x21 && bytes[end] <= 0x7e) end++;
          const candidate = bytes.slice(i, end).toString('utf8');
          // Validate it looks like a real URL (not google.com redirect)
          if (/^https?:\/\/[a-z0-9]/.test(candidate) && !candidate.includes('news.google.com')) {
            return candidate;
          }
        }
      }
    }
  } catch {}

  return link; // Fall back to Google News URL
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

// Extract redirect target from a Google News redirector page
function extractGoogleRedirect(html) {
  const head = html.slice(0, 30000);

  // meta http-equiv="refresh" content="0;url=..."
  const metaRefresh = head.match(/http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'\s>]+)/i);
  if (metaRefresh?.[1] && !metaRefresh[1].includes('google.com')) return metaRefresh[1];

  // window.location = "..." or window.location.href = "..."
  const jsRedirect = head.match(/window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  if (jsRedirect?.[1] && !jsRedirect[1].includes('google.com')) return jsRedirect[1];

  // data-url attribute
  const dataUrl = head.match(/data-url=["'](https?:\/\/[^"']+)["']/i);
  if (dataUrl?.[1] && !dataUrl[1].includes('google.com')) return dataUrl[1];

  // First external <a href> in body
  const aHref = head.match(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/i);
  if (aHref?.[1] && !aHref[1].includes('google.com')) return aHref[1];

  return null;
}

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

async function scrapeOgImage(articleUrl) {
  try {
    const isGoogleUrl = articleUrl.includes('news.google.com/');
    const { html, finalUrl } = await fetchPage(articleUrl);
    if (!html) return null;

    // If we landed on a Google redirector page, extract the real URL and follow it
    if (isGoogleUrl || finalUrl.includes('google.com')) {
      const realUrl = extractGoogleRedirect(html);
      if (realUrl) {
        const { html: realHtml } = await fetchPage(realUrl, 5000);
        if (realHtml) return extractOgImage(realHtml);
      }
      return null; // Stuck on Google — no image possible
    }

    return extractOgImage(html);
  } catch {
    return null;
  }
}

// ─── Async Google News URL resolution (bulk) ────────────────────
// For articles where the sync Base64/description methods failed,
// fetch the Google redirector page and extract the real URL.

async function resolveGoogleRedirects(articles) {
  const googleArticles = articles.filter(
    (a) => !a.image && a.url.includes('news.google.com/')
  );
  if (googleArticles.length === 0) return;

  console.log(`Resolving ${googleArticles.length} unresolved Google News URLs...`);

  const BATCH_SIZE = 10;
  let resolved = 0;
  let diagLogged = false;

  for (let i = 0; i < googleArticles.length; i += BATCH_SIZE) {
    const batch = googleArticles.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (a) => {
        try {
          const { html, finalUrl, status } = await fetchPage(a.url, 6000);

          // Diagnostic: log details of first attempt
          if (!diagLogged) {
            diagLogged = true;
            console.log(`  [GN redirect diag] URL: ${a.url.slice(0, 80)}...`);
            console.log(`  [GN redirect diag] HTTP status: ${status}, finalUrl: ${(finalUrl || '').slice(0, 100)}`);
            console.log(`  [GN redirect diag] HTML length: ${(html || '').length}`);
            console.log(`  [GN redirect diag] HTML first 500: ${(html || '').slice(0, 500)}`);
          }

          // If HTTP redirect already resolved it
          if (finalUrl && !finalUrl.includes('google.com')) return finalUrl;

          // Parse the Google redirector page
          if (html) {
            const realUrl = extractGoogleRedirect(html);
            if (realUrl) return realUrl;
          }
          return null;
        } catch (err) {
          if (!diagLogged) {
            diagLogged = true;
            console.log(`  [GN redirect diag] ERROR: ${err.message}`);
          }
          return null;
        }
      })
    );
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value) {
        batch[j].url = r.value;
        resolved++;
      }
    });
  }

  console.log(`Resolved ${resolved}/${googleArticles.length} Google News URLs to real articles`);
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

  // Phase 1: Resolve remaining Google News URLs by fetching their redirect pages
  await resolveGoogleRedirects(filtered);

  // Phase 2: Scrape og:image for articles that now have real URLs
  await enrichWithImages(filtered);

  const finalImages = filtered.filter((a) => a.image).length;
  console.log(`Final: ${finalImages}/${filtered.length} articles have images`);

  return filtered;
}

module.exports = { fetchAllSources, fetchFromSource };
