// newsEngine.js
// Fetches real-time news and corporate actions for NSE stocks
// Sources: NSE API, Google News RSS, MoneyControl RSS

const axios = require("axios");

const newsCache = {};
const NEWS_CACHE_MS = 10 * 60 * 1000;
const symbolNews = {};

// ── NSE Corporate Actions ─────────────────────────────────────────────────────
async function fetchCorporateActions() {
  try {
    const resp = await axios.get(
      "https://www.nseindia.com/api/corporates-corporateActions?index=equities",
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://www.nseindia.com" }, timeout: 8000 }
    );
    const actions = resp.data.data || [];
    actions.forEach(a => {
      const sym = a.symbol;
      if (!symbolNews[sym]) symbolNews[sym] = [];
      symbolNews[sym].push({
        type:      "corporate_action",
        action:    a.purpose,
        exDate:    a.exDate,
        title:     a.purpose + " ex-date: " + a.exDate,
        sentiment: getCorporateActionSentiment(a.purpose),
        publishedAt: new Date().toISOString()
      });
    });
    console.log("[newsEngine] Corporate actions: " + actions.length);
  } catch (e) {
    console.log("[newsEngine] Corporate actions failed:", e.message);
  }
}

// ── NSE Board Meetings ────────────────────────────────────────────────────────
async function fetchBoardMeetings() {
  try {
    const resp = await axios.get(
      "https://www.nseindia.com/api/corporates-boardMeetings?index=equities",
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://www.nseindia.com" }, timeout: 8000 }
    );
    const meetings = resp.data.data || [];
    meetings.forEach(m => {
      const sym = m.symbol;
      if (!symbolNews[sym]) symbolNews[sym] = [];
      symbolNews[sym].push({
        type:        "board_meeting",
        purpose:     m.purpose,
        meetingDate: m.bm_date,
        title:       "Board meeting " + m.bm_date + ": " + m.purpose,
        sentiment:   getBoardMeetingSentiment(m.purpose),
        publishedAt: new Date().toISOString()
      });
    });
    console.log("[newsEngine] Board meetings: " + meetings.length);
  } catch (e) {
    console.log("[newsEngine] Board meetings failed:", e.message);
  }
}

