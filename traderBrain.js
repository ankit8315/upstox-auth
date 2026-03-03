// traderBrain.js — The AI's actual trading intelligence
// Thinks like a profitable intraday trader with 10 years NSE experience
// Every 5 min during market hours: re-evaluates ALL positions + ideas
// Produces: exact entry price, exact SL, exact targets, quantity, P&L projection
// Capital: ₹1,00,000 | Risk per trade: ₹500 | Max 3 concurrent positions
//
// FIX: tradeCallsCache.calls was initialised as [] (array) but the result object
//      is { calls:[], traderMindset, ... }. The cache-hit check
//      `tradeCallsCache.calls.length > 0` always failed because .calls on an
//      array is undefined. Fixed by initialising cache correctly and normalising
//      the empty-result path to always return an object, never a bare [].

const axios = require("axios");

// ── Constants matching riskEngine ────────────────────────────────────────────
const CAPITAL         = 100000;
const RISK_PER_TRADE  = 500;
const MAX_POSITIONS   = 3;
const MAX_DAILY_LOSS  = 3000; // 3% of capital — hard stop for the day

// ── Cache ─────────────────────────────────────────────────────────────────────
// BUG FIX: was { calls: [], generatedAt: 0 } — .calls here was the result
// object slot, not an array, so .calls.length always threw / returned undefined.
let tradeCallsCache    = { result: null, generatedAt: 0 };
let thesisCheckCache   = { updates: null, checkedAt: 0 };
const CALL_TTL_MS      = 5 * 60 * 1000;
const THESIS_TTL_MS    = 5 * 60 * 1000;

// Empty result object — returned instead of [] so callers always get .calls
const EMPTY_RESULT = { calls: [], traderMindset: "", marketRead: {}, capitalPlan: {}, skipList: [], checklist: [] };

function getProvider() {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GEMINI_API_KEY)    return "gemini";
  return null;
}

async function callAI(prompt, maxTokens = 3000) {
  const provider = getProvider();
  if (!provider) throw new Error("No AI key");

  if (provider === "anthropic") {
    const r = await axios.post("https://api.anthropic.com/v1/messages", {
      model:      "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }]
    }, {
      headers: {
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json"
      },
      timeout: 45000
    });
    return r.data.content[0].text;
  }

  if (provider === "openai") {
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model:      "gpt-4o",
      max_tokens: maxTokens,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are a profitable NSE intraday trader. Respond ONLY in valid JSON." },
        { role: "user",   content: prompt }
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
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens }
      },
      { headers: { "Content-Type": "application/json" }, timeout: 45000 }
    );
    return r.data.candidates[0].content.parts[0].text;
  }
}

// ── Core position sizing (exact maths) ───────────────────────────────────────
function calcPosition(entryPrice, stopLoss, capital, openPositions) {
  const riskPerShare  = Math.abs(entryPrice - stopLoss);
  if (riskPerShare <= 0) return null;

  const quantity      = Math.floor(RISK_PER_TRADE / riskPerShare);
  if (quantity <= 0)  return null;

  const totalCost     = quantity * entryPrice;
  const maxCapPerTrade= capital * 0.30; // max 30% in one stock

  const finalQty      = totalCost > maxCapPerTrade
    ? Math.floor(maxCapPerTrade / entryPrice)
    : quantity;

  const deployed      = finalQty * entryPrice;
  const actualRisk    = finalQty * riskPerShare;
  const remainingCap  = capital - (openPositions * (capital * 0.25));
  const canTrade      = openPositions < MAX_POSITIONS && deployed <= remainingCap;

  return {
    quantity:    finalQty,
    deployed:    parseFloat(deployed.toFixed(2)),
    actualRisk:  parseFloat(actualRisk.toFixed(2)),
    canTrade,
    cantReason:  !canTrade
      ? (openPositions >= MAX_POSITIONS ? "Max 3 positions open" : "Insufficient capital")
      : null
  };
}

