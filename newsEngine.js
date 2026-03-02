// newsEngine.js
// Fetches real-time news and corporate actions for NSE stocks
// Sources: NSE API, Google News RSS, MoneyControl RSS

const axios = require("axios");

// Cache news to avoid repeated fetches
const newsCache = {};
const NEWS_CACHE_MS = 10 * 60 * 1000; // 10 min cache

// Per-symbol news store
const symbolNews = {};

// ── NSE Corporate Actions (dividends, splits, buybacks) ──────────────
async function fetchCorporateActions() {
  try {
    const resp = await axios.get(
      "https://www.nseindia.com/api/corporates-corporateActions?index=equities",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "Referer": "https://www.nseindia.com"
        },
        timeout: 8000
      }
    );
    const actions = resp.data.data || [];
    actions.forEach(a => {
      const sym = "NSE_EQ|" + a.symbol;
      if (!symbolNews[sym]) symbolNews[sym] = [];
      symbolNews[sym].push({
        type: "corporate_action",
        action: a.purpose,
        exDate: a.exDate,
        details: a.purpose + " ex-date: " + a.exDate,
        sentiment: getCorporateActionSentiment(a.purpose),
        time: new Date().toISOString()
      });
    });
    console.log("Corporate actions loaded: " + actions.length);
  } catch (e) {
    console.log("Corporate actions fetch failed:", e.message);
  }
}

// ── NSE Board Meetings (earnings, dividends announcements) ────────────
async function fetchBoardMeetings() {
  try {
    const resp = await axios.get(
      "https://www.nseindia.com/api/corporates-boardMeetings?index=equities",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "Referer": "https://www.nseindia.com"
        },
        timeout: 8000
      }
    );
    const meetings = resp.data.data || [];
    meetings.forEach(m => {
      const sym = "NSE_EQ|" + m.symbol;
      if (!symbolNews[sym]) symbolNews[sym] = [];
      symbolNews[sym].push({
        type: "board_meeting",
        purpose: m.purpose,
        meetingDate: m.bm_date,
        details: "Board meeting " + m.bm_date + ": " + m.purpose,
        sentiment: getBoardMeetingSentiment(m.purpose),
        time: new Date().toISOString()
      });
    });
    console.log("Board meetings loaded: " + meetings.length);
  } catch (e) {
    console.log("Board meetings fetch failed:", e.message);
  }
}

// ── Google News RSS for stock-specific news ───────────────────────────
async function fetchStockNews(symbol) {
  const cleanSymbol = symbol.replace("NSE_EQ|", "");
  const cacheKey = "news_" + cleanSymbol;

  if (newsCache[cacheKey] && Date.now() - newsCache[cacheKey].time < NEWS_CACHE_MS) {
    return newsCache[cacheKey].data;
  }

  try {
    const query = encodeURIComponent(cleanSymbol + " NSE stock");
    const resp = await axios.get(
      "https://news.google.com/rss/search?q=" + query + "&hl=en-IN&gl=IN&ceid=IN:en",
      { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const articles = parseRSS(resp.data);
    const analyzed = articles.slice(0, 5).map(a => ({
      title: a.title,
      sentiment: analyzeNewsSentiment(a.title),
      time: a.pubDate,
      source: a.source
    }));

    newsCache[cacheKey] = { data: analyzed, time: Date.now() };
    return analyzed;

  } catch (e) {
    return [];
  }
}

// ── NSE Block Deals / Bulk Deals ──────────────────────────────────────
async function fetchBlockDeals() {
  try {
    const resp = await axios.get(
      "https://www.nseindia.com/api/block-deal",
      {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.nseindia.com" },
        timeout: 8000
      }
    );
    const deals = resp.data.data || [];
    deals.forEach(d => {
      const sym = "NSE_EQ|" + d.symbol;
      if (!symbolNews[sym]) symbolNews[sym] = [];
      symbolNews[sym].push({
        type: "block_deal",
        quantity: d.quantity,
        price: d.price,
        client: d.clientName,
        buyOrSell: d.buyOrSell,
        details: d.buyOrSell + " block deal: " + d.quantity + " shares @ ₹" + d.price,
        sentiment: d.buyOrSell === "BUY" ? "positive" : "negative",
        time: new Date().toISOString()
      });
    });
    console.log("Block deals loaded: " + deals.length);
  } catch (e) {
    console.log("Block deals fetch failed:", e.message);
  }
}

// ── Simple RSS Parser ─────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/;
  const pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;
  const sourceRegex = /<source[^>]*>(.*?)<\/source>/;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = titleRegex.exec(item);
    const pubDate = pubDateRegex.exec(item);
    const source = sourceRegex.exec(item);
    if (title) {
      items.push({
        title: title[1],
        pubDate: pubDate ? pubDate[1] : "",
        source: source ? source[1] : ""
      });
    }
  }
  return items;
}

