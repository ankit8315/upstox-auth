// poller.js — Full intraday trading system
const axios = require("axios");
const { updateTick }            = require("./marketState");
const { updateCandle }          = require("./candleEngine");
const { evaluateBreakout }      = require("./strategyEngine");
const { sendTelegramAlert }     = require("./alertService");
const { updateTick: tickStore } = require("./tickStore");
const { scoreSignal, updateNiftyContext, marketContext } = require("./signalEngine");
const { analyzeSignal }         = require("./aiScorer");
const { calculatePosition, canTrade } = require("./riskEngine");
const { monitorPositions, resetDailyFlags } = require("./orderManager");

const POLL_INTERVAL_MS       = 10000;
const BATCH_SIZE             = 500;
const DELAY_BETWEEN_BATCHES  = 1000;
const WARMUP_POLLS           = 4;
const NIFTY_KEY              = "NSE_INDEX|Nifty 50";
const currentPrices          = {};

function isMarketOpen() {
  const n = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const d = n.getDay(), h = n.getHours(), m = n.getMinutes();
  if (d === 0 || d === 6) return false;
  if (h < 9 || (h === 9 && m < 15)) return false;
  if (h > 15 || (h === 15 && m > 35)) return false;
  return true;
}

function getISTTime() {
  const n = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return n.getHours() + ":" + String(n.getMinutes()).padStart(2, "0");
}

async function fetchLTP(accessToken, keys) {
  try {
    const r = await axios.get("https://api.upstox.com/v2/market-quote/ltp", {
      headers: { Authorization: "Bearer " + accessToken, "Api-Version": "2" },
      params: { instrument_key: keys.join(",") }, timeout: 8000
    });
    return r.data.data || {};
  } catch (e) {
    if (e.response && e.response.status === 429) {
      console.log("Rate limited. Pausing 15s...");
      await new Promise(r => setTimeout(r, 15000));
    } else {
      console.error("LTP error:", e.response && e.response.status, e.message);
    }
    return {};
  }
}

async function fetchNifty(accessToken) {
  try {
    const r = await axios.get("https://api.upstox.com/v2/market-quote/ltp", {
      headers: { Authorization: "Bearer " + accessToken, "Api-Version": "2" },
      params: { instrument_key: NIFTY_KEY }, timeout: 5000
    });
    const d = r.data.data || {};
    const v = d[Object.keys(d)[0]];
    if (v) updateNiftyContext(v.last_price, 0);
  } catch (e) {}
}

async function processSignal(key, ltp, state, type, accessToken) {
  const scored = scoreSignal(key, ltp, state, type);
  if (!scored.pass) return;

  const tradeCheck = canTrade(key);
  const pos = calculatePosition(key, ltp, null);
  if (!pos || !pos.riskOk) return;

  let ai = null;
  if (scored.score >= 70) ai = await analyzeSignal(scored, state);

  const finalPos = ai ? calculatePosition(key, ltp, ai) : pos;
  if (!finalPos) return;

  const opportunity = {
    id: Date.now() + "_" + key,
    type,
    symbol: key,
    displaySymbol: key.replace("NSE_EQ|", ""),
    price: ltp,
    score: scored.score,
    grade: scored.grade,
    reasons: scored.reasons,
    warnings: scored.warnings,
    niftyDirection: scored.niftyDirection,
    vwap: scored.vwap,
    entry: finalPos.entry,
    stopLoss: finalPos.stopLoss,
    target1: finalPos.target1,
    target2: finalPos.target2,
    quantity: finalPos.quantity,
    totalCost: finalPos.totalCost,
    maxLoss: finalPos.maxLoss,
    rrRatio: finalPos.rrRatio,
    aiAction: ai ? ai.action : null,
    aiConfidence: ai ? ai.confidence : null,
    aiReasoning: ai ? ai.reasoning : null,
    aiHoldTime: ai ? ai.holdTime : null,
    canTrade: tradeCheck.ok,
    cantTradeReason: tradeCheck.reason || null,
    time: new Date().toISOString(),
    status: "pending"
  };

  if (global.addBreakout) global.addBreakout(opportunity);

  const emoji = scored.grade === "A" ? "🔥" : "📈";
  const aiLine = ai ? "\nAI: " + ai.action + " (" + ai.confidence + "/10) — " + ai.reasoning : "";
  const tradeLine = tradeCheck.ok
    ? "\nEntry ₹" + finalPos.entry + " | SL ₹" + finalPos.stopLoss + " | T1 ₹" + finalPos.target1 + " | T2 ₹" + finalPos.target2 + "\nQty: " + finalPos.quantity + " | Risk: ₹" + finalPos.maxLoss + " | RR 1:" + finalPos.rrRatio
    : "\n⚠️ " + tradeCheck.reason;

  sendTelegramAlert(
    emoji + " " + scored.grade + "-GRADE: " + key.replace("NSE_EQ|","") +
    "\nPrice ₹" + ltp + " | Score " + scored.score + "/100" +
    "\nNifty: " + scored.niftyDirection + " | " + scored.sessionTime + " IST" +
    aiLine + tradeLine
  );

  console.log("SIGNAL: " + key.replace("NSE_EQ|","") + " score=" + scored.score + " grade=" + scored.grade + (ai ? " AI=" + ai.action : ""));
}

