// aiResearcher.js
// Deep research AI — chains news → macro → sector → stock → exact trade plan
//
// THREE MODES:
//   1. OVERNIGHT (after 15:30, before 9:15) — do tomorrow's homework.
//      No live prices needed. Uses news, earnings calendar, FII flows, sector data.
//      Produces a full pre-market briefing: what to buy at open, at what price, why.
//
//   2. INTRADAY (09:15–15:30) — live market analysis every 15 min.
//      Uses live prices + VWAP + volume + candle context.
//
//   3. QUICK_UPDATE — incremental 5-min news scan, cheaply patches the main report.
//
// The old system only ran mode 2 and needed breakouts to fire first.
// Now the AI does its homework at night, has a thesis ready at 9:14am.

const axios = require("axios");

const cache = {
  deepReport:   null,
  deepAt:       0,
  quickAt:      0,
  lastMode:     null    // "OVERNIGHT" | "INTRADAY"
};

const DEEP_INTRADAY_TTL_MS  = 15 * 60 * 1000;
const DEEP_OVERNIGHT_TTL_MS = 60 * 60 * 1000;  // overnight report good for 1 hour
const QUICK_TTL_MS          =  5 * 60 * 1000;

function getProvider() {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GEMINI_API_KEY)    return "gemini";
  return null;
}

async function callAI(prompt, maxTokens = 4000) {
  const provider = getProvider();
  if (!provider) throw new Error("No AI key set in .env (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)");

  if (provider === "anthropic") {
    const r = await axios.post("https://api.anthropic.com/v1/messages", {
      model:      "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }]
    }, {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      timeout: 60000
    });
    return r.data.content[0].text;
  }

  if (provider === "openai") {
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o", max_tokens: maxTokens, temperature: 0.2,
      messages: [
        { role: "system", content: "You are a senior NSE equity research analyst. Always respond in valid JSON only, no markdown fences." },
        { role: "user",   content: prompt }
      ]
    }, {
      headers: { "Authorization": "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      timeout: 60000
    });
    return r.data.choices[0].message.content;
  }

  if (provider === "gemini") {
    const r = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=" + process.env.GEMINI_API_KEY,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens } },
      { headers: { "Content-Type": "application/json" }, timeout: 60000 }
    );
    return r.data.candidates[0].content.parts[0].text;
  }
}

// ─── Market hours helper ──────────────────────────────────────────────────────
function getMarketPhase() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;

  if (mins < 9 * 60 + 15)   return "PRE_MARKET";   // before 9:15
  if (mins < 9 * 60 + 30)   return "OPENING";       // 9:15–9:30 chaos
  if (mins < 15 * 60 + 30)  return "INTRADAY";      // 9:30–15:30
  return "OVERNIGHT";                                 // after 15:30
}