// ── BUILD PROMPT: generate fresh trade calls ──────────────────────────────────
function buildTradeCallPrompt(enrichedStocks, marketContext, openPositions, todayPnL, currentTime) {
  const ist         = currentTime || new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const openCount   = openPositions ? openPositions.length : 0;
  const remainCap   = CAPITAL - openCount * 25000; // approx remaining
  const dailyLossLeft = MAX_DAILY_LOSS + todayPnL; // if pnl is -1000, only 2000 more loss allowed

  // Format open positions
  const openPosText = openPositions && openPositions.length > 0
    ? openPositions.map(p =>
        p.symbol + " @₹" + p.entry + " | SL:₹" + p.stopLoss + " | T1:₹" + p.target1 +
        " | Qty:" + p.quantity + " | Status:" + (p.target1Hit ? "T1 HIT - trail SL" : "open")
      ).join("\n")
    : "None";

  // Format top watchlist stocks with all live data
  const stocksText = enrichedStocks.slice(0, 12).map((s, i) => {
    const ld = s.liveData || {};
    const vd = s.volumeData || {};
    const od = s.oiData || {};
    const dd = s.deliveryData || {};
    return `
${i+1}. ${s.symbol} [Conviction: ${s.conviction}/100 | ${s.trafficLight}]
   LTP: ₹${ld.ltp || "?"} | Change: ${ld.changePct >= 0 ? "+" : ""}${(ld.changePct || 0).toFixed(2)}%
   VWAP: ₹${ld.vwap || "?"} | Position: ${ld.aboveVWAP ? "ABOVE" : "BELOW"} VWAP (${(ld.vwapDiffPct || 0).toFixed(1)}%)
   Volume: ${vd.volumeLabel || "?"} avg | Today vol: ${(ld.volumeLakh || 0).toFixed(1)}L
   52W: High ₹${ld.high52 || "?"} Low ₹${ld.low52 || "?"} | Position in range: ${(ld.pos52wPct || 0).toFixed(0)}%
   Day: High ₹${ld.dayHigh || "?"} Low ₹${ld.dayLow || "?"}
   Support: S1=₹${(ld.support || {}).s1 || "?"} S2=₹${(ld.support || {}).s2 || "?"}
   Resistance: R1=₹${(ld.resistance || {}).r1 || "?"} R2=₹${(ld.resistance || {}).r2 || "?"}
   Delivery: ${(dd.deliveryPct || 0).toFixed(1)}% (${dd.deliverySpike ? "SPIKE" : "normal"}) | PCR: ${(od.pcr || 0).toFixed(2)} (${od.pcrSignal || "?"})
   Gap: ${(ld.gapPct || 0).toFixed(2)}% | Signals: ${(s.signals || []).map(sg => sg.label).join(", ") || "none"}
   AI Thesis: ${s.thesis || ""}
   Causal chain: ${s.causalReasoning || ""}`;
  }).join("\n");

  const niftyText = marketContext
    ? `Nifty: ₹${marketContext.niftyLTP} (${marketContext.niftyChange >= 0 ? "+" : ""}${(marketContext.niftyChange || 0).toFixed(2)}%) | Trend: ${marketContext.niftyTrend}`
    : "Nifty: data unavailable";

  return `You are a profitable NSE intraday trader with 10 years experience. You manage ₹1,00,000 capital.

CURRENT TIME: ${ist}
CAPITAL STATUS:
- Total capital: ₹1,00,000
- Risk per trade: ₹500 (fixed)
- Max positions: 3
- Open positions: ${openCount}/3
- Today P&L: ₹${todayPnL >= 0 ? "+" : ""}${todayPnL}
- Daily loss limit remaining: ₹${dailyLossLeft}
- Approximate capital available: ₹${remainCap}

OPEN POSITIONS:
${openPosText}

MARKET CONTEXT:
${niftyText}
Market outlook: ${(marketContext || {}).bias || "unknown"}
Opening expectation: ${(marketContext || {}).openingExpectation || "unknown"}

CANDIDATE STOCKS WITH FULL DATA:
${stocksText}

YOUR TASK AS A TRADER:
Study every stock above like you would on your trading terminal.
For each viable trade, think through:

1. ENTRY TIMING — which of these applies?
   - First 15-min candle breakout: stock breaking above first 15-min high with volume
   - VWAP reclaim: price just crossed above VWAP, momentum building
   - Support bounce: price hit S1/S2, bounced with volume confirmation
   - Momentum entry: volume 3x+ mid-move, price accelerating
   - News catalyst: direct news play, enter within first 5 min of breakout

2. EXACT LEVELS — not ranges, exact numbers:
   - Entry: the exact price to place limit/market order
   - Stop loss: below the structure (not arbitrary %), e.g. below day low, below VWAP, below S1
   - Target 1: first logical resistance (50-60% of move)
   - Target 2: full target if thesis plays out perfectly
   - Trail SL after T1 hit: move SL to entry (risk-free trade)

3. POSITION MATH (I will verify this):
   - Qty = floor(500 / (entry - stopLoss))
   - Deployed = qty × entry
   - Must fit in ₹30,000 max per stock

4. DISCARD if any of these are true:
   - Stock is already up 3%+ today without a pullback (chasing)
   - Volume is below average (no confirmation)
   - Nifty is in strong downtrend and stock has no independent catalyst
   - Stop loss would be more than ₹500 risk (even with qty=1)
   - Daily loss limit already hit

5. URGENCY — when exactly to enter:
   - NOW: stock is at entry level right this moment
   - ON_BREAKOUT: wait for price to cross X level
   - ON_PULLBACK: wait for dip to Y level before entering
   - AVOID_TODAY: skip for today, explain why

Respond ONLY in this exact JSON (no markdown, no extra text):
{
  "timestamp": "${new Date().toISOString()}",
  "traderMindset": "1 sentence on what kind of day this is and how you're approaching it",
  "marketRead": {
    "niftyBias":      "BULL | BEAR | SIDEWAYS",
    "sessionPhase":   "OPENING | MID_MORNING | AFTERNOON | CLOSING",
    "tradingAdvice":  "1 line — be aggressive / be selective / sit on hands today",
    "avoidIf":        "condition that would make you stop trading entirely today"
  },
  "tradeCalls": [
    {
      "rank":          1,
      "symbol":        "EXACT_NSE_SYMBOL",
      "action":        "BUY | SHORT",
      "urgency":       "NOW | ON_BREAKOUT | ON_PULLBACK | AVOID_TODAY",
      "grade":         "A+ | A | B",

      "entryType":     "FIRST_15MIN_BREAKOUT | VWAP_RECLAIM | SUPPORT_BOUNCE | MOMENTUM | NEWS_CATALYST",
      "entryPrice":    123.45,
      "entryNote":     "e.g. Buy above ₹58.50 only if volume > 5L in first candle",

      "stopLoss":      120.00,
      "slNote":        "e.g. Below today's day low ₹119.80 — if this breaks, thesis is dead",

      "target1":       128.00,
      "target2":       133.00,
      "t1Note":        "e.g. Previous day high / gap fill / R1 level",
      "t2Note":        "e.g. 52W high area — only if market stays bullish",

      "trailSlAfterT1": 123.45,
      "trailNote":      "After T1, move SL to entry ₹123.45 — now risk-free",

      "quantity":       10,
      "deployed":       1234.50,
      "riskAmount":     50.00,
      "rewardT1":       45.00,
      "rewardT2":       95.00,
      "rrRatio":        "1:2.8",

      "holdTime":      "15-30 min | 30-60 min | 1-2 hours | full day",
      "exitBy":        "12:30 PM | 2:00 PM | 3:00 PM",

      "whyNow":        "3-4 sentence reasoning — what specific data made you pick this stock at this moment",
      "newsLink":      "which news event is driving this",
      "thesis":        "if X happens this stock does Y because Z",
      "invalidateIf":  "exact condition that kills this trade — exit immediately if this happens",

      "confidence":    85,
      "risks":         ["risk 1", "risk 2"]
    }
  ],
  "capitalPlan": {
    "tradesPlanned":    3,
    "totalDeployed":    50000,
    "totalRisk":        1500,
    "bestCaseProfit":   4500,
    "worstCaseLoss":    1500,
    "adviceIfAllHit":  "what to do if all 3 targets hit before noon",
    "adviceIfAllStop": "what to do if all 3 stop losses hit"
  },
  "skipList": [
    {
      "symbol":  "SYMBOL",
      "reason":  "why skipping today specifically"
    }
  ],
  "intraday5MinChecklist": [
    "What to check every 5 min during trading — specific things to watch"
  ]
}

CRITICAL RULES:
1. Quantity MUST use formula: floor(500 / (entryPrice - stopLoss)). Show real math.
2. Deployed MUST equal quantity × entryPrice.
3. Risk MUST equal quantity × (entryPrice - stopLoss) ≤ ₹500.
4. Only recommend stocks where you genuinely see an edge RIGHT NOW.
5. If market is bad, say 0 trade calls and explain why in traderMindset.
6. Grade A+ = take immediately. A = take if setup confirms. B = optional.
7. Be a trader, not an analyst. Specific. Decisive. No vague advice.`;
}

