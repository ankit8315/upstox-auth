// aiResearcher.js
// Deep research AI — news → sector → stock → trade plan
// OVERNIGHT: runs once per hour, builds tomorrow's watchlist
// INTRADAY:  runs every 15 min, live market analysis
// QUICK:     incremental news scan between deep runs

const axios = require("axios");

const cache = {
  deepReport: null,
  deepAt:     0,
  quickAt:    0,
  lastMode:   null
};

const DEEP_INTRADAY_TTL_MS  = 14 * 60 * 1000;  // 14 min
const DEEP_OVERNIGHT_TTL_MS = 58 * 60 * 1000;  // 58 min
const QUICK_TTL_MS          = 14 * 60 * 1000;

const providerBackoff = { gemini: 0, openai: 0, anthropic: 0 };

async function callAI(prompt, maxTokens = 3000) {
  const now = Date.now();

  const providers = [];
  if (process.env.ANTHROPIC_API_KEY && now > providerBackoff.anthropic) providers.push("anthropic");
  if (process.env.GEMINI_API_KEY    && now > providerBackoff.gemini)    providers.push("gemini");
  if (process.env.OPENAI_API_KEY    && now > providerBackoff.openai)    providers.push("openai");

  if (providers.length === 0) {
    const earliest = Math.min(...Object.values(providerBackoff).filter(t => t > 0));
    const sec = Math.round((earliest - now) / 1000);
    throw new Error("All AI providers rate-limited. Next retry in " + sec + "s");
  }

  let lastErr = null;
  for (const provider of providers) {
    try {
      console.log("[AI] Trying provider: " + provider);
      const result = await callProvider(provider, prompt, maxTokens);
      console.log("[AI] Success via " + provider);
      return result;
    } catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      if (status === 429 || status === 503) {
        providerBackoff[provider] = Date.now() + 25 * 60 * 1000;
        console.warn("[AI] " + provider + " rate limited — backing off 25min");
      } else {
        console.warn("[AI] " + provider + " failed (" + (status || err.message) + ")");
      }
    }
  }
  throw lastErr || new Error("All AI providers failed");
}

async function callProvider(provider, prompt, maxTokens) {
  if (provider === "anthropic") {
    const r = await axios.post("https://api.anthropic.com/v1/messages", {
      model:      "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }]
    }, {
      headers: {
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json"
      },
      timeout: 90000
    });
    return r.data.content[0].text;
  }

  if (provider === "gemini") {
    const model = "gemini-2.5-flash";
    const r = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + process.env.GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens }
      },
      { headers: { "Content-Type": "application/json" }, timeout: 90000 }
    );
    return r.data.candidates[0].content.parts[0].text;
  }

  if (provider === "openai") {
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini", max_tokens: maxTokens, temperature: 0.3,
      messages: [
        { role: "system", content: "You are an NSE trader. Respond ONLY in valid JSON, no markdown." },
        { role: "user",   content: prompt }
      ]
    }, {
      headers: { "Authorization": "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      timeout: 90000
    });
    return r.data.choices[0].message.content;
  }

  throw new Error("Unknown provider: " + provider);
}

// ─── Market phase ─────────────────────────────────────────────────────────────
function getMarketPhase() {
  const now  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 9 * 60 + 15)  return "PRE_MARKET";
  if (mins < 9 * 60 + 30)  return "OPENING";
  if (mins < 15 * 60 + 30) return "INTRADAY";
  return "OVERNIGHT";
}