// ── Sentiment Analysis ────────────────────────────────────────────────
function analyzeNewsSentiment(text) {
  const t = text.toLowerCase();

  const strongPositive = ["surge", "soar", "jump", "rally", "breakout", "record high",
    "profit up", "beats estimate", "acquisition", "contract win", "order win",
    "dividend", "buyback", "upgrade", "strong results", "expansion"];

  const strongNegative = ["crash", "plunge", "fall", "loss", "downgrade", "sell off",
    "probe", "fraud", "default", "debt", "miss estimate", "weak results",
    "resignation", "penalty", "ban", "investigation", "warning"];

  const positive = ["rise", "gain", "up", "positive", "growth", "good", "profit",
    "strong", "beat", "win", "approve", "launch"];

  const negative = ["drop", "down", "decline", "concern", "risk", "weak",
    "below", "cut", "reduce", "exit", "sell"];

  if (strongPositive.some(w => t.includes(w))) return "strong_positive";
  if (strongNegative.some(w => t.includes(w))) return "strong_negative";
  if (positive.some(w => t.includes(w))) return "positive";
  if (negative.some(w => t.includes(w))) return "negative";
  return "neutral";
}

function getCorporateActionSentiment(purpose) {
  const p = (purpose || "").toLowerCase();
  if (p.includes("dividend")) return "positive";
  if (p.includes("buyback")) return "strong_positive";
  if (p.includes("split")) return "positive";
  if (p.includes("bonus")) return "positive";
  if (p.includes("rights")) return "neutral";
  return "neutral";
}

function getBoardMeetingSentiment(purpose) {
  const p = (purpose || "").toLowerCase();
  if (p.includes("results") || p.includes("financial")) return "neutral"; // depends on results
  if (p.includes("dividend")) return "positive";
  if (p.includes("buyback")) return "strong_positive";
  if (p.includes("merger") || p.includes("acquisition")) return "positive";
  return "neutral";
}

// ── Get combined news score for a symbol ─────────────────────────────
async function getSymbolNewsScore(symbol) {
  const stored = symbolNews[symbol] || [];
  const fresh = await fetchStockNews(symbol);

  const allNews = [...stored, ...fresh];
  if (allNews.length === 0) return { score: 0, summary: [], newsCount: 0 };

  let score = 0;
  const summary = [];

  allNews.forEach(n => {
    const sentiment = n.sentiment || "neutral";
    if (sentiment === "strong_positive") { score += 20; summary.push("🟢 " + (n.details || n.title)); }
    else if (sentiment === "positive")   { score += 10; summary.push("🟡 " + (n.details || n.title)); }
    else if (sentiment === "negative")   { score -= 10; summary.push("🔴 " + (n.details || n.title)); }
    else if (sentiment === "strong_negative") { score -= 20; summary.push("⛔ " + (n.details || n.title)); }
  });

  return {
    score: Math.max(-100, Math.min(100, score)),
    summary: summary.slice(0, 3),
    newsCount: allNews.length,
    hasEarnings: allNews.some(n => n.type === "board_meeting"),
    hasDividend: allNews.some(n => n.action && n.action.toLowerCase().includes("dividend")),
    hasBlockDeal: allNews.some(n => n.type === "block_deal"),
    blockDealSentiment: allNews.filter(n => n.type === "block_deal").map(n => n.buyOrSell)
  };
}

// ── Refresh all data every 30 mins ───────────────────────────────────
async function refreshAll() {
  console.log("Refreshing news and corporate actions...");
  await Promise.allSettled([
    fetchCorporateActions(),
    fetchBoardMeetings(),
    fetchBlockDeals()
  ]);
}

module.exports = { getSymbolNewsScore, refreshAll, symbolNews };