// ── BUILD PROMPT: 5-min thesis re-evaluation ─────────────────────────────────
function buildThesisCheckPrompt(openTradeCalls, currentPrices, marketContext, currentTime) {
  const ist = currentTime || new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  const callsText = openTradeCalls.map(tc => {
    const curPrice = currentPrices[tc.symbol] || tc.entryPrice;
    const pnlPct   = tc.entryPrice > 0
      ? ((curPrice - tc.entryPrice) / tc.entryPrice * 100).toFixed(2)
      : "0";
    const pnlRs    = tc.quantity
      ? ((curPrice - tc.entryPrice) * tc.quantity).toFixed(0)
      : "0";

    return `
${tc.symbol}:
  Entry: ₹${tc.entryPrice} | Current: ₹${curPrice} | P&L: ₹${pnlRs} (${pnlPct}%)
  SL: ₹${tc.stopLoss} | T1: ₹${tc.target1} | T2: ₹${tc.target2}
  Thesis: ${tc.thesis}
  Invalidate if: ${tc.invalidateIf}
  Entry type: ${tc.entryType}
  Entered: ${tc.enteredAt || "pending"}`;
  }).join("\n");

  const niftyText = marketContext
    ? `Nifty: ₹${marketContext.niftyLTP} (${marketContext.niftyChange >= 0 ? "+" : ""}${(marketContext.niftyChange || 0).toFixed(2)}%)`
    : "Nifty: unavailable";

  return `You are a profitable NSE intraday trader doing your 5-minute trade review.
TIME: ${ist}
${niftyText}

ACTIVE TRADE CALLS TO REVIEW:
${callsText}

For each trade call, check:
1. Is the thesis STILL VALID? (price action, volume, Nifty direction)
2. Has the stock hit any key level? (SL, T1, T2, trail point)
3. Should entry be adjusted? (stock pulled back to better entry)
4. Should the trade be abandoned even before SL? (thesis broken)

Respond ONLY in valid JSON:
{
  "timestamp": "${new Date().toISOString()}",
  "reviews": [
    {
      "symbol":      "SYMBOL",
      "status":      "ON_TRACK | CAUTION | EXIT_NOW | ADJUST_ENTRY | T1_HIT | T2_HIT",
      "currentPnL":  0,
      "action":      "HOLD | TIGHTEN_SL | EXIT | TRAIL_SL | WAIT_FOR_ENTRY",
      "message":     "what is happening right now with this trade in plain English",
      "newSL":       null,
      "newEntry":    null,
      "urgency":     "HIGH | MEDIUM | LOW"
    }
  ],
  "marketUpdate": "1 sentence on what Nifty/market is doing right now",
  "sessionAdvice": "any change in overall approach for rest of day"
}`;
}