// ── NSE Block Deals ───────────────────────────────────────────────────────────
async function fetchBlockDeals() {
  try {
    const resp = await axios.get(
      "https://www.nseindia.com/api/block-deal",
      { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.nseindia.com" }, timeout: 8000 }
    );
    const deals = resp.data.data || [];
    deals.forEach(d => {
      const sym = d.symbol;
      if (!symbolNews[sym]) symbolNews[sym] = [];
      symbolNews[sym].push({
        type:        "block_deal",
        buyOrSell:   d.buyOrSell,
        quantity:    d.quantity,
        price:       d.price,
        client:      d.clientName,
        title:       d.buyOrSell + " block deal: " + d.quantity + " shares @ ₹" + d.price + " by " + d.clientName,
        sentiment:   d.buyOrSell === "BUY" ? "strong_positive" : "negative",
        publishedAt: new Date().toISOString()
      });
    });
    console.log("[newsEngine] Block deals: " + deals.length);
  } catch (e) {
    console.log("[newsEngine] Block deals failed:", e.message);
  }
}

// ── Google News RSS — per-symbol ──────────────────────────────────────────────
async function fetchStockNews(symbol) {
  const cacheKey = "news_" + symbol;
  if (newsCache[cacheKey] && Date.now() - newsCache[cacheKey].time < NEWS_CACHE_MS) {
    return newsCache[cacheKey].data;
  }
  try {
    const query = encodeURIComponent(symbol + " NSE stock");
    const resp  = await axios.get(
      "https://news.google.com/rss/search?q=" + query + "&hl=en-IN&gl=IN&ceid=IN:en",
      { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const articles = parseRSS(resp.data).slice(0, 5).map(a => ({
      title:       a.title,
      sentiment:   analyzeNewsSentiment(a.title),
      publishedAt: new Date(a.pubDate).toISOString(),
      source:      a.source
    }));
    newsCache[cacheKey] = { data: articles, time: Date.now() };
    return articles;
  } catch (e) {
    return [];
  }
}

// ── Google News RSS — general market headlines (for aiResearcher) ─────────────
async function fetchMarketNews() {
  const cacheKey = "market_news_general";
  if (newsCache[cacheKey] && Date.now() - newsCache[cacheKey].time < NEWS_CACHE_MS) {
    return newsCache[cacheKey].data;
  }
  const queries = [
    "NSE BSE India stock market",
    "RBI interest rate India economy",
    "FII DII India stock market today",
    "Nifty Sensex today"
  ];
  const all = [];
  for (const q of queries) {
    try {
      const resp = await axios.get(
        "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-IN&gl=IN&ceid=IN:en",
        { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const items = parseRSS(resp.data).slice(0, 6).map(a => ({
        title:       a.title,
        summary:     a.title,
        sentiment:   analyzeNewsSentiment(a.title),
        publishedAt: new Date(a.pubDate).toISOString(),
        source:      a.source,
        category:    detectCategory(a.title)
      }));
      all.push(...items);
    } catch (e) { /* skip */ }
  }
  // Deduplicate by title
  const seen = new Set();
  const deduped = all.filter(a => {
    const key = a.title.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  newsCache[cacheKey] = { data: deduped, time: Date.now() };
  console.log("[newsEngine] Market news fetched: " + deduped.length);
  return deduped;
}

// ── RSS Parser ────────────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRx   = /<item>([\s\S]*?)<\/item>/g;
  const titleRx  = /<title><!\[CDATA\[(.*?)\]\]><\/title>/;
  const dateRx   = /<pubDate>(.*?)<\/pubDate>/;
  const sourceRx = /<source[^>]*>(.*?)<\/source>/;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const item  = m[1];
    const title = titleRx.exec(item);
    const date  = dateRx.exec(item);
    const src   = sourceRx.exec(item);
    if (title) items.push({
      title:   title[1],
      pubDate: date  ? date[1]  : new Date().toISOString(),
      source:  src   ? src[1]   : "Google News"
    });
  }
  return items;
}

// ── Category detection ────────────────────────────────────────────────────────
function detectCategory(text) {
  const t = text.toLowerCase();
  if (t.match(/rbi|rate|inflation|cpi|iip|gdp|fiscal|budget/))         return "macro";
  if (t.match(/fii|dii|foreign|institutional|fund/))                    return "fii";
  if (t.match(/crude|oil|brent|opec|petrol/))                           return "crude";
  if (t.match(/gold|silver|metal/))                                     return "commodity";
  if (t.match(/it|tech|software|tcs|infosys|wipro|deal|contract/))     return "it";
  if (t.match(/bank|nbfc|loan|credit|npa|hdfc|icici|sbi/))             return "banking";
  if (t.match(/pharma|drug|fda|approval|biocon|sun pharma/))           return "pharma";
  if (t.match(/defence|defense|hal|bel|missile|order/))                return "defense";
  if (t.match(/auto|ev|electric|maruti|tata motors|m&m/))              return "auto";
  if (t.match(/result|earnings|profit|revenue|quarter|q[1-4]/))        return "earnings";
  if (t.match(/merger|acquisition|buyback|dividend|split/))            return "corporate";
  return "general";
}

// ── Sentiment ─────────────────────────────────────────────────────────────────
function analyzeNewsSentiment(text) {
  const t = text.toLowerCase();
  const strongPos = ["surge", "soar", "jump", "rally", "breakout", "record high", "profit up",
    "beats estimate", "acquisition", "contract win", "order win", "dividend", "buyback",
    "upgrade", "strong results", "expansion", "launches", "approved"];
  const strongNeg = ["crash", "plunge", "fall", "loss", "downgrade", "sell off", "probe",
    "fraud", "default", "miss estimate", "weak results", "resignation", "penalty",
    "ban", "investigation", "warning", "recall", "fire", "accident"];
  const pos = ["rise", "gain", "up", "positive", "growth", "good", "profit", "strong", "beat", "win", "approve", "launch"];
  const neg = ["drop", "down", "decline", "concern", "risk", "weak", "below", "cut", "reduce", "exit", "sell"];

  if (strongPos.some(w => t.includes(w))) return "strong_positive";
  if (strongNeg.some(w => t.includes(w))) return "strong_negative";
  if (pos.some(w => t.includes(w))) return "positive";
  if (neg.some(w => t.includes(w))) return "negative";
  return "neutral";
}

function getCorporateActionSentiment(purpose) {
  const p = (purpose || "").toLowerCase();
  if (p.includes("buyback"))  return "strong_positive";
  if (p.includes("dividend")) return "positive";
  if (p.includes("split"))    return "positive";
  if (p.includes("bonus"))    return "positive";
  return "neutral";
}

function getBoardMeetingSentiment(purpose) {
  const p = (purpose || "").toLowerCase();
  if (p.includes("buyback"))              return "strong_positive";
  if (p.includes("dividend"))             return "positive";
  if (p.includes("merger") || p.includes("acquisition")) return "positive";
  return "neutral";
}

// ── News score for a symbol (used by signalEngine) ────────────────────────────
async function getSymbolNewsScore(symbol) {
  const stored = symbolNews[symbol] || [];
  const fresh  = await fetchStockNews(symbol);
  const all    = [...stored, ...fresh];
  if (all.length === 0) return { score: 0, summary: [], newsCount: 0 };

  let score = 0;
  const summary = [];
  all.forEach(n => {
    const s = n.sentiment || "neutral";
    if (s === "strong_positive") { score += 20; summary.push("🟢 " + (n.title || n.details)); }
    else if (s === "positive")   { score += 10; summary.push("🟡 " + (n.title || n.details)); }
    else if (s === "negative")   { score -= 10; summary.push("🔴 " + (n.title || n.details)); }
    else if (s === "strong_negative") { score -= 20; summary.push("⛔ " + (n.title || n.details)); }
  });

  return {
    score:              Math.max(-100, Math.min(100, score)),
    summary:            summary.slice(0, 3),
    newsCount:          all.length,
    hasEarnings:        all.some(n => n.type === "board_meeting"),
    hasDividend:        all.some(n => n.type === "corporate_action" && (n.action||"").toLowerCase().includes("dividend")),
    hasBlockDeal:       all.some(n => n.type === "block_deal"),
    blockDealSentiment: all.filter(n => n.type === "block_deal").map(n => n.buyOrSell)
  };
}

// ── Refresh all ───────────────────────────────────────────────────────────────
async function refreshAll() {
  console.log("[newsEngine] Refreshing corporate actions + block deals...");
  await Promise.allSettled([
    fetchCorporateActions(),
    fetchBoardMeetings(),
    fetchBlockDeals()
  ]);

  // ── KEY LINE: expose all news globally for preBreakoutEngine ──────
  // preBreakoutEngine checks global.recentNews on every tick
  // to detect: "fresh news hit but price hasn't moved yet"
  global.recentNews = Object.values(symbolNews)
    .flat()
    .filter(n => n.publishedAt)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 200);

  console.log("[newsEngine] global.recentNews updated: " + global.recentNews.length + " items");
}

module.exports = { getSymbolNewsScore, refreshAll, fetchMarketNews, symbolNews };