// RSS feed sources for South Sudan news — all free, no API keys needed
//
// Strategy: Use DIRECT feeds (BBC, Sudan Tribune, UN News, etc.) for articles
// with images, plus Google News for broad discovery. Clustering combines
// articles from multiple sources, so image-rich direct feed articles provide
// images for clusters that also contain imageless Google News articles.

const sources = [
  // ─── Direct feeds (include images via media:thumbnail, enclosure, etc.) ───

  {
    name: 'BBC Africa',
    url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml',
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
    name: 'Sudan Tribune',
    url: 'https://sudantribune.com/feed/',
    category: 'regional',
    reliability: 'medium',
  },
  {
    name: 'UN News Africa',
    url: 'https://news.un.org/feed/subscribe/en/news/region/africa/feed/rss.xml',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'Radio Tamazuj',
    url: 'https://radiotamazuj.org/en/rss',
    category: 'local',
    reliability: 'high',
  },
  {
    name: 'ReliefWeb',
    url: 'https://reliefweb.int/updates/rss.xml?advanced-search=%28C219%29',
    category: 'humanitarian',
    reliability: 'high',
  },

  // ─── Google News (broad discovery, no images but wide coverage) ───────────

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
];

module.exports = sources;
