// aiResearcher.js — Deep research AI that chains news → macro → sector → stock → trade
// Core philosophy: every news event has a causal chain that ends at a specific NSE stock/ETF
// The AI must reason through ALL chains, not just surface-level matching

const axios = require("axios");

// ── Robust JSON extractor — handles truncated/fenced AI responses ─────────────
function extractJSON(raw) {
  if (!raw) return null;
  let text = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(text); } catch (_) {}
  const start = text.indexOf("{");
  if (start === -1) return null;
  for (let end = text.length; end > start + 10; end--) {
    if (text[end - 1] !== "}" && text[end - 1] !== "]") continue;
    try { return JSON.parse(text.slice(start, end)); } catch (_) {}
  }
  // Auto-close truncated JSON
  const partial = text.slice(start);
  const ob = (partial.match(/{/g)  || []).length;
  const cb = (partial.match(/}/g)  || []).length;
  const oa = (partial.match(/\[/g) || []).length;
  const ca = (partial.match(/\]/g) || []).length;
  let patched = partial.trimEnd()
    .replace(/,?\s*"[^"]*"?\s*:?\s*"?[^"\n]*$/, "")
    .replace(/,\s*$/, "");
  for (let i = 0; i < oa - ca; i++) patched += "]";
  for (let i = 0; i < ob - cb; i++) patched += "}";
  try { return JSON.parse(patched); } catch (_) {}
  return null;
}


// Separate caches: quick 5-min for signal refresh, deep 15-min for full analysis
const cache = {
  deepReport:    null,
  deepAt:        0,
  quickUpdate:   null,
  quickAt:       0
};

const DEEP_TTL_MS  = 15 * 60 * 1000;  // full reasoning every 15 min (expensive)
const QUICK_TTL_MS =  5 * 60 * 1000;  // quick news scan every 5 min (cheap)

function getProvider() {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GEMINI_API_KEY)    return "gemini";
  return null;
}

async function callAI(prompt, maxTokens = 3000) {
  const provider = getProvider();
  if (!provider) throw new Error("No AI key set in .env");

  if (provider === "anthropic") {
    const r = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      timeout: 45000
    });
    return r.data.content[0].text;
  }

  if (provider === "openai") {
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o", max_tokens: maxTokens, temperature: 0.2,
      messages: [
        { role: "system", content: "You are a senior NSE equity research analyst. Always respond in valid JSON only, no markdown fences." },
        { role: "user", content: prompt }
      ]
    }, {
      headers: { "Authorization": "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      timeout: 45000
    });
    return r.data.choices[0].message.content;
  }

  if (provider === "gemini") {
    const r = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=" + process.env.GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens }
      },
      { headers: { "Content-Type": "application/json" }, timeout: 45000 }
    );
    return r.data.candidates[0].content.parts[0].text;
  }
}

// ─── STEP 1: Chain-of-thought news → stocks reasoning ────────────────────────
// This is the core — every news event is traced to specific NSE stocks/ETFs