// ── Main functions ────────────────────────────────────────────────────────────

async function generateTradeCalls(enrichedStocks, marketContext, openPositions, todayPnL) {
  const now = Date.now();

  // BUG FIX: cache hit check now checks tradeCallsCache.result (an object) not
  // tradeCallsCache.calls (which was undefined, so .length always threw/was falsy)
  const cached = tradeCallsCache.result;
  if (cached && cached.calls && cached.calls.length > 0 && now - tradeCallsCache.generatedAt < CALL_TTL_MS) {
    console.log("[TraderBrain] Returning cached calls (" + cached.calls.length + ")");
    return cached;
  }

  if (!enrichedStocks || enrichedStocks.length === 0) {
    console.warn("[TraderBrain] No enriched stocks — skipping");
    return EMPTY_RESULT;
  }

  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log("[TraderBrain] Generating trade calls at " + ist);

  try {
    const prompt  = buildTradeCallPrompt(enrichedStocks, marketContext, openPositions, todayPnL || 0, ist);
    const raw     = await callAI(prompt, 4000);
    const clean   = raw.replace(/```json|```/g, "").trim();
    const parsed  = JSON.parse(clean);

    // Verify and fix position math for each call
    const verified = (parsed.tradeCalls || []).map(tc => {
      const slDist = Math.abs(tc.entryPrice - tc.stopLoss);
      if (slDist <= 0) return tc;
      const correctQty      = Math.floor(RISK_PER_TRADE / slDist);
      const correctDeployed = parseFloat((correctQty * tc.entryPrice).toFixed(2));
      const correctRisk     = parseFloat((correctQty * slDist).toFixed(2));
      const t1Reward        = parseFloat((correctQty * Math.abs(tc.target1 - tc.entryPrice)).toFixed(2));
      const t2Reward        = parseFloat((correctQty * Math.abs(tc.target2 - tc.entryPrice)).toFixed(2));
      const rr              = correctRisk > 0
        ? "1:" + (t1Reward / correctRisk).toFixed(1)
        : tc.rrRatio;

      return {
        ...tc,
        quantity:   correctQty,
        deployed:   correctDeployed,
        riskAmount: correctRisk,
        rewardT1:   t1Reward,
        rewardT2:   t2Reward,
        rrRatio:    rr,
        mathVerified: true
      };
    });

    // Sort: A+ first, then by confidence
    verified.sort((a, b) => {
      const gradeOrder = { "A+": 0, "A": 1, "B": 2 };
      const gDiff = (gradeOrder[a.grade] ?? 3) - (gradeOrder[b.grade] ?? 3);
      if (gDiff !== 0) return gDiff;
      return (b.confidence || 0) - (a.confidence || 0);
    });

    const result = {
      calls:           verified,
      traderMindset:   parsed.traderMindset   || "",
      marketRead:      parsed.marketRead       || {},
      capitalPlan:     parsed.capitalPlan      || {},
      skipList:        parsed.skipList         || [],
      checklist:       parsed.intraday5MinChecklist || [],
      generatedAt:     parsed.timestamp
    };

    // BUG FIX: store in .result not .calls
    tradeCallsCache = { result, generatedAt: now };
    console.log("[TraderBrain] " + verified.length + " calls | mindset: " + (parsed.traderMindset || "").slice(0, 60));
    return result;

  } catch (e) {
    console.error("[TraderBrain] Error:", e.message);
    // BUG FIX: return the cached result object (not []) so callers always get .calls
    return tradeCallsCache.result || EMPTY_RESULT;
  }
}

async function checkTheses(activeCalls, currentPrices, marketContext) {
  const now = Date.now();
  if (now - thesisCheckCache.checkedAt < THESIS_TTL_MS && thesisCheckCache.updates) {
    return thesisCheckCache.updates;
  }
  if (!activeCalls || activeCalls.length === 0) return { reviews: [] };

  console.log("[TraderBrain] 5-min thesis check for " + activeCalls.length + " calls");

  try {
    const ist    = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const prompt = buildThesisCheckPrompt(activeCalls, currentPrices, marketContext, ist);
    const raw    = await callAI(prompt, 1500);
    const clean  = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    thesisCheckCache = { updates: parsed, checkedAt: now };
    console.log("[TraderBrain] Thesis check done: " + (parsed.reviews || []).length + " reviews");
    return parsed;

  } catch (e) {
    console.error("[TraderBrain] Thesis check error:", e.message);
    return { reviews: [] };
  }
}

// Invalidate cache when market context changes significantly
function invalidateCache() {
  tradeCallsCache   = { result: null, generatedAt: 0 };
  thesisCheckCache  = { updates: null, checkedAt: 0 };
}

module.exports = { generateTradeCalls, checkTheses, calcPosition, invalidateCache };