// ─── OVERNIGHT prompt — compact, focused on pre-breakout setups ───────────────
function buildOvernightPrompt(news, fiidii, sectors, upcomingEarnings, ist) {

  const topNews = news.slice(0, 12).map((n, i) =>
    `${i+1}. [${(n.category||"general").toUpperCase()}] ${n.title} (${n.source})`
  ).join("\n");

  const sectorLines = (sectors.sectors || []).map(s =>
    `${s.name}: ${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)}% (${s.strength})`
  ).join(" | ");

  const fiiLine = fiidii && fiidii.fii
    ? `FII: ₹${(fiidii.fii.netValue/100).toFixed(0)}Cr (${fiidii.fii.sentiment}) | DII: ₹${(fiidii.dii.netValue/100).toFixed(0)}Cr`
    : "FII/DII: unavailable";

  const earningsLine = upcomingEarnings && upcomingEarnings.length > 0
    ? upcomingEarnings.slice(0, 5).map(e => `${e.symbol} (${e.purpose})`).join(", ")
    : "none";

  return `You are a profitable NSE trader. Time: ${ist} IST. Market CLOSED.
Build tomorrow's pre-breakout watchlist. Focus on stocks BEFORE they move — volume building, news catalyst, key level.

NEWS (pick the most market-moving):
${topNews}

SECTORS TODAY: ${sectorLines}
Advancing: ${(sectors.breadth||{}).advancing||"?"} | Declining: ${(sectors.breadth||{}).declining||"?"}
${fiiLine}
Earnings tomorrow: ${earningsLine}

Pick 8-12 NSE stocks. Use correct NSE symbols. Every stock MUST have a specific news reason.
Focus on pre-breakout setups: volume building + news catalyst + approaching key level.

Respond ONLY in valid JSON, no markdown:
{
  "mode": "OVERNIGHT",
  "marketOutlook": {
    "bias": "BULLISH|BEARISH|SIDEWAYS",
    "oneLiner": "one punchy sentence for tomorrow",
    "summary": "2-3 sentences: global cues + FII + sector theme",
    "openingExpectation": "GAP_UP|FLAT|GAP_DOWN",
    "expectedNiftyRange": "22400-22650",
    "tradingStyle": "AGGRESSIVE|SELECTIVE|DEFENSIVE",
    "firstHalfBias": "BULLISH|BEARISH|WAIT",
    "keyRisks": ["risk1", "risk2"],
    "keyTailwinds": ["tailwind1"]
  },
  "watchlist": [
    {
      "symbol": "NSE_SYMBOL",
      "companyName": "Company Name",
      "sector": "sector",
      "direction": "LONG|SHORT",
      "tradeType": "BREAKOUT|MOMENTUM|NEWS_PLAY|GAP_TRADE|REVERSAL",
      "thesis": "why this stock tomorrow — 1 specific sentence",
      "newsLink": "which headline drives this",
      "entryZone": { "low": 100, "high": 105, "note": "buy above X on volume" },
      "stopLoss": 97,
      "target1": 112,
      "target2": 120,
      "confidence": 8,
      "timeOfDay": "OPEN|FIRST_30MIN|FIRST_HOUR|ANYTIME",
      "invalidateIf": "specific price or event that kills this trade"
    }
  ],
  "sectorPlaybook": {
    "strongBuy": ["sector1"],
    "avoid": ["sector2"],
    "rotationTheme": "one sentence on where smart money moving"
  },
  "premarketBriefing": {
    "firstTrade": "best first trade at 9:15 — stock, entry, why",
    "dontChase": "what to avoid even if opens strong"
  }
}`;
}

// ─── INTRADAY prompt — live market, compact ───────────────────────────────────
function buildIntradayPrompt(news, fiidii, sectors, ist) {

  const topNews = news.slice(0, 8).map((n, i) =>
    `${i+1}. ${n.title} (${n.source})`
  ).join("\n");

  const sectorLines = (sectors.sectors || []).slice(0, 8).map(s =>
    `${s.name}: ${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)}%`
  ).join(" | ");

  const fiiLine = fiidii && fiidii.fii
    ? `FII: ₹${(fiidii.fii.netValue/100).toFixed(0)}Cr (${fiidii.fii.sentiment})`
    : "FII: unavailable";

  return `NSE trader. Time: ${ist}. Market OPEN.

NEWS:
${topNews}

SECTORS: ${sectorLines}
Advancing: ${(sectors.breadth||{}).advancing||"?"} | Declining: ${(sectors.breadth||{}).declining||"?"}
${fiiLine}

Find stocks BEFORE they break out — volume building, news catalyst, approaching key level.
Pick 8-10 stocks. Every pick must have a specific news or data reason.

Respond ONLY in valid JSON, no markdown:
{
  "mode": "INTRADAY",
  "marketOutlook": {
    "bias": "BULLISH|BEARISH|SIDEWAYS",
    "oneLiner": "one sentence",
    "tradingStyle": "AGGRESSIVE|SELECTIVE|DEFENSIVE"
  },
  "watchlist": [
    {
      "symbol": "NSE_SYMBOL",
      "companyName": "Name",
      "sector": "sector",
      "direction": "LONG|SHORT",
      "tradeType": "BREAKOUT|MOMENTUM|NEWS_PLAY|REVERSAL",
      "thesis": "why now — 1 sentence with specific reason",
      "newsLink": "which headline",
      "entryZone": { "low": 100, "high": 105, "note": "entry condition" },
      "stopLoss": 97,
      "target1": 112,
      "target2": 120,
      "confidence": 8,
      "timeOfDay": "NOW|FIRST_30MIN|ANYTIME",
      "invalidateIf": "what kills this trade"
    }
  ],
  "sectorPlaybook": {
    "strongBuy": ["sector1"],
    "avoid": ["sector2"],
    "rotationTheme": "one sentence"
  }
}`;
}