function buildDeepResearchPrompt(news, fiidii, sectors, currentDateTime) {
  const allNews = news.slice(0, 25).map((n, i) =>
    `${i+1}. [${n.category.toUpperCase()}] ${n.title}\n   ${n.summary ? n.summary.slice(0, 150) : ""}\n   Source: ${n.source} | ${n.publishedAt ? n.publishedAt.slice(0, 16) : ""}`
  ).join("\n\n");

  const sectorData = sectors.sectors.map(s =>
    `${s.name}: ${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)}% | LTP: ${s.ltp} | Strength: ${s.strength}`
  ).join("\n");

  const fiiData = fiidii.fii
    ? `FII Net: ${(fiidii.fii.netValue/100).toFixed(0)} Cr (${fiidii.fii.sentiment})
DII Net: ${(fiidii.dii.netValue/100).toFixed(0)} Cr (${fiidii.dii.sentiment})
Smart Money: ${fiidii.smartMoneySignal ? fiidii.smartMoneySignal.label : "unknown"}
3-Day FII Trend: ${fiidii.fii3DayTrend || "unknown"}`
    : "FII/DII data unavailable";

  return `You are a senior NSE equity research analyst with deep knowledge of Indian markets.
Current time: ${currentDateTime} IST

TASK: Perform DEEP chain-of-thought analysis of all market inputs to generate tomorrow's actionable NSE trading watchlist.

For EVERY major news event you MUST trace the full impact chain:
Example chain: "Iran-Israel war escalates → oil supply fear → crude prices spike → 
  POSITIVE: ONGC, Oil India, Reliance (upstream benefit), BPCL/HPCL mixed (refining margins squeezed)
  POSITIVE: GOLDBEES, SILVERBEES, GOLDIETF (safe haven flows into gold/silver ETFs)  
  POSITIVE: HAL, BEL, BHEL (defense stocks, geopolitical tension spending)
  NEGATIVE: IndiGo, SpiceJet (aviation fuel costs spike)
  NEGATIVE: Paint companies, Tyre companies (petrochem input costs rise)"

You must do this chain reasoning for EVERY significant news item.

═══════════════════════════════════════
LIVE NEWS (last 6 hours — most recent first):
═══════════════════════════════════════
${allNews}

═══════════════════════════════════════
NSE SECTOR PERFORMANCE TODAY:
═══════════════════════════════════════
${sectorData}
Market Breadth: ${sectors.breadth.signal} | Advancing: ${sectors.breadth.advancing} | Declining: ${sectors.breadth.declining}

═══════════════════════════════════════
FII/DII SMART MONEY FLOWS:
═══════════════════════════════════════
${fiiData}

═══════════════════════════════════════
ANALYSIS FRAMEWORK — reason through ALL of these:
═══════════════════════════════════════

1. GEOPOLITICAL: Wars, sanctions, trade tensions → commodities, defense, export/import impact
2. MONETARY POLICY: RBI/Fed rate changes → banking, NBFCs, real estate, rate-sensitives  
3. CURRENCY: USD/INR moves → IT exports (benefit), import-heavy cos (hurt), pharma (mixed)
4. CRUDE OIL: Price direction → upstream oil cos, OMCs, aviation, paint, chemicals, tyres
5. GOLD/SILVER: Safe haven demand → GOLDBEES, SILVERBEES, gold finance cos (Muthoot, Manappuram)
6. FII FLOWS: Heavy buying → index heavyweights (HDFC Bank, Reliance, Infosys, TCS)
7. EARNINGS/RESULTS: Beat/miss → direct stock + sector contagion
8. SECTOR ROTATION: Which sectors FII rotating into vs out of
9. GLOBAL INDICES: SGX Nifty, Dow, Nasdaq direction → gap-up/gap-down plays
10. DOMESTIC MACRO: GDP, inflation, IIP → consumption vs investment theme

NSE STOCK/ETF UNIVERSE TO CONSIDER (always use exact NSE symbols):
- Gold ETFs: GOLDBEES, GOLDIETF, AXISGOLD, ICICIGOLD
- Silver ETFs: SILVERBEES, SILVRETF  
- Oil: ONGC, OIL, BPCL, HPCL, IOC, RELIANCE
- Defense: HAL, BEL, BHEL, BEML, MIDHANI, COCHINSHIP
- Banking: HDFCBANK, ICICIBANK, SBIN, AXISBANK, KOTAKBANK, BANDHANBNK, IDFCFIRSTB
- IT: INFY, TCS, WIPRO, HCLTECH, TECHM, LTIM
- Pharma: SUNPHARMA, DRREDDY, CIPLA, DIVISLAB, AUROPHARMA
- Auto: TATAMOTORS, M&M, MARUTI, BAJAJ-AUTO, HEROMOTOCO, EICHERMOT
- FMCG: HINDUNILVR, ITC, NESTLEIND, BRITANNIA, DABUR
- Metal: TATASTEEL, JSWSTEEL, HINDALCO, COALINDIA, NMDC
- Realty: DLF, GODREJPROP, PRESTIGE, BRIGADE, OBEROIRLTY
- Index ETFs: NIFTYBEES, JUNIORBEES, BANKBEES, ITBEES, PSUBNKBEES
- Chemicals: PIDILITIND, ASIAN PAINTS, BERGER, KANSAINER
- Aviation: INDIGO, SPICEJET

Respond ONLY in this exact JSON structure (no markdown, no extra text, valid JSON only):
{
  "analysisTimestamp": "${new Date().toISOString()}",
  "marketOutlook": {
    "bias": "BULLISH" | "BEARISH" | "SIDEWAYS",
    "confidence": 1-10,
    "oneLiner": "single punchy sentence for the day",
    "summary": "3-4 sentence detailed outlook covering macro + FII + key themes",
    "openingExpectation": "GAP_UP_STRONG" | "GAP_UP_MILD" | "FLAT" | "GAP_DOWN_MILD" | "GAP_DOWN_STRONG",
    "keyRisks": ["specific risk 1", "specific risk 2", "specific risk 3"],
    "keyTailwinds": ["specific tailwind 1", "specific tailwind 2", "specific tailwind 3"],
    "tradingStyle": "AGGRESSIVE" | "SELECTIVE" | "DEFENSIVE" | "AVOID"
  },
  "causalChains": [
    {
      "trigger": "exact news event or data point",
      "triggerCategory": "GEOPOLITICAL" | "MONETARY" | "CRUDE" | "GOLD" | "FII" | "EARNINGS" | "CURRENCY" | "MACRO" | "SECTOR",
      "chain": "trigger → intermediate effect → market impact (write the full chain in one sentence)",
      "impactedStocks": [
        {
          "symbol": "NSE_SYMBOL",
          "direction": "BUY" | "SELL" | "WATCH",
          "reason": "exactly why this stock is impacted",
          "magnitude": "HIGH" | "MEDIUM" | "LOW",
          "immediacy": "TOMORROW_OPEN" | "THIS_WEEK" | "ONGOING"
        }
      ],
      "urgency": "HIGH" | "MEDIUM" | "LOW",
      "confidence": 1-10
    }
  ],
  "watchlist": [
    {
      "symbol": "EXACT_NSE_SYMBOL",
      "companyName": "Full Company Name",
      "sector": "sector name",
      "tradeType": "MOMENTUM" | "BREAKOUT" | "NEWS_PLAY" | "REVERSAL" | "ETF_FLOW",
      "direction": "LONG" | "SHORT",
      "thesis": "One crisp sentence — WHY this stock tomorrow",
      "newsLink": "which news item triggered this (quote the headline briefly)",
      "causalReasoning": "Full chain: news event → macro impact → sector effect → why this specific stock moves",
      "catalysts": ["specific catalyst 1", "specific catalyst 2"],
      "entryZone": {
        "low": number,
        "high": number,
        "entryNote": "e.g. buy on dip to support / buy breakout above X"
      },
      "stopLoss": number,
      "target1": number,
      "target2": number,
      "riskReward": "1:X",
      "confidence": 1-10,
      "timeOfDay": "OPEN_9:15" | "FIRST_30MIN" | "FIRST_HOUR" | "ANYTIME" | "AFTERNOON",
      "holdTime": "15 mins" | "30 mins" | "1-2 hours" | "full day",
      "watchIfNewsChanges": "condition that would invalidate this trade"
    }
  ],
  "sectorPlaybook": {
    "strongBuy": [{ "sector": "name", "reason": "why", "etf": "ETF symbol if any" }],
    "strongSell": [{ "sector": "name", "reason": "why" }],
    "rotationTheme": "where smart money moving today in 1 sentence",
    "avoidSectors": ["sector1", "sector2"]
  },
  "fiiDiiPlaybook": {
    "interpretation": "2-3 sentence deep interpretation of FII/DII flows and what they signal",
    "impliedBias": "which stocks FII likely buying/selling based on flows",
    "followTheMoney": ["SYMBOL1", "SYMBOL2", "SYMBOL3"]
  },
  "riskMatrix": [
    {
      "risk": "specific risk description",
      "probability": "HIGH" | "MEDIUM" | "LOW",
      "hedgeWith": "how to hedge or which stock to avoid"
    }
  ],
  "dynamicAlerts": [
    {
      "watchFor": "specific event or price level to monitor during the day",
      "ifHappens": "what to do / what it signals",
      "affectedSymbols": ["SYMBOL1"]
    }
  ]
}

IMPORTANT RULES:
1. Use ONLY real NSE-listed symbols. Never invent symbols.
2. Give SPECIFIC price levels based on approximate current market levels.
3. Every watchlist item MUST have a causalReasoning that traces back to actual news/data.
4. watchIfNewsChanges is critical — markets change fast, tell us what invalidates the trade.
5. Include 6-10 watchlist stocks minimum. Mix ETFs and individual stocks.
6. dynamicAlerts are intraday triggers — things to watch DURING the trading session.`;
}

// ─── STEP 2: Quick 5-min incremental news update (cheaper, faster) ────────────

function buildQuickUpdatePrompt(newArticles, existingWatchlist) {
  const newsText = newArticles.slice(0, 8).map(n =>
    `[${n.category.toUpperCase()}] ${n.title} — ${n.summary ? n.summary.slice(0, 100) : ""}`
  ).join("\n");

  const existingSymbols = (existingWatchlist || []).map(w => w.symbol).join(", ");

  return `You are an NSE intraday trader. New news just broke in last 5 minutes.

NEW HEADLINES:
${newsText}

CURRENT WATCHLIST: ${existingSymbols}

TASK: Based ONLY on this new news, respond in valid JSON:
{
  "hasSignificantChange": true | false,
  "urgentAlerts": [
    {
      "headline": "the news",
      "impactedSymbols": ["SYMBOL1", "SYMBOL2"],
      "direction": "BUY" | "SELL",
      "reason": "quick 1-line reason",
      "urgency": "HIGH" | "MEDIUM"
    }
  ],
  "addToWatchlist": [
    {
      "symbol": "NSE_SYMBOL",
      "thesis": "one sentence why",
      "newsLink": "which headline",
      "tradeType": "NEWS_PLAY",
      "entryZone": { "low": 0, "high": 0 },
      "stopLoss": 0,
      "target1": 0,
      "confidence": 1-10
    }
  ],
  "removeFromWatchlist": ["SYMBOL_THAT_IS_NOW_INVALID"],
  "marketBiasChange": null | "now more BULLISH" | "now more BEARISH"
}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function generateResearch(news, fiidii, sectors) {
  const now = Date.now();

  // Full deep analysis every 15 min
  if (!cache.deepReport || now - cache.deepAt >= DEEP_TTL_MS) {
    console.log("Running DEEP research analysis...");
    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    try {
      const prompt = buildDeepResearchPrompt(news, fiidii, sectors, ist);
      const raw    = await callAI(prompt, 6000);
      const parsed = extractJSON(raw);
      if (!parsed) throw new Error("extractJSON failed — raw length: " + (raw||"").length);

      cache.deepReport = parsed;
      cache.deepAt     = now;

      console.log(
        "DEEP research done: bias=" + (parsed.marketOutlook || {}).bias +
        " watchlist=" + (parsed.watchlist || []).length +
        " chains=" + (parsed.causalChains || []).length
      );
    } catch (e) {
      console.error("Deep research error:", e.message);
      // Return stale cache if available
      if (cache.deepReport) return cache.deepReport;
      return null;
    }
  }

  // Quick incremental update every 5 min (only if new news exists)
  if (news.length > 0 && now - cache.quickAt >= QUICK_TTL_MS) {
    const recentNews = news.filter(n => {
      const age = now - new Date(n.publishedAt || 0).getTime();
      return age < 10 * 60 * 1000; // only news from last 10 min
    });

    if (recentNews.length > 0 && cache.deepReport) {
      console.log("Running QUICK news update for " + recentNews.length + " new articles...");
      try {
        const prompt  = buildQuickUpdatePrompt(recentNews, cache.deepReport.watchlist);
        const raw     = await callAI(prompt, 2000);
        const update  = extractJSON(raw);
        if (!update) throw new Error("extractJSON failed on quick update");

        cache.quickAt = now;

        if (update.hasSignificantChange) {
          console.log("Quick update: significant change detected — " + (update.urgentAlerts || []).length + " alerts");

          // Merge quick update into deep report
          if (update.addToWatchlist && update.addToWatchlist.length > 0) {
            cache.deepReport.watchlist = [
              ...update.addToWatchlist.map(s => ({ ...s, tradeType: "NEWS_PLAY", addedByQuickUpdate: true })),
              ...cache.deepReport.watchlist.filter(w =>
                !(update.removeFromWatchlist || []).includes(w.symbol)
              )
            ];
          }

          // Attach urgent alerts to report
          cache.deepReport.urgentAlerts    = update.urgentAlerts || [];
          cache.deepReport.quickUpdateAt   = new Date().toISOString();

          if (update.marketBiasChange) {
            cache.deepReport.marketOutlook.quickBiasUpdate = update.marketBiasChange;
          }
        }
      } catch (e) {
        console.error("Quick update error:", e.message);
      }
    }
  }

  return cache.deepReport;
}

function getMarketPhase() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const d = now.getDay(), h = now.getHours(), m = now.getMinutes();
  if (d === 0 || d === 6) return "OVERNIGHT";
  const totalMin = h * 60 + m;
  if (totalMin < 9 * 60)                    return "OVERNIGHT";
  if (totalMin < 9 * 60 + 15)               return "OPENING";
  if (totalMin <= 15 * 60 + 35)             return "INTRADAY";
  return "OVERNIGHT";
}

module.exports = { generateResearch, getMarketPhase };