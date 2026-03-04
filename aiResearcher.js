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

const DEEP_INTRADAY_TTL_MS  = 14 * 60 * 1000;  // 14 min — always fresh for 15-min cycle
const DEEP_OVERNIGHT_TTL_MS = 58 * 60 * 1000;  // 58 min — always fresh for 60-min cycle
const QUICK_TTL_MS          = 14 * 60 * 1000;  // quick updates also 14 min

// Per-provider rate limit backoff timestamps
const providerBackoff = { gemini: 0, openai: 0, anthropic: 0 };

// Try providers in order: Gemini (free/generous) → OpenAI → Anthropic
// If one hits 429, automatically falls through to the next
async function callAI(prompt, maxTokens = 4000) {
  const now = Date.now();

  // Build ordered list of available providers, skipping ones in backoff
  const providers = [];
  if (process.env.GEMINI_API_KEY    && now > providerBackoff.gemini)    providers.push("gemini");
  if (process.env.OPENAI_API_KEY    && now > providerBackoff.openai)    providers.push("openai");
  if (process.env.ANTHROPIC_API_KEY && now > providerBackoff.anthropic) providers.push("anthropic");

  if (providers.length === 0) {
    // All providers in backoff — report when earliest one recovers
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
        const backoffMs = 25 * 60 * 1000; // 25 min backoff per provider
        providerBackoff[provider] = Date.now() + backoffMs;
        console.warn("[AI] " + provider + " rate limited ("+status+") — backing off 25min, trying next provider");
      } else {
        console.warn("[AI] " + provider + " failed (" + (status||err.message) + ") — trying next provider");
      }
    }
  }
  throw lastErr || new Error("All AI providers failed");
}

async function callProvider(provider, prompt, maxTokens) {
  if (provider === "gemini") {
    // Use gemini-1.5-flash (fastest, most generous free quota)
    const model = "gemini-2.0-flash";
    const r = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + process.env.GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: "You are a senior NSE equity research analyst and profitable intraday trader. Respond ONLY in valid JSON, no markdown fences, no extra text.\n\n" + prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens }
      },
      { headers: { "Content-Type": "application/json" }, timeout: 90000 }
    );
    const text = r.data.candidates[0].content.parts[0].text;
    return text;
  }

  if (provider === "openai") {
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini", max_tokens: maxTokens, temperature: 0.3,
      messages: [
        { role: "system", content: "You are a senior NSE equity research analyst and profitable intraday trader. Respond ONLY in valid JSON, no markdown fences, no extra text." },
        { role: "user",   content: prompt }
      ]
    }, {
      headers: { "Authorization": "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      timeout: 90000
    });
    return r.data.choices[0].message.content;
  }

  if (provider === "anthropic") {
    const r = await axios.post("https://api.anthropic.com/v1/messages", {
      model:      "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }]
    }, {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      timeout: 90000
    });
    return r.data.content[0].text;
  }

  throw new Error("Unknown provider: " + provider);
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
  const allNews = news.slice(0, 50).map((n, i) =>
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
You are combining the research depth of Renaissance Technologies, Goldman Sachs, and Bridgewater.
For every stock you pick, run through ALL of these lenses:

LENS 1 — CAUSAL CHAIN (news → stock):
  "RBI holds rates → banks not squeezed → HDFCBANK, ICICIBANK bullish"
  "Crude up $2 → OMC margins squeezed → BPCL/HPCL cautious, ONGC/OIL bullish"
  "US Nasdaq +1.5% → Indian IT gap-up → TCS, INFY, HCLTECH bid at open"
  "FII bought ₹2000Cr → index heavyweights bid → RELIANCE, HDFCBANK, INFY"
  "Defense order announced → HAL, BEL, MAZAGON, COCHINSHIP spike"

LENS 2 — STATISTICAL EDGE (Renaissance-style):
  - Day-of-week patterns: Mondays often weak, Fridays see short-covering rallies
  - Sector rotation: which sectors outperform in current macro cycle?
  - Pre-earnings run: stocks often run 3-5% in week before results
  - Post-result contagion: sector peer moves after one company reports

LENS 3 — COMPETITIVE & SECTOR ANALYSIS (Bain/McKinsey-style):
  - Which company in the sector has best margins and moat?
  - Is this a sector rotation moment (FII moving from IT to PSU, or defensive to cyclical)?
  - Who benefits most from today's macro data (IIP, PMI, CPI, GST collections)?

LENS 4 — MACRO IMPACT (Bridgewater-style):
  - Interest rate environment → growth vs value rotation
  - INR/USD direction → IT exporters vs import-heavy cos
  - Global risk-off → safe havens (GOLDBEES, SILVERBEES, pharma, FMCG)
  - Global risk-on → cyclicals (metal, infra, auto, realty)
  - RBI policy → banking margins, NBFC liquidity, housing demand

LENS 5 — TECHNICAL SETUP (Citadel-style):
  - Stocks near 52W high with volume = best momentum plays
  - Gap-up stocks that held gap = continuation signal
  - Stocks with high delivery% = institutional accumulation
  - PCR > 1.2 = put writers confident = bullish
  - VIX > 17 (current) = elevated fear = prefer defensive or wait for dip entries

LENS 6 — EARNINGS CATALYST (JPMorgan-style):
  - Which stocks report results this week? Pre-earnings run opportunity?
  - Recent beats/misses in sector → contagion to peers?
  - Management guidance from last call — any upgrade/downgrade potential?

CATEGORIES TO SCAN:
1. GLOBAL CUES: US/Asia markets, SGX Nifty → gap direction
2. CRUDE OIL: upstream (ONGC,OIL), OMCs (BPCL,HPCL), aviation (INDIGO), paints (ASIANPAINT)
3. GOLD/SILVER: GOLDBEES, SILVERBEES, MUTHOOTFIN, MANAPPURAM
4. CURRENCY: INR weak → IT exports (INFY,TCS,WIPRO); INR strong → import cos hurt
5. FII/DII FLOWS: follow institutional money → which sectors they're accumulating
6. EARNINGS: pre-run trades, post-result peer contagion
7. SECTOR ROTATION: metal today → which metal stock specifically?
8. GEOPOLITICAL: defense orders → HAL,BEL,BHEL,COCHINSHIP,MAZAGON
9. PSU/GOVT SPEND: infra budget → L&T,NCC,RVNL,IRCON; PSU banks → SBIN,PNB,BANKBARODA
10. TECHNICAL BREAKOUTS: 52W high approaching + volume surge = highest conviction plays

COMPLETE NSE TRADEABLE UNIVERSE — scan ALL sectors, not just index heavyweights:

BANKS & FINANCE: HDFCBANK, ICICIBANK, SBIN, AXISBANK, KOTAKBANK, IDFCFIRSTB, BANDHANBNK, PNB, BANKBARODA, CANBK, UNIONBANK, AUBANK, FEDERALBNK, RBLBANK, KARURVYSYA, BAJFINANCE, BAJAJFINSV, CHOLAFIN, MUTHOOTFIN, MANAPPURAM, SHRIRAMFIN, LICHSGFIN, RECLTD, PFC, IRFC, M&MFIN, HDFCAMC, ICICIGI, ICICIPRULI, SBILIFE, HDFCLIFE, LICI

IT & TECH: INFY, TCS, WIPRO, HCLTECH, TECHM, LTIM, PERSISTENT, COFORGE, MPHASIS, LTTS, OFSS, KPITTECH, TATAELXSI, ZENSARTECH, CYIENT, NEWGEN, MASTEK, BSOFT, RATEGAIN, DIXON, KAYNES, SYRMA

OIL & ENERGY: ONGC, OIL, BPCL, HPCL, IOC, RELIANCE, PETRONET, GAIL, MGL, IGL, GUJGASLTD, ADANIGREEN, ADANIPOWER, TATAPOWER, TORNTPOWER, NTPC, POWERGRID, NHPC, JSWENERGY, SUZLON, SJVN, IREDA, NLCINDIA, CESC

DEFENSE & RAILWAYS: HAL, BEL, BHEL, BEML, MIDHANI, COCHINSHIP, MAZAGON, GRSE, DATAPATTNS, IRCTC, RVNL, IRCON, RITES, TITAGARH, RAILTEL, IRFC

AUTO & EV: TATAMOTORS, M&M, MARUTI, BAJAJ-AUTO, HEROMOTOCO, EICHERMOT, TVSMOTOR, ASHOKLEY, ESCORTS, MRF, CEATLTD, APOLLOTYRE, MOTHERSON, BALKRISIND, TIINDIA, EXIDEIND, AMARAJABAT

PHARMA & HEALTHCARE: SUNPHARMA, DRREDDY, CIPLA, DIVISLAB, AUROPHARMA, LUPIN, BIOCON, GLENMARK, TORNTPHARM, ALKEM, IPCALAB, LAURUSLABS, GRANULES, ZYDUSLIFE, AJANTPHARM, NATCOPHARM

FMCG & RETAIL: HINDUNILVR, ITC, NESTLEIND, BRITANNIA, DABUR, GODREJCP, MARICO, COLPAL, EMAMILTD, TATACONSUM, VBL, RADICO, MCDOWELL-N, TRENT, DMART, ABFRL, BATA, PAGEIND

METAL & MINING: TATASTEEL, JSWSTEEL, HINDALCO, COALINDIA, NMDC, VEDL, HINDZINC, NATIONALUM, SAIL, MOIL, WELCORP, APLAPOLLO, RATNAMANI, JSWHL

INFRA & REALTY: LT, ADANIPORTS, DLF, GODREJPROP, PRESTIGE, BRIGADE, OBEROIRLTY, PHOENIXLTD, SOBHA, LODHA, NCC, HCC, KNRCON, PNCINFRA, GMRINFRA, CONCOR, IRB

CHEMICALS & PAINTS: PIDILITIND, ASIANPAINT, BERGER, KANSAINER, VINATIORGA, DEEPAKNTR, ATUL, NAVINFLUOR, TATACHEM, GNFC, COROMANDEL, CHAMBLFERT, PIIND, AAVAS

CAPITAL GOODS & INDUSTRIALS: SIEMENS, ABB, CUMMINSIND, THERMAX, CGPOWER, BHEL, HAVELLS, POLYCAB, CROMPTON, AMBER, VOLTAS, BOSCH, SKFINDIA

TELECOM & MEDIA: BHARTIARTL, IDEA, TATACOMM, HFCL, RAILTEL, ZEEL, SUNTV, PVRINOX, NYKAA

ETFs (use for sector/macro plays): NIFTYBEES, BANKBEES, ITBEES, JUNIORBEES, GOLDBEES, SILVERBEES, PSUBNKBEES, INFRABEES, PHARMABEES, MAFANG, ICICIB22

IMPORTANT: Do NOT default to only HDFC/ICICI/Reliance/TCS. 
- If defense news → recommend HAL, BEL, MAZAGON, COCHINSHIP specifically
- If PSU news → recommend ONGC, COALINDIA, SAIL, NMDC, RECLTD, PFC
- If railway budget → RVNL, IRCON, TITAGARH, RAILTEL
- If pharma results → specific pharma stock from news
- If IT deal win → that specific IT company
- Look at sector performance: Metal +0.24% today → which metal stocks specifically moved?
- The best trades are SPECIFIC catalyst-driven moves, not generic index plays

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

CRITICAL RULES — MUST FOLLOW:
1. REAL NSE SYMBOLS ONLY. No invented symbols.

2. PRICE LEVELS ARE MANDATORY. Use your knowledge of approximate current NSE prices:
   Nifty ~22,500 | RELIANCE ~₹1,250 | HDFCBANK ~₹1,720 | INFY ~₹1,850 | TCS ~₹3,900
   SBIN ~₹780 | AXISBANK ~₹1,080 | BAJFINANCE ~₹8,800 | TATAMOTORS ~₹720 | LT ~₹3,600
   ONGC ~₹265 | HAL ~₹4,300 | BEL ~₹285 | ADANIENT ~₹2,350 | ITC ~₹440 | NTPC ~₹340
   COALINDIA ~₹420 | TATASTEEL ~₹145 | JSWSTEEL ~₹1,000 | SUNPHARMA ~₹1,750 | DRREDDY ~₹1,200
   BHARTIARTL ~₹1,700 | DLF ~₹830 | SIEMENS ~₹6,200 | CGPOWER ~₹650 | PVRINOX ~₹1,450
   NEVER write 0 or null. Make your best estimate based on news context.

3. MANDATORY DIVERSITY — your watchlist MUST span at least 5 different sectors.
   If today's top sectors were Metal +0.24% and Pharma +0.02% → metal and pharma stocks FIRST.
   If defense news → HAL/BEL/MAZAGON. If PSU order → BHEL/NCC/L&T. Be sector-specific.

4. 12-15 WATCHLIST STOCKS MINIMUM. Not just Nifty 50 index heavyweights.
   Include: 2-3 large caps, 3-4 mid caps with catalysts, 1-2 ETFs, 1-2 PSU plays if relevant.

5. EVERY stock must have a SPECIFIC news/data reason. "Looks bullish" is not acceptable.
   Tie every pick to: a news headline, earnings event, sector move, FII flow, or technical breakout.

6. invalidateIf must be a PRICE LEVEL or EVENT: "If ONGC opens below ₹260" not "if market falls".

7. Think: which stocks had volume today? Which had news? Which sector rotated in?
   Those are your best overnight plays — not the same old HDFC/ICICI every day.`;
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

module.exports = { generateResearch, getMarketPhase, providerBackoff };