async function startPoller(accessToken, instrumentKeys) {
  console.log("Full trading system started — " + instrumentKeys.length + " instruments");
  console.log("Risk: ₹500/trade | Max 3 positions | Auto square-off 3:15 PM");
  resetDailyFlags();

  let pollCount = 0, totalTicks = 0;

  async function poll() {
    const start = Date.now();

    if (!isMarketOpen()) {
      if (pollCount % 10 === 0) console.log("Market closed [" + getISTTime() + " IST]. Waiting 60s...");
      pollCount++;
      setTimeout(poll, 60000);
      return;
    }

    pollCount++;
    await fetchNifty(accessToken);

    for (let i = 0; i < instrumentKeys.length; i += BATCH_SIZE) {
      const data = await fetchLTP(accessToken, instrumentKeys.slice(i, i + BATCH_SIZE));
      const now = Date.now();

      for (const [, val] of Object.entries(data)) {
        try {
          const key = val.instrument_token;
          const ltp = val.last_price;
          if (!key || !ltp) continue;
          totalTicks++;
          currentPrices[key] = ltp;

          if (pollCount === 1 && totalTicks <= 3) console.log("Sample: " + key + " ltp=" + ltp);

          const state = updateTick(key, ltp, 0, now);
          updateCandle(state, ltp, 0, now);
          if (pollCount <= WARMUP_POLLS) continue;

          // Strategy engine
          const signal = evaluateBreakout(key, state);
          if (signal) await processSignal(key, ltp, state, "strategy", accessToken);

          // 5-min high
          const td = tickStore(key, ltp);
          if (td.high5Min && ltp >= td.high5Min && td.ticks.length >= 3 && now - (td.lastBreakoutTime || 0) > 60000) {
            td.lastBreakoutTime = now;
            await processSignal(key, ltp, state, "5min_high", accessToken);
          }
        } catch (e) {}
      }

      if (i + BATCH_SIZE < instrumentKeys.length) await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }

    await monitorPositions(accessToken, currentPrices);

    const elapsed = Date.now() - start;
    if (pollCount <= WARMUP_POLLS) {
      console.log("Warmup " + pollCount + "/" + WARMUP_POLLS + " ticks=" + totalTicks + " " + elapsed + "ms Nifty=" + marketContext.niftyDirection);
    } else if (pollCount % 10 === 0) {
      console.log("Poll #" + pollCount + " ticks=" + totalTicks + " " + elapsed + "ms Nifty=" + marketContext.niftyDirection);
    }

    setTimeout(poll, Math.max(0, POLL_INTERVAL_MS - elapsed));
  }

  poll();
}

module.exports = { startPoller, currentPrices };