// ─── QUICK UPDATE prompt ──────────────────────────────────────────────────────
function buildQuickUpdatePrompt(newArticles, existingWatchlist) {
  const newsText = newArticles.slice(0, 5).map(n =>
    `${n.title} (${n.source})`
  ).join("\n");

  const symbols = (existingWatchlist || []).map(w => w.symbol).join(", ");

  return `NSE trader. Breaking news in last 10 minutes:

${newsText}

Current watchlist: ${symbols || "none"}

Any urgent changes? Respond in valid JSON only:
{
  "hasSignificantChange": true,
  "urgentAlerts": [
    { "symbol": "NSE_SYMBOL", "direction": "BUY|SELL", "reason": "one line why", "urgency": "HIGH|MEDIUM" }
  ],
  "addToWatchlist": [
    {
      "symbol": "NSE_SYMBOL", "thesis": "why", "newsLink": "headline",
      "entryZone": { "low": 100, "high": 105 }, "stopLoss": 97, "target1": 112, "confidence": 8,
      "invalidateIf": "condition"
    }
  ],
  "removeFromWatchlist": [],
  "marketBiasChange": null
}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function generateResearch(news, fiidii, sectors, upcomingEarnings) {
  const now       = Date.now();
  const phase     = getMarketPhase();
  const ist       = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const isOvernight = (phase === "OVERNIGHT" || phase === "PRE_MARKET");
  const deepTTL   = isOvernight ? DEEP_OVERNIGHT_TTL_MS : DEEP_INTRADAY_TTL_MS;

  const needsRefresh = !cache.deepReport
    || (now - cache.deepAt >= deepTTL)
    || (cache.lastMode !== (isOvernight ? "OVERNIGHT" : "INTRADAY"));

  if (needsRefresh) {
    const mode = isOvernight ? "OVERNIGHT" : "INTRADAY";
    console.log("[aiResearcher] Running " + mode + " deep analysis at " + ist);

    try {
      const prompt = isOvernight
        ? buildOvernightPrompt(news, fiidii, sectors, upcomingEarnings || [], ist)
        : buildIntradayPrompt(news, fiidii, sectors, ist);

      const raw    = await callAI(prompt, 3000);
      const clean  = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

      cache.deepReport = parsed;
      cache.deepAt     = now;
      cache.lastMode   = mode;

      console.log(
        "[aiResearcher] " + mode + " done: bias=" + ((parsed.marketOutlook || {}).bias || "?") +
        " watchlist=" + (parsed.watchlist || []).length
      );
    } catch (e) {
      console.error("[aiResearcher] Deep analysis error:", e.message);
      if (cache.deepReport) {
        console.log("[aiResearcher] Returning stale cache");
        return cache.deepReport;
      }
      return null;
    }
  }

  // Quick update during intraday only
  if (!isOvernight && news.length > 0 && now - cache.quickAt >= QUICK_TTL_MS) {
    const recentNews = news.filter(n => {
      const age = now - new Date(n.publishedAt || 0).getTime();
      return age < 10 * 60 * 1000;
    });

    if (recentNews.length > 0 && cache.deepReport) {
      console.log("[aiResearcher] Quick update: " + recentNews.length + " new articles");
      try {
        const prompt = buildQuickUpdatePrompt(recentNews, cache.deepReport.watchlist);
        const raw    = await callAI(prompt, 1000);
        const clean  = raw.replace(/```json|```/g, "").trim();
        const update = JSON.parse(clean);

        cache.quickAt = now;

        if (update.hasSignificantChange) {
          if (update.addToWatchlist && update.addToWatchlist.length > 0) {
            cache.deepReport.watchlist = [
              ...update.addToWatchlist.map(s => ({ ...s, tradeType: "NEWS_PLAY", addedByQuickUpdate: true })),
              ...(cache.deepReport.watchlist || []).filter(w =>
                !(update.removeFromWatchlist || []).includes(w.symbol)
              )
            ];
          }
          cache.deepReport.urgentAlerts  = update.urgentAlerts || [];
          cache.deepReport.quickUpdateAt = new Date().toISOString();
        }
      } catch (e) {
        console.error("[aiResearcher] Quick update error:", e.message);
      }
    }
  }

  return cache.deepReport;
}

module.exports = { generateResearch, getMarketPhase, providerBackoff };