// marketContext.js
// Tracks global market context:
// - SGX Nifty (pre-market indicator)
// - US markets (Dow, S&P, Nasdaq)
// - India VIX (fear index)
// - Nifty 50 direction + sector strength
// - FII/DII activity

const axios = require("axios");

const context = {
  // Nifty
  niftyLTP: 0,
  niftyOpen: 0,
  niftyChange: 0,
  niftyDirection: "unknown",  // bull / bear / sideways

  // VIX
  vix: 0,
  vixLevel: "unknown",        // low / medium / high / extreme

  // US markets (previous night)
  usMarkets: {
    sp500Change: 0,
    dowChange: 0,
    nasdaqChange: 0,
    sentiment: "unknown"      // positive / negative / neutral
  },

  // SGX Nifty (pre-market)
  sgxNifty: 0,
  sgxNiftyChange: 0,

  // Sector performance
  sectors: {},

  // FII/DII
  fiiActivity: "unknown",     // buying / selling / neutral
  diiActivity: "unknown",

  // Overall market score (-100 to +100)
  overallScore: 0,
  overallSentiment: "unknown",

  lastUpdate: 0
};

// ── Fetch Nifty + VIX from NSE ────────────────────────────────────────
async function fetchNiftyAndVIX(accessToken) {
  try {
    const resp = await axios.get(
      "https://api.upstox.com/v2/market-quote/ltp",
      {
        headers: { Authorization: "Bearer " + accessToken, "Api-Version": "2" },
        params: { instrument_key: "NSE_INDEX|Nifty 50,NSE_INDEX|India VIX" },
        timeout: 5000
      }
    );
    const data = resp.data.data || {};

    for (const [key, val] of Object.entries(data)) {
      if (key.includes("Nifty 50")) {
        context.niftyLTP = val.last_price;
        if (context.niftyOpen === 0) context.niftyOpen = val.last_price;
        context.niftyChange = context.niftyOpen > 0
          ? ((val.last_price - context.niftyOpen) / context.niftyOpen) * 100 : 0;
        if (context.niftyChange > 0.3)       context.niftyDirection = "bull";
        else if (context.niftyChange < -0.3)  context.niftyDirection = "bear";
        else                                   context.niftyDirection = "sideways";
      }
      if (key.includes("VIX")) {
        context.vix = val.last_price;
        // India VIX: 20 is normal. Only block above 30 (true panic).
        if (context.vix < 14)       context.vixLevel = "low";       // great
        else if (context.vix < 20)  context.vixLevel = "medium";    // normal
        else if (context.vix < 28)  context.vixLevel = "high";      // cautious but tradeable
        else                        context.vixLevel = "extreme";   // true panic, avoid
      }
    }
  } catch (e) {
    // Silently fail
  }
}

// ── Fetch US Markets from Yahoo Finance RSS ───────────────────────────
async function fetchUSMarkets() {
  try {
    // Yahoo Finance API for indices
    const symbols = ["%5EGSPC", "%5EDJI", "%5EIXIC"]; // S&P, Dow, Nasdaq
    const resp = await axios.get(
      "https://query1.finance.yahoo.com/v8/finance/spark?symbols=" +
      symbols.join(",") + "&range=1d&interval=1d",
      { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const result = resp.data.spark && resp.data.spark.result || [];
    result.forEach(r => {
      const change = r.response && r.response[0] &&
        r.response[0].meta && r.response[0].meta.regularMarketChangePercent || 0;
      if (r.symbol === "^GSPC") context.usMarkets.sp500Change = parseFloat(change.toFixed(2));
      if (r.symbol === "^DJI")  context.usMarkets.dowChange   = parseFloat(change.toFixed(2));
      if (r.symbol === "^IXIC") context.usMarkets.nasdaqChange = parseFloat(change.toFixed(2));
    });

    const avgChange = (context.usMarkets.sp500Change +
      context.usMarkets.dowChange + context.usMarkets.nasdaqChange) / 3;

    if (avgChange > 0.5)       context.usMarkets.sentiment = "positive";
    else if (avgChange < -0.5) context.usMarkets.sentiment = "negative";
    else                       context.usMarkets.sentiment = "neutral";

    console.log("US markets: S&P " + context.usMarkets.sp500Change + "% Dow " +
      context.usMarkets.dowChange + "% Nasdaq " + context.usMarkets.nasdaqChange + "%");

  } catch (e) {
    console.log("US markets fetch failed:", e.message);
  }
}

// ── Fetch Sector Performance ──────────────────────────────────────────
async function fetchSectors(accessToken) {
  const sectorKeys = {
    "NSE_INDEX|Nifty Bank":    "Bank",
    "NSE_INDEX|Nifty IT":      "IT",
    "NSE_INDEX|Nifty Auto":    "Auto",
    "NSE_INDEX|Nifty FMCG":    "FMCG",
    "NSE_INDEX|Nifty Pharma":  "Pharma",
    "NSE_INDEX|Nifty Metal":   "Metal",
    "NSE_INDEX|Nifty Realty":  "Realty",
    "NSE_INDEX|Nifty Energy":  "Energy"
  };

  try {
    const resp = await axios.get(
      "https://api.upstox.com/v2/market-quote/ltp",
      {
        headers: { Authorization: "Bearer " + accessToken, "Api-Version": "2" },
        params: { instrument_key: Object.keys(sectorKeys).join(",") },
        timeout: 8000
      }
    );

    const data = resp.data.data || {};
    for (const [key, val] of Object.entries(data)) {
      const sectorName = sectorKeys[key];
      if (sectorName) {
        if (!context.sectors[sectorName]) {
          context.sectors[sectorName] = { open: val.last_price, ltp: val.last_price, change: 0 };
        } else {
          const open = context.sectors[sectorName].open;
          context.sectors[sectorName].ltp = val.last_price;
          context.sectors[sectorName].change = open > 0
            ? parseFloat(((val.last_price - open) / open * 100).toFixed(2)) : 0;
        }
      }
    }
  } catch (e) {}
}

// ── Calculate Overall Market Score ───────────────────────────────────
function calculateOverallScore() {
  let score = 0;

  // Nifty direction (0-30 pts)
  if (context.niftyDirection === "bull")       score += 30;
  else if (context.niftyDirection === "sideways") score += 10;
  else if (context.niftyDirection === "bear")  score -= 30;

  // VIX level (0-25 pts)
  if (context.vixLevel === "low")      score += 25;
  else if (context.vixLevel === "medium") score += 15;
  else if (context.vixLevel === "high")   score -= 10;
  else if (context.vixLevel === "extreme") score -= 30;

  // US markets (0-25 pts)
  if (context.usMarkets.sentiment === "positive") score += 25;
  else if (context.usMarkets.sentiment === "neutral") score += 10;
  else if (context.usMarkets.sentiment === "negative") score -= 15;

  // Sector breadth (0-20 pts)
  const sectorValues = Object.values(context.sectors);
  if (sectorValues.length > 0) {
    const bullSectors = sectorValues.filter(s => s.change > 0.3).length;
    const bearSectors = sectorValues.filter(s => s.change < -0.3).length;
    const breadth = (bullSectors - bearSectors) / sectorValues.length;
    score += Math.round(breadth * 20);
  }

  context.overallScore = Math.max(-100, Math.min(100, score));

  if (context.overallScore >= 40)       context.overallSentiment = "bullish";
  else if (context.overallScore >= 10)  context.overallSentiment = "mildly_bullish";
  else if (context.overallScore >= -10) context.overallSentiment = "neutral";
  else if (context.overallScore >= -40) context.overallSentiment = "mildly_bearish";
  else                                  context.overallSentiment = "bearish";

  context.lastUpdate = Date.now();
  return context.overallScore;
}

// ── Get top performing sectors ────────────────────────────────────────
function getTopSectors() {
  return Object.entries(context.sectors)
    .sort((a, b) => b[1].change - a[1].change)
    .slice(0, 3)
    .map(([name, data]) => name + " " + (data.change > 0 ? "+" : "") + data.change + "%");
}

function getWeakSectors() {
  return Object.entries(context.sectors)
    .sort((a, b) => a[1].change - b[1].change)
    .slice(0, 2)
    .map(([name, data]) => name + " " + data.change + "%");
}

// ── Check if safe to trade ────────────────────────────────────────────
function isSafeToTrade() {
  // Only block on genuine panic: VIX > 28, Nifty crash > 2%, or full market meltdown
  if (context.vixLevel === "extreme") return { safe: false, reason: "VIX extreme (" + context.vix + ") — panic mode, avoid" };
  if (context.niftyDirection === "bear" && context.niftyChange < -2) return { safe: false, reason: "Nifty crashing " + context.niftyChange.toFixed(2) + "%" };
  if (context.overallScore < -60) return { safe: false, reason: "Full market meltdown — avoid longs" };
  // Sideways + high VIX = reduce but don't block (these days have the best individual movers)
  return { safe: true };
}

// ── Main refresh function ─────────────────────────────────────────────
async function refreshMarketContext(accessToken) {
  await Promise.allSettled([
    fetchNiftyAndVIX(accessToken),
    fetchUSMarkets(),
    fetchSectors(accessToken)
  ]);
  calculateOverallScore();

  console.log(
    "Market context: Nifty=" + context.niftyDirection +
    " VIX=" + context.vix + "(" + context.vixLevel + ")" +
    " Score=" + context.overallScore +
    " Sentiment=" + context.overallSentiment
  );
}

module.exports = {
  context,
  refreshMarketContext,
  isSafeToTrade,
  getTopSectors,
  getWeakSectors,
  calculateOverallScore
};