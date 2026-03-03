// newsService.js — Fetches live financial news from multiple sources
// Uses NewsAPI (free tier: 100 req/day) or GNews (free tier: 100 req/day)
// Set ONE in .env: NEWS_API_KEY or GNEWS_API_KEY

const axios = require("axios");

const NEWS_API_KEY   = process.env.NEWS_API_KEY;
const GNEWS_API_KEY  = process.env.GNEWS_API_KEY;

// Cache to avoid hammering APIs
let cache = { articles: [], fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

const NSE_QUERIES = [
  "India stock market NSE BSE",
  "RBI interest rate inflation India",
  "FII DII India equity",
  "Nifty Sensex",
  "Iran Israel war oil gold",
  "US Fed rate dollar rupee",
  "crude oil OPEC",
  "China economy trade India",
  "India GDP earnings results"
];

async function fetchFromNewsAPI() {
  const query = "India stock market OR NSE OR Nifty OR BSE OR RBI OR FII";
  const url = "https://newsapi.org/v2/everything";
  const resp = await axios.get(url, {
    params: {
      q: query,
      language: "en",
      sortBy: "publishedAt",
      pageSize: 30,
      apiKey: NEWS_API_KEY
    },
    timeout: 10000
  });
  return (resp.data.articles || []).map(a => ({
    title:       a.title,
    summary:     a.description || "",
    source:      a.source && a.source.name || "NewsAPI",
    url:         a.url,
    publishedAt: a.publishedAt,
    category:    categorize(a.title + " " + (a.description || ""))
  }));
}

async function fetchFromGNews() {
  const resp = await axios.get("https://gnews.io/api/v4/search", {
    params: {
      q:        "India stock market NSE Nifty",
      lang:     "en",
      country:  "in",
      max:      30,
      sortby:   "publishedAt",
      token:    GNEWS_API_KEY
    },
    timeout: 10000
  });
  return (resp.data.articles || []).map(a => ({
    title:       a.title,
    summary:     a.description || "",
    source:      a.source && a.source.name || "GNews",
    url:         a.url,
    publishedAt: a.publishedAt,
    category:    categorize(a.title + " " + (a.description || ""))
  }));
}

// Fallback: scrape NSE/moneycontrol headlines via RSS
async function fetchFromRSS() {
  const feeds = [
    "https://www.moneycontrol.com/rss/marketreports.xml",
    "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"
  ];
  const articles = [];
  for (const feed of feeds) {
    try {
      const resp = await axios.get(feed, { timeout: 8000 });
      const text = resp.data;
      // Simple XML parse — extract title + description
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items.slice(0, 15)) {
        const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                       item.match(/<title>(.*?)<\/title>/))?.[1] || "";
        const desc  = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                       item.match(/<description>(.*?)<\/description>/))?.[1] || "";
        const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || new Date().toISOString();
        if (title) {
          articles.push({
            title,
            summary:     desc.replace(/<[^>]+>/g, "").slice(0, 200),
            source:      feed.includes("moneycontrol") ? "Moneycontrol" : "Economic Times",
            url:         "",
            publishedAt: new Date(pubDate).toISOString(),
            category:    categorize(title + " " + desc)
          });
        }
      }
    } catch (e) { /* skip failed feed */ }
  }
  return articles;
}

function categorize(text) {
  const t = text.toLowerCase();
  if (t.match(/gold|silver|metal|etf/))           return "commodities";
  if (t.match(/oil|crude|opec|energy/))            return "energy";
  if (t.match(/bank|rbi|rate|npa|credit/))         return "banking";
  if (t.match(/it|tech|infosys|tcs|wipro/))        return "technology";
  if (t.match(/fii|dii|foreign|institutional/))    return "fii_dii";
  if (t.match(/pharma|drug|health|medicine/))      return "pharma";
  if (t.match(/auto|vehicle|car|tata motor/))      return "auto";
  if (t.match(/rupee|dollar|forex|currency/))      return "forex";
  if (t.match(/war|geopolit|iran|israel|russia/))  return "geopolitical";
  if (t.match(/inflation|gdp|economy|growth/))     return "macro";
  return "general";
}

async function fetchNews() {
  const now = Date.now();
  if (cache.articles.length > 0 && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.articles;
  }
  let articles = [];
  try {
    if (NEWS_API_KEY)  articles = await fetchFromNewsAPI();
    else if (GNEWS_API_KEY) articles = await fetchFromGNews();
    else articles = await fetchFromRSS(); // always works, no key needed
  } catch (e) {
    console.error("News fetch error:", e.message);
    articles = await fetchFromRSS(); // fallback
  }
  // Sort by publishedAt desc
  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  cache = { articles, fetchedAt: now };
  console.log("News fetched: " + articles.length + " articles");
  return articles;
}

module.exports = { fetchNews };
