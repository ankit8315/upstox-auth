// aiScorer.js
// Upgraded AI agent that uses ALL data layers:
// - Price action + VWAP + candles
// - Market context (Nifty, VIX, US markets, sectors)
// - News (earnings, dividends, block deals, corporate actions)
// - Generates detailed reasoning for semi-auto confirmation

const axios = require("axios");
const { context } = require("./marketContext");
const { getSymbolNewsScore } = require("./newsEngine");

// Auto-detect which AI provider to use
function getProvider() {
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GEMINI_API_KEY)    return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

const AI_COOLDOWN_MS = 5 * 60 * 1000;
const lastAnalyzed   = {};

function buildPrompt(signalScore, state, newsData) {
  const candleSummary = state.candles && state.candles.length > 0
    ? state.candles.slice(-3).map(c =>
        "O:" + c.open.toFixed(2) +
        " H:" + c.high.toFixed(2) +
        " L:" + c.low.toFixed(2) +
        " C:" + c.close.toFixed(2)
      ).join(" | ")
    : "Insufficient data";

  const topSectors = Object.entries(context.sectors)
    .sort((a, b) => b[1].change - a[1].change)
    .slice(0, 3)
    .map(([n, d]) => n + " " + (d.change > 0 ? "+" : "") + d.change + "%")
    .join(", ");

  const newsLines = newsData.summary.length > 0
    ? newsData.summary.join(" | ")
    : "No significant news";

  return `You are an expert NSE intraday trader with access to comprehensive market data. Analyze this trade opportunity.

═══ STOCK INFO ═══
Symbol: ${signalScore.symbol.replace("NSE_EQ|", "")}
Current Price: Rs.${signalScore.ltp}
VWAP: Rs.${signalScore.vwap.toFixed(2)}
Signal Score: ${signalScore.score}/100 (Grade ${signalScore.grade})
Signal Type: ${signalScore.warnings.length === 0 ? "Clean breakout" : "Breakout with concerns"}
Time: ${signalScore.sessionTime} IST

═══ PRICE ACTION ═══
Last 3 Candles (5-min): ${candleSummary}
Positive Factors: ${signalScore.reasons.join(", ")}
Concerns: ${signalScore.warnings.length > 0 ? signalScore.warnings.join(", ") : "None"}

═══ MARKET CONTEXT ═══
Nifty: ${context.niftyDirection} (${context.niftyChange.toFixed(2)}%)
India VIX: ${context.vix} (${context.vixLevel})
Market Score: ${context.overallScore}/100 (${context.overallSentiment})
US Markets: S&P ${context.usMarkets.sp500Change}% | Dow ${context.usMarkets.dowChange}% | Nasdaq ${context.usMarkets.nasdaqChange}%
Top Sectors: ${topSectors || "Loading..."}

═══ NEWS & CATALYSTS ═══
${newsLines}
News Score: ${newsData.score}/100
Has Earnings Announcement: ${newsData.hasEarnings ? "YES" : "No"}
Has Dividend: ${newsData.hasDividend ? "YES" : "No"}
Has Block Deal: ${newsData.hasBlockDeal ? "YES (" + newsData.blockDealSentiment + ")" : "No"}

═══ RISK PARAMETERS ═══
Capital: Rs.1,000 | Risk per trade: Rs.50 max
Max position: Rs.300 (30% of capital)

Analyze ALL factors above holistically. Consider:
1. Is the price breakout confirmed by market context?
2. Does news support or contradict the trade?
3. Is VIX level safe for this trade?
4. Is sector in bullish or bearish mode?
5. What is the overall probability of success?

Respond ONLY in this exact JSON format, no other text:
{
  "action": "BUY" or "SKIP",
  "confidence": 1-10,
  "entry": price as number,
  "stopLoss": price as number,
  "target1": price as number,
  "target2": price as number,
  "quantity": shares (based on Rs.50 risk = (entry-stopLoss)*quantity),
  "reasoning": "3 sentence explanation covering price + market + news",
  "riskReward": "1:X",
  "holdTime": "e.g. 15-30 mins",
  "keyRisk": "main risk factor in one sentence",
  "catalyst": "main reason this could work"
}`;
}

async function callOpenAI(prompt) {
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      max_tokens: 500,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are an expert NSE intraday trader. Always respond in valid JSON only, no markdown." },
        { role: "user", content: prompt }
      ]
    },
    {
      headers: { "Authorization": "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      timeout: 15000
    }
  );
  return response.data.choices[0].message.content;
}

async function callGemini(prompt) {
  const response = await axios.post(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + process.env.GEMINI_API_KEY,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
    },
    { headers: { "Content-Type": "application/json" }, timeout: 15000 }
  );
  return response.data.candidates[0].content.parts[0].text;
}

async function callAnthropic(prompt) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }]
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      timeout: 15000
    }
  );
  return response.data.content[0].text;
}

async function analyzeSignal(signalScore, state) {
  const provider = getProvider();
  if (!provider) {
    console.log("No AI key — skipping AI analysis");
    return null;
  }

  const symbol = signalScore.symbol;
  const now    = Date.now();

  if (lastAnalyzed[symbol] && now - lastAnalyzed[symbol] < AI_COOLDOWN_MS) return null;
  lastAnalyzed[symbol] = now;

  // Fetch news for this symbol
  const newsData = await getSymbolNewsScore(symbol);

  const prompt = buildPrompt(signalScore, state, newsData);

  try {
    let rawText;
    if      (provider === "openai")    rawText = await callOpenAI(prompt);
    else if (provider === "gemini")    rawText = await callGemini(prompt);
    else if (provider === "anthropic") rawText = await callAnthropic(prompt);

    const clean  = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    console.log(
      "[" + provider.toUpperCase() + "] " +
      symbol.replace("NSE_EQ|","") +
      " → " + parsed.action +
      " conf=" + parsed.confidence + "/10" +
      " RR=" + parsed.riskReward +
      " | " + parsed.catalyst
    );

    return { ...parsed, newsData, provider };

  } catch (err) {
    console.error("AI error (" + provider + "):", err.response && err.response.data || err.message);
    return null;
  }
}

module.exports = { analyzeSignal };