// ─── OVERNIGHT / PRE-MARKET prompt ───────────────────────────────────────────
// This is what a real trader does at 9pm: reads all news, marks key levels,
// writes a trading plan for tomorrow with specific stocks, entries, and reasons.
function buildOvernightPrompt(news, fiidii, sectors, upcomingEarnings, ist) {
  const allNews = news.slice(0, 30).map((n, i) =>
    `${i+1}. [${(n.category || "general").toUpperCase()}] ${n.title}\n   ${n.summary ? n.summary.slice(0, 180) : ""}\n   Source: ${n.source} | ${n.publishedAt ? n.publishedAt.slice(0, 16) : ""}`
  ).join("\n\n");

  const sectorData = (sectors.sectors || []).map(s =>
    `${s.name}: ${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)}% | ${s.strength} | Direction: ${s.direction}`
  ).join("\n");

  const fiiData = fiidii && fiidii.fii
    ? `FII Net: ₹${(fiidii.fii.netValue / 100).toFixed(0)} Cr (${fiidii.fii.sentiment})
DII Net: ₹${(fiidii.dii.netValue / 100).toFixed(0)} Cr (${fiidii.dii.sentiment})
Smart Money: ${fiidii.smartMoneySignal ? fiidii.smartMoneySignal.label : "unknown"}
3-Day FII Trend: ${fiidii.fii3DayTrend || "unknown"}`
    : "FII/DII data unavailable — reason through global flows instead";

  const earningsText = upcomingEarnings && upcomingEarnings.length > 0
    ? upcomingEarnings.slice(0, 10).map(e => `${e.symbol}: ${e.purpose} on ${e.date}`).join("\n")
    : "No earnings data available — reason from news headlines for earnings clues";

  return `You are a profitable NSE intraday trader. It is currently ${ist} IST.
The markets are CLOSED. You are doing your homework for TOMORROW's trading session.

This is exactly what a real trader does at night:
- Read every news item carefully
- Trace the causal chain from news → sector → specific stock
- Mark key price levels for tomorrow (where to buy, where to stop, where to take profit)
- Build a watchlist with a THESIS for each stock — not just "looks good", but WHY
- Think about what could go wrong (invalidation conditions)
- Have a plan ready so at 9:15am you're not deciding, you're EXECUTING

━━━ TODAY'S NEWS & MARKET DEVELOPMENTS ━━━
${allNews || "No news available — build thesis from sector trends and FII flows"}

━━━ NSE SECTOR PERFORMANCE TODAY ━━━
${sectorData || "Sector data unavailable"}
Market Breadth: ${(sectors.breadth || {}).signal || "unknown"} | Advancing: ${(sectors.breadth || {}).advancing || "?"} | Declining: ${(sectors.breadth || {}).declining || "?"}

━━━ FII / DII SMART MONEY FLOWS ━━━
${fiiData}

━━━ UPCOMING EARNINGS / BOARD MEETINGS ━━━
${earningsText}

━━━ YOUR ANALYSIS FRAMEWORK ━━━
For EVERY significant news event, trace the full causal chain. Example:
  "RBI holds rates steady → banks not squeezed on margins → HDFCBANK, ICICIBANK, AXISBANK bullish"
  "Crude oil up $2 → OMC margins squeezed → BPCL, HPCL cautious | but ONGC, OIL India bullish"
  "US Nasdaq up 1.5% → Indian IT sentiment positive → TCS, INFY gap up at open likely"
  "FII bought ₹2000 Cr yesterday → index heavyweight buying → HDFC Bank, Reliance, Infosys likely bid"

Categories to reason through:
1. GLOBAL CUES: US markets, SGX Nifty → what gap-up/gap-down is expected tomorrow?
2. CRUDE OIL: direction → upstream cos, OMCs, aviation, paints, chemicals, tyres
3. GOLD/SILVER: safe haven demand → GOLDBEES, SILVERBEES, Muthoot, Manappuram
4. CURRENCY (USD/INR): weaker rupee → IT exports benefit; import cos hurt
5. FII FLOWS: sustained buying → index heavyweights; selling → broad weakness
6. EARNINGS tomorrow: beats/misses from peers create sector contagion
7. SECTOR ROTATION: which sector FII is rotating into based on today's data
8. GEOPOLITICAL: war/sanctions → defense (HAL, BEL), commodities, energy
9. DOMESTIC MACRO: RBI, inflation, IIP, GST data → consumption vs infra theme
10. TECHNICAL SETUP: stocks near 52W high with volume are the best momentum plays

NSE UNIVERSE (use exact symbols):
- Banks: HDFCBANK, ICICIBANK, SBIN, AXISBANK, KOTAKBANK, IDFCFIRSTB, BANDHANBNK
- IT: INFY, TCS, WIPRO, HCLTECH, TECHM, LTIM, PERSISTENT, COFORGE
- Oil/Energy: ONGC, OIL, BPCL, HPCL, IOC, RELIANCE, PETRONET, GAIL
- Defense: HAL, BEL, BHEL, BEML, MIDHANI, COCHINSHIP, MAZAGON
- Auto: TATAMOTORS, M&M, MARUTI, BAJAJ-AUTO, HEROMOTOCO, EICHERMOT, TVSMOTOR
- Pharma: SUNPHARMA, DRREDDY, CIPLA, DIVISLAB, AUROPHARMA, LUPIN
- FMCG: HINDUNILVR, ITC, NESTLEIND, BRITANNIA, DABUR, GODREJCP
- Metal: TATASTEEL, JSWSTEEL, HINDALCO, COALINDIA, NMDC, VEDL
- Realty: DLF, GODREJPROP, PRESTIGE, BRIGADE, OBEROIRLTY, PHOENIXLTD
- Gold ETFs: GOLDBEES, GOLDIETF, AXISGOLD
- Silver ETFs: SILVERBEES, SILVRETF
- Index ETFs: NIFTYBEES, JUNIORBEES, BANKBEES, ITBEES
- Finance/NBFC: BAJFINANCE, CHOLAFIN, MUTHOOTFIN, MANAPPURAM, LICHSGFIN
- Chemicals: PIDILITIND, ASIANPAINT, BERGER, KANSAINER, VINATIORGA

Respond ONLY in this exact JSON (no markdown, no extra text):
{
  "analysisTimestamp": "${new Date().toISOString()}",
  "mode": "OVERNIGHT",
  "marketOutlook": {
    "bias": "BULLISH | BEARISH | SIDEWAYS",
    "confidence": 1-10,
    "oneLiner": "single punchy sentence for tomorrow",
    "summary": "3-4 sentence overnight analysis — macro + FII + global cues + sector themes",
    "openingExpectation": "GAP_UP_STRONG | GAP_UP_MILD | FLAT | GAP_DOWN_MILD | GAP_DOWN_STRONG",
    "expectedNiftyRange": "e.g. 22,400–22,650",
    "keyRisks": ["specific risk 1", "specific risk 2"],
    "keyTailwinds": ["tailwind 1", "tailwind 2"],
    "tradingStyle": "AGGRESSIVE | SELECTIVE | DEFENSIVE | AVOID",
    "firstHalfBias": "BULLISH | BEARISH | WAIT_AND_SEE",
    "secondHalfBias": "BULLISH | BEARISH | FADE_THE_MORNING"
  },
  "causalChains": [
    {
      "trigger": "exact news or data point",
      "triggerCategory": "GEOPOLITICAL | MONETARY | CRUDE | GOLD | FII | EARNINGS | CURRENCY | MACRO | SECTOR | GLOBAL_CUE",
      "chain": "full causal chain in one sentence",
      "impactedStocks": [
        {
          "symbol": "NSE_SYMBOL",
          "direction": "BUY | SELL | WATCH",
          "reason": "exactly why this stock moves",
          "magnitude": "HIGH | MEDIUM | LOW",
          "immediacy": "TOMORROW_OPEN | FIRST_HOUR | THIS_WEEK"
        }
      ],
      "urgency": "HIGH | MEDIUM | LOW",
      "confidence": 1-10
    }
  ],
  "premarketBriefing": {
    "gapScenario": "what gap to expect and why",
    "firstTrade": "the single best trade for the first 15 minutes — stock, entry, and why",
    "watchInFirstHour": "what to monitor in the first 60 min to confirm or invalidate today's thesis",
    "dontChase": "which stocks/sectors to avoid chasing even if they open strong"
  },
  "watchlist": [
    {
      "symbol": "EXACT_NSE_SYMBOL",
      "companyName": "Full Company Name",
      "sector": "sector name",
      "tradeType": "MOMENTUM | BREAKOUT | NEWS_PLAY | REVERSAL | ETF_FLOW | EARNINGS_PLAY | GAP_TRADE",
      "direction": "LONG | SHORT",
      "thesis": "One crisp sentence — WHY this stock tomorrow",
      "causalReasoning": "Full chain: news event → macro impact → sector effect → why this specific stock",
      "newsLink": "which news headline or data point triggered this",
      "catalysts": ["catalyst 1", "catalyst 2"],
      "entryZone": {
        "low": 0,
        "high": 0,
        "entryNote": "e.g. Buy breakout above ₹X on volume | Buy dip to ₹Y support"
      },
      "stopLoss": 0,
      "slNote": "why this SL level — what it represents structurally",
      "target1": 0,
      "target2": 0,
      "riskReward": "1:X",
      "confidence": 1-10,
      "timeOfDay": "OPEN_9:15 | FIRST_30MIN | FIRST_HOUR | ANYTIME | AFTERNOON",
      "holdTime": "15 mins | 30 mins | 1-2 hours | full day",
      "invalidateIf": "exact condition that kills this trade — what would make you skip it at open"
    }
  ],
  "sectorPlaybook": {
    "strongBuy": [{ "sector": "name", "reason": "why tomorrow", "etf": "ETF symbol if any" }],
    "strongSell": [{ "sector": "name", "reason": "why" }],
    "rotationTheme": "where smart money likely rotating tomorrow in 1 sentence",
    "avoidSectors": ["sector1"]
  },
  "fiiDiiPlaybook": {
    "interpretation": "2-3 sentence interpretation of today's FII/DII flows and what it signals for tomorrow",
    "followTheMoney": ["SYMBOL1", "SYMBOL2", "SYMBOL3"],
    "impliedBias": "which large-cap stocks FII likely to continue buying/selling"
  },
  "dynamicAlerts": [
    {
      "watchFor": "specific event or price level to monitor during the day",
      "ifHappens": "what it signals and what to do",
      "affectedSymbols": ["SYMBOL1"]
    }
  ]
}

RULES:
1. Use ONLY real NSE-listed symbols. No invented symbols.
2. PRICE LEVELS ARE MANDATORY — you must provide real rupee numbers for entryZone, stopLoss,
   target1, target2. Use your training knowledge of current NSE prices:
   Nifty ~22,000–24,000 | RELIANCE ~₹1,200 | HDFCBANK ~₹1,700 | INFY ~₹1,800 | TCS ~₹4,000
   SBIN ~₹800 | AXISBANK ~₹1,100 | BAJFINANCE ~₹8,500 | TATAMOTORS ~₹750 | LT ~₹3,500
   ONGC ~₹260 | HAL ~₹4,200 | BEL ~₹280 | ADANIENT ~₹2,300 | ITC ~₹440
   If news implies a stock moved significantly today, adjust accordingly.
   NEVER write 0 or null for price levels. Make your best estimate.
3. entryZone.entryNote must say exactly HOW to enter: "Buy breakout above ₹X on volume" or
   "Buy dip to support at ₹Y — wait for bounce candle confirmation".
4. Every watchlist item MUST trace back to a specific news event or data point.
5. invalidateIf must be a SPECIFIC price level or event, not a vague statement.
6. Include 8–12 watchlist stocks. Mix: 2-3 index heavyweights, 2-3 sector plays, 1-2 ETFs.
7. Think like a trader writing tomorrow's gameplan at 9pm. Specific. Decisive. Actionable.`;
}

