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
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22+site:reliefweb.int&hl=en-US&gl=US&ceid=US:en',
    category: 'humanitarian',
    reliability: 'high',
  },
  {
    name: 'Sudan Tribune',
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22+site:sudantribune.com&hl=en-US&gl=US&ceid=US:en',
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
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22+site:voanews.com&hl=en-US&gl=US&ceid=US:en',
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
    name: 'Reuters',
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
    url: 'https://news.google.com/rss/search?q=%22south+sudan%22+site:theeastafrican.co.ke&hl=en-US&gl=US&ceid=US:en',
    category: 'regional',
    reliability: 'medium',
  },
];

module.exports = sources;
