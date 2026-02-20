// RSS feed sources for Horn of Africa monitoring — all free, no API keys needed
//
// Coverage: South Sudan + Sudan (with architecture ready for Ethiopia expansion)
//
// Strategy: Use DIRECT feeds for articles with images, plus Google News
// for broad discovery. Clustering combines both, so image-rich direct
// feed articles provide images for clusters containing Google News articles.

const sources = [
  // ─── International feeds (cover both Sudan + South Sudan) ──────────────────

  {
    name: 'BBC Africa',
    url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'The Guardian Africa',
    url: 'https://www.theguardian.com/world/africa/rss',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'France24 Africa',
    url: 'https://www.france24.com/en/africa/rss',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'Al Jazeera',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'UN News Africa',
    url: 'https://news.un.org/feed/subscribe/en/news/region/africa/feed/rss.xml',
    category: 'international',
    reliability: 'high',
  },

  // ─── Regional feeds (Sudan + South Sudan) ─────────────────────────────────

  {
    name: 'Sudan Tribune',
    url: 'https://sudantribune.net/feed/',
    category: 'regional',
    reliability: 'medium',
  },
  {
    name: 'Dabanga Radio',
    url: 'https://www.dabangasudan.org/en/feed',
    category: 'regional',
    reliability: 'medium',
  },

  // ─── South Sudan local feeds ──────────────────────────────────────────────

  {
    name: 'Radio Tamazuj',
    url: 'https://radiotamazuj.org/en/rss',
    category: 'local',
    reliability: 'high',
  },
  {
    name: 'Eye Radio',
    url: 'https://eyeradio.org/feed/',
    category: 'local',
    reliability: 'medium',
  },
  {
    name: 'Nyamilepedia',
    url: 'https://nyamile.com/feed/',
    category: 'local',
    reliability: 'medium',
  },

  // ─── Google News: South Sudan ─────────────────────────────────────────────

  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22&hl=en-US&gl=US&ceid=US:en',
    category: 'general',
    reliability: 'aggregator',
  },
  {
    name: 'Reuters',
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22+site:reuters.com&hl=en-US&gl=US&ceid=US:en',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'VOA Africa',
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22+site:voanews.com&hl=en-US&gl=US&ceid=US:en',
    category: 'international',
    reliability: 'high',
  },

  // ─── Google News: Sudan ───────────────────────────────────────────────────

  {
    name: 'Google News Sudan',
    url: 'https://news.google.com/rss/search?q=sudan+war+OR+sudan+conflict+OR+khartoum+OR+RSF+OR+darfur+-"south+sudan"&hl=en-US&gl=US&ceid=US:en',
    category: 'general',
    reliability: 'aggregator',
  },
  {
    name: 'Reuters Sudan',
    url: 'https://news.google.com/rss/search?q=sudan+site:reuters.com+-"south+sudan"&hl=en-US&gl=US&ceid=US:en',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'VOA Sudan',
    url: 'https://news.google.com/rss/search?q=sudan+site:voanews.com+-"south+sudan"&hl=en-US&gl=US&ceid=US:en',
    category: 'international',
    reliability: 'high',
  },
];

module.exports = sources;