// ─── INTRADAY prompt (original deep research — works during market hours) ─────
function buildIntradayPrompt(news, fiidii, sectors, ist) {
  const allNews = news.slice(0, 25).map((n, i) =>
    `${i+1}. [${(n.category || "general").toUpperCase()}] ${n.title}\n   ${n.summary ? n.summary.slice(0, 150) : ""}\n   Source: ${n.source} | ${n.publishedAt ? n.publishedAt.slice(0, 16) : ""}`
  ).join("\n\n");

  const sectorData = (sectors.sectors || []).map(s =>
    `${s.name}: ${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)}% | LTP: ${s.ltp} | Strength: ${s.strength}`
  ).join("\n");

  const fiiData = fiidii && fiidii.fii
    ? `FII Net: ${(fiidii.fii.netValue / 100).toFixed(0)} Cr (${fiidii.fii.sentiment})
DII Net: ${(fiidii.dii.netValue / 100).toFixed(0)} Cr (${fiidii.dii.sentiment})
Smart Money: ${fiidii.smartMoneySignal ? fiidii.smartMoneySignal.label : "unknown"}
3-Day FII Trend: ${fiidii.fii3DayTrend || "unknown"}`
    : "FII/DII data unavailable";

  return `You are a senior NSE equity research analyst. Current time: ${ist} IST (MARKET IS OPEN).

TASK: Real-time causal chain analysis → actionable NSE watchlist for TODAY's session.

For every significant news event trace the full impact:
Example: "Iran-Israel escalates → crude spikes → ONGC/OIL bullish, BPCL cautious, IndiGo bearish, GOLDBEES bid"

━━━ LIVE NEWS (last 6 hours) ━━━
${allNews || "No news — reason from sector trends and FII flows"}

━━━ NSE SECTOR PERFORMANCE ━━━
${sectorData || "Unavailable"}
Breadth: ${(sectors.breadth || {}).signal || "unknown"} | Up: ${(sectors.breadth || {}).advancing || "?"} | Down: ${(sectors.breadth || {}).declining || "?"}

━━━ FII/DII FLOWS ━━━
${fiiData}

Respond ONLY in this exact JSON:
{
  "analysisTimestamp": "${new Date().toISOString()}",
  "mode": "INTRADAY",
  "marketOutlook": {
    "bias": "BULLISH | BEARISH | SIDEWAYS",
    "confidence": 1-10,
    "oneLiner": "single punchy sentence for today",
    "summary": "3-4 sentence detailed outlook",
    "openingExpectation": "GAP_UP_STRONG | GAP_UP_MILD | FLAT | GAP_DOWN_MILD | GAP_DOWN_STRONG",
    "keyRisks": ["risk 1", "risk 2"],
    "keyTailwinds": ["tailwind 1", "tailwind 2"],
    "tradingStyle": "AGGRESSIVE | SELECTIVE | DEFENSIVE | AVOID"
  },
  "causalChains": [
    {
      "trigger": "exact news or data point",
      "triggerCategory": "GEOPOLITICAL | MONETARY | CRUDE | GOLD | FII | EARNINGS | CURRENCY | MACRO | SECTOR",
      "chain": "full causal chain in one sentence",
      "impactedStocks": [
        {
          "symbol": "NSE_SYMBOL",
          "direction": "BUY | SELL | WATCH",
          "reason": "exactly why",
          "magnitude": "HIGH | MEDIUM | LOW",
          "immediacy": "TOMORROW_OPEN | THIS_WEEK | ONGOING"
        }
      ],
      "urgency": "HIGH | MEDIUM | LOW",
      "confidence": 1-10
    }
  ],
  "watchlist": [
    {
      "symbol": "EXACT_NSE_SYMBOL",
      "companyName": "Full Company Name",
      "sector": "sector",
      "tradeType": "MOMENTUM | BREAKOUT | NEWS_PLAY | REVERSAL | ETF_FLOW",
      "direction": "LONG | SHORT",
      "thesis": "one sentence why",
      "causalReasoning": "full chain from news to this stock",
      "newsLink": "which headline",
      "catalysts": ["catalyst 1"],
      "entryZone": { "low": 0, "high": 0, "entryNote": "entry strategy" },
      "stopLoss": 0,
      "target1": 0,
      "target2": 0,
      "riskReward": "1:X",
      "confidence": 1-10,
      "timeOfDay": "OPEN_9:15 | FIRST_30MIN | FIRST_HOUR | ANYTIME | AFTERNOON",
      "holdTime": "15 mins | 30 mins | 1-2 hours | full day",
      "invalidateIf": "what kills this trade"
    }
  ],
  "sectorPlaybook": {
    "strongBuy": [{ "sector": "name", "reason": "why", "etf": "ETF or null" }],
    "strongSell": [{ "sector": "name", "reason": "why" }],
    "rotationTheme": "where smart money moving today",
    "avoidSectors": ["sector"]
  },
  "fiiDiiPlaybook": {
    "interpretation": "2-3 sentences on FII/DII and what it means",
    "followTheMoney": ["SYMBOL1", "SYMBOL2"],
    "impliedBias": "which stocks FII likely buying/selling"
  },
  "dynamicAlerts": [
    {
      "watchFor": "specific level or event to watch",
      "ifHappens": "what to do",
      "affectedSymbols": ["SYMBOL"]
    }
  ]
}

RULES:
1. Only real NSE symbols. 8–12 watchlist stocks minimum.
2. Every stock must trace back to a specific news event or data point.
3. invalidateIf is critical — define when to exit before SL.`;
}

