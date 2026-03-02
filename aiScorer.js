// aiScorer.js
// Supports Claude (Anthropic), OpenAI (GPT-4o), or Gemini
// Set ONE of these in your .env:
//   ANTHROPIC_API_KEY=sk-ant-...
//   OPENAI_API_KEY=sk-...
//   GEMINI_API_KEY=AIza...

const axios = require("axios");

const AI_COOLDOWN_MS = 5 * 60 * 1000; // don't re-analyze same stock within 5 mins
const lastAnalyzed   = {};

// Auto-detect which key is available
function getProvider() {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GEMINI_API_KEY)    return "gemini";
  return null;
}

function buildPrompt(signalScore, candleSummary) {
  return `You are an expert NSE intraday trader. Analyze this breakout signal and give a trade recommendation.

STOCK: ${signalScore.symbol.replace("NSE_EQ|", "")}
PRICE: Rs.${signalScore.ltp}
VWAP: Rs.${signalScore.vwap.toFixed(2)}
SIGNAL SCORE: ${signalScore.score}/100 (Grade ${signalScore.grade})
NIFTY: ${signalScore.niftyDirection}
TIME: ${signalScore.sessionTime} IST
LAST 3 CANDLES (5-min): ${candleSummary}
POSITIVES: ${signalScore.reasons.join(", ")}
CONCERNS: ${signalScore.warnings.length > 0 ? signalScore.warnings.join(", ") : "None"}
CAPITAL: Rs.1,00,000 | RISK PER TRADE: Rs.500 max

Respond ONLY in this exact JSON format, no other text, no markdown:
{
  "action": "BUY" or "SKIP",
  "confidence": 1-10,
  "entry": price as number,
  "stopLoss": price as number,
  "target1": price as number,
  "target2": price as number,
  "quantity": shares as number (based on Rs.500 risk = (entry-stopLoss)*quantity),
  "reasoning": "2 sentence max explanation",
  "riskReward": "1:X",
  "holdTime": "e.g. 15-30 mins"
}`;
}

// ── Anthropic (Claude) ────────────────────────────────────────────────
async function callAnthropic(prompt) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
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

// ── OpenAI (GPT-4o) ───────────────────────────────────────────────────
async function callOpenAI(prompt) {
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",  // cheapest, fast enough for trading
      max_tokens: 400,
      temperature: 0.1,      // low temp = consistent JSON output
      messages: [
        { role: "system", content: "You are an expert NSE intraday trader. Always respond in valid JSON only." },
        { role: "user", content: prompt }
      ]
    },
    {
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );
  return response.data.choices[0].message.content;
}

// ── Gemini ────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const response = await axios.post(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + process.env.GEMINI_API_KEY,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 400
      }
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 15000
    }
  );
  return response.data.candidates[0].content.parts[0].text;
}

// ── Main ──────────────────────────────────────────────────────────────
async function analyzeSignal(signalScore, state) {
  const provider = getProvider();
  if (!provider) {
    console.log("No AI key found in .env — skipping AI analysis");
    return null;
  }

  const symbol = signalScore.symbol;
  const now    = Date.now();

  // Cooldown check
  if (lastAnalyzed[symbol] && now - lastAnalyzed[symbol] < AI_COOLDOWN_MS) return null;
  lastAnalyzed[symbol] = now;

  const candleSummary = state.candles && state.candles.length > 0
    ? state.candles.slice(-3).map(c =>
        "O:" + c.open.toFixed(2) + " H:" + c.high.toFixed(2) +
        " L:" + c.low.toFixed(2) + " C:" + c.close.toFixed(2)
      ).join(" | ")
    : "Insufficient data";

  const prompt = buildPrompt(signalScore, candleSummary);

  try {
    let rawText;
    if      (provider === "anthropic") rawText = await callAnthropic(prompt);
    else if (provider === "openai")    rawText = await callOpenAI(prompt);
    else if (provider === "gemini")    rawText = await callGemini(prompt);

    // Strip markdown fences if any
    const clean  = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    console.log("[" + provider.toUpperCase() + "] " +
      symbol.replace("NSE_EQ|","") + " → " +
      parsed.action + " conf=" + parsed.confidence +
      " RR=" + parsed.riskReward
    );
    return parsed;

  } catch (err) {
    console.error("AI error (" + provider + "):", err.response && err.response.data || err.message);
    return null;
  }
}

module.exports = { analyzeSignal };
