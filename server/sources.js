// RSS feed sources for South Sudan news — all free, no API keys needed
const sources = [
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22&hl=en-US&gl=US&ceid=US:en',
    category: 'general',
    reliability: 'aggregator',
  },
  {
    name: 'ReliefWeb',
    url: 'https://reliefweb.int/updates/rss.xml?search=south+sudan',
    category: 'humanitarian',
    reliability: 'high',
  },
  {
    name: 'Sudan Tribune',
    url: 'https://sudantribune.com/feed/',
    category: 'regional',
    reliability: 'medium',
  },
  {
    name: 'Radio Tamazuj',
    url: 'https://radiotamazuj.org/en/rss',
    category: 'local',
    reliability: 'high',
  },
  {
    name: 'VOA Africa',
    url: 'https://www.voanews.com/api/zq_oremqvi',
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
    name: 'Reuters Africa',
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22+site:reuters.com&hl=en-US&gl=US&ceid=US:en',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'BBC Africa',
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22+site:bbc.com&hl=en-US&gl=US&ceid=US:en',
    category: 'international',
    reliability: 'high',
  },
  {
    name: 'The East African',
    url: 'https://www.theeastafrican.co.ke/tea/rss',
    category: 'regional',
    reliability: 'medium',
  },
];

module.exports = sources;