// ─── QUICK UPDATE prompt (5-min incremental, cheap) ──────────────────────────
function buildQuickUpdatePrompt(newArticles, existingWatchlist) {
  const newsText = newArticles.slice(0, 8).map(n =>
    `[${(n.category || "general").toUpperCase()}] ${n.title} — ${n.summary ? n.summary.slice(0, 100) : ""}`
  ).join("\n");

  const existingSymbols = (existingWatchlist || []).map(w => w.symbol).join(", ");

  return `You are an NSE intraday trader. New news just broke in the last 5 minutes.

NEW HEADLINES:
${newsText}

CURRENT WATCHLIST: ${existingSymbols || "none yet"}

TASK: Based ONLY on this new news, identify urgent changes. Respond in valid JSON:
{
  "hasSignificantChange": true | false,
  "urgentAlerts": [
    {
      "headline": "the news",
      "impactedSymbols": ["SYMBOL1", "SYMBOL2"],
      "direction": "BUY | SELL",
      "reason": "1-line reason with causal chain",
      "urgency": "HIGH | MEDIUM"
    }
  ],
  "addToWatchlist": [
    {
      "symbol": "NSE_SYMBOL",
      "thesis": "one sentence why",
      "newsLink": "which headline",
      "causalReasoning": "full chain from news to this stock move",
      "tradeType": "NEWS_PLAY",
      "entryZone": { "low": 0, "high": 0 },
      "stopLoss": 0,
      "target1": 0,
      "confidence": 1-10,
      "invalidateIf": "what kills this trade"
    }
  ],
  "removeFromWatchlist": ["SYMBOL_NOW_INVALID"],
  "marketBiasChange": null | "now more BULLISH" | "now more BEARISH"
}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function generateResearch(news, fiidii, sectors, upcomingEarnings) {
  const now   = Date.now();
  const phase = getMarketPhase();
  const ist   = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const isOvernight = (phase === "OVERNIGHT" || phase === "PRE_MARKET");

  // Determine which TTL applies
  const deepTTL = isOvernight ? DEEP_OVERNIGHT_TTL_MS : DEEP_INTRADAY_TTL_MS;

  // Decide if we need a fresh deep report
  const needsRefresh = !cache.deepReport
    || (now - cache.deepAt >= deepTTL)
    || (cache.lastMode !== (isOvernight ? "OVERNIGHT" : "INTRADAY")); // mode changed (market opened/closed)

  if (needsRefresh) {
    const mode = isOvernight ? "OVERNIGHT" : "INTRADAY";
    console.log("[aiResearcher] Running " + mode + " deep analysis at " + ist);

    try {
      const prompt = isOvernight
        ? buildOvernightPrompt(news, fiidii, sectors, upcomingEarnings || [], ist)
        : buildIntradayPrompt(news, fiidii, sectors, ist);

      const raw    = await callAI(prompt, 4000);
      const clean  = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

      cache.deepReport = parsed;
      cache.deepAt     = now;
      cache.lastMode   = mode;

      console.log(
        "[aiResearcher] " + mode + " done: bias=" + ((parsed.marketOutlook || {}).bias || "?") +
        " watchlist=" + (parsed.watchlist || []).length +
        " chains=" + (parsed.causalChains || []).length
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

  // Quick incremental update (only during intraday, only when new news exists)
  if (!isOvernight && news.length > 0 && now - cache.quickAt >= QUICK_TTL_MS) {
    const recentNews = news.filter(n => {
      const age = now - new Date(n.publishedAt || 0).getTime();
      return age < 10 * 60 * 1000;
    });

    if (recentNews.length > 0 && cache.deepReport) {
      console.log("[aiResearcher] Quick update: " + recentNews.length + " new articles");
      try {
        const prompt  = buildQuickUpdatePrompt(recentNews, cache.deepReport.watchlist);
        const raw     = await callAI(prompt, 1000);
        const clean   = raw.replace(/```json|```/g, "").trim();
        const update  = JSON.parse(clean);

        cache.quickAt = now;

        if (update.hasSignificantChange) {
          console.log("[aiResearcher] Significant change — " + (update.urgentAlerts || []).length + " alerts");

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

          if (update.marketBiasChange) {
            cache.deepReport.marketOutlook = cache.deepReport.marketOutlook || {};
            cache.deepReport.marketOutlook.quickBiasUpdate = update.marketBiasChange;
          }
        }
      } catch (e) {
        console.error("[aiResearcher] Quick update error:", e.message);
      }
    }
  }

  return cache.deepReport;
}

module.exports = { generateResearch, getMarketPhase };
