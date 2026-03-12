// poller.js — Full Intelligence Trading System
const axios = require("axios");
const { updateTick }                        = require("./marketState");
const { updateCandle }                      = require("./candleEngine");
const { evaluateBreakout }                  = require("./strategyEngine");
const { sendTelegramAlert }                 = require("./alertService");
const { updateTick: tickStore }             = require("./tickStore");
const { scoreSignal }                       = require("./signalEngine");
const { analyzeSignal }                     = require("./aiScorer");
const { calculatePosition, canTrade }       = require("./riskEngine");
const { monitorPositions, resetDailyFlags } = require("./orderManager");
const { refreshMarketContext, isSafeToTrade, context, getTopSectors } = require("./marketContext");
const { refreshAll: refreshNews, getSymbolNewsScore } = require("./newsEngine");
const { processTick: breakoutEngineTick }            = require("./breakoutEngine");

// ── Telegram rate limiter: max 1 message per 3 seconds ───────────────────────
const telegramQueue = [];
let telegramBusy = false;
const TELEGRAM_INTERVAL_MS = 3000;

function queueTelegram(msg) {
  telegramQueue.push(msg);
  if (!telegramBusy) drainTelegramQueue();
}

async function drainTelegramQueue() {
  if (telegramQueue.length === 0) { telegramBusy = false; return; }
  telegramBusy = true;
  const msg = telegramQueue.shift();
  try { await sendTelegramAlert(msg); } catch(e) {}
  setTimeout(drainTelegramQueue, TELEGRAM_INTERVAL_MS);
}
global.queueTelegram = queueTelegram;

const POLL_INTERVAL_MS      = 10000;
const BATCH_SIZE            = 500;
const DELAY_BETWEEN_BATCHES = 1000;
const WARMUP_POLLS          = 4;
const CONTEXT_REFRESH_MS    = 5 * 60 * 1000;
const NEWS_REFRESH_MS       = 30 * 60 * 1000;

const currentPrices    = {};
let lastContextRefresh = 0;
let lastNewsRefresh    = 0;

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

// Full OHLC quotes for watchlist symbols (called every 5 min, not every poll)
async function refreshWatchlistQuotes(accessToken) {
  const watchlist = global.researchData && global.researchData.enrichedWatchlist;
  if (!watchlist || watchlist.length === 0) return;
  const keys = watchlist.slice(0, 12).map(s => "NSE_EQ|" + s.symbol).join(",");
  try {
    const r = await axios.get("https://api.upstox.com/v2/market-quote/quotes", {
      headers: { Authorization: "Bearer " + accessToken, "Api-Version": "2" },
      params:  { instrument_key: keys },
      timeout: 10000
    });
    global.upstoxFullQuotes = r.data.data || {};
  } catch (e) {
    // Non-fatal — stockIntelligence will fetch per-symbol as fallback
  }
}

async function processSignal(key, ltp, state, type, accessToken) {
  const newsScore = await getSymbolNewsScore(key);
  const scored    = scoreSignal(key, ltp, state, type, newsScore);
  if (!scored.pass) return;

  const safetyCheck = isSafeToTrade();
  if (!safetyCheck.safe) {
    console.log("BLOCKED: " + key.replace("NSE_EQ|","") + " — " + safetyCheck.reason);
    return;
  }

  const tradeCheck = canTrade(key);
  const pos = calculatePosition(key, ltp, null);
  if (!pos || !pos.riskOk) return;

  let ai = null;
  if (scored.score >= 65) ai = await analyzeSignal(scored, state);

  const finalPos = ai ? calculatePosition(key, ltp, ai) : pos;
  if (!finalPos) return;

  const opportunity = {
    id: Date.now() + "_" + key,
    type, symbol: key,
    displaySymbol: key.replace("NSE_EQ|", ""),
    price: ltp, score: scored.score, grade: scored.grade,
    reasons: scored.reasons, warnings: scored.warnings,
    niftyDirection: scored.niftyDirection,
    niftyChange: scored.niftyChange,
    vix: scored.vix, vixLevel: scored.vixLevel,
    usSentiment: scored.usSentiment,
    overallMarketScore: scored.overallMarketScore,
    topSectors: getTopSectors(),
    vwap: scored.vwap,
    entry: finalPos.entry, stopLoss: finalPos.stopLoss,
    target1: finalPos.target1, target2: finalPos.target2,
    quantity: finalPos.quantity, totalCost: finalPos.totalCost,
    maxLoss: finalPos.maxLoss, rrRatio: finalPos.rrRatio,
    newsScore: newsScore.score, newsSummary: newsScore.summary,
    hasEarnings: newsScore.hasEarnings,
    hasDividend: newsScore.hasDividend,
    hasBlockDeal: newsScore.hasBlockDeal,
    aiAction: ai ? ai.action : null,
    aiConfidence: ai ? ai.confidence : null,
    aiReasoning: ai ? ai.reasoning : null,
    aiHoldTime: ai ? ai.holdTime : null,
    aiKeyRisk: ai ? ai.keyRisk : null,
    aiCatalyst: ai ? ai.catalyst : null,
    canTrade: tradeCheck.ok,
    cantTradeReason: tradeCheck.reason || null,
    time: new Date().toISOString(), status: "pending"
  };

  if (global.addBreakout) global.addBreakout(opportunity);

  const gradeEmoji = scored.grade === "A" ? "🔥" : "📈";
  const niftyEmoji = scored.niftyDirection === "bull" ? "🟢" : scored.niftyDirection === "bear" ? "🔴" : "🟡";

  let msg = gradeEmoji + " " + scored.grade + ": " + key.replace("NSE_EQ|","") +
    "\nPrice ₹" + ltp + " Score " + scored.score + "/100" +
    "\n" + niftyEmoji + " Nifty " + scored.niftyChange.toFixed(2) + "% VIX " + scored.vix + " (" + scored.vixLevel + ")" +
    "\n📰 " + (newsScore.summary[0] || "No major news");
  if (ai) msg += "\n🤖 AI: " + ai.action + " (" + ai.confidence + "/10) " + ai.reasoning;
  if (tradeCheck.ok) {
    msg += "\nEntry ₹" + finalPos.entry + " SL ₹" + finalPos.stopLoss +
      " T1 ₹" + finalPos.target1 + " T2 ₹" + finalPos.target2 +
      "\nQty:" + finalPos.quantity + " Risk:₹" + finalPos.maxLoss + " RR:1:" + finalPos.rrRatio;
  } else {
    msg += "\n⚠️ " + tradeCheck.reason;
  }
  sendTelegramAlert(msg);  // already rate-limited by queue via alertService

  console.log("SIGNAL: " + key.replace("NSE_EQ|","") + " score=" + scored.score +
    " grade=" + scored.grade + (ai ? " AI=" + ai.action : "") +
    " news=" + newsScore.score);
}

async function startPoller(accessToken, instrumentKeys) {
  console.log("Full Intelligence System: " + instrumentKeys.length + " instruments");
  console.log("Layers: Price + VWAP + Candles + News + Nifty + VIX + US + Sectors + AI");
  resetDailyFlags();
  global.accessToken = accessToken; // expose for stockIntelligence.js

  // global.addPreBreakout is defined in auth.js

  await refreshMarketContext(accessToken);
  lastContextRefresh = Date.now();

  await refreshNews();
  lastNewsRefresh = Date.now();

  const safeStatus = require("./marketContext").isSafeToTrade();
  const safeEmoji  = safeStatus.safe ? "✅" : "🚫";

  sendTelegramAlert(
    "🌅 SCANNER STARTED\n" +
    "Nifty: " + context.niftyDirection + " " + context.niftyChange.toFixed(2) + "%\n" +
    "VIX: " + context.vix + " (" + context.vixLevel + ")\n" +
    "US: " + context.usMarkets.sentiment + " S&P " + context.usMarkets.sp500Change + "%\n" +
    "Market Score: " + context.overallScore + "/100 (" + context.overallSentiment + ")\n" +
    "Signal threshold: 50/100 | Stocks: " + instrumentKeys.length + "\n" +
    safeEmoji + " Trading: " + (safeStatus.safe ? "ACTIVE — alerts will fire" : "BLOCKED — " + safeStatus.reason)
  );

  let pollCount = 0, totalTicks = 0;

  async function poll() {
    const start = Date.now();

    if (!isMarketOpen()) {
      if (pollCount % 10 === 0) console.log("Market closed [" + getISTTime() + " IST]");
      pollCount++;
      setTimeout(poll, 60000);
      return;
    }

    pollCount++;

    if (Date.now() - lastContextRefresh > CONTEXT_REFRESH_MS) {
      await refreshMarketContext(accessToken);
      await refreshWatchlistQuotes(accessToken);  // cache full OHLC for enrichment
      lastContextRefresh = Date.now();
    }
    if (Date.now() - lastNewsRefresh > NEWS_REFRESH_MS) {
      refreshNews();
      lastNewsRefresh = Date.now();
    }

    for (let i = 0; i < instrumentKeys.length; i += BATCH_SIZE) {
      const data = await fetchLTP(accessToken, instrumentKeys.slice(i, i + BATCH_SIZE));
      const now  = Date.now();

      for (const [, val] of Object.entries(data)) {
        try {
          const key = val.instrument_token;
          const ltp = val.last_price;
          const tradingSymbol = val.trading_symbol || val.tradingSymbol || "";
          if (!key || !ltp) continue;
          totalTicks++;
          currentPrices[key] = ltp;
          // Store by NSE trading symbol for easy lookup
          if (tradingSymbol) {
            currentPrices[tradingSymbol] = ltp;
            if (!global.instrumentSymbolMap) global.instrumentSymbolMap = {};
            global.instrumentSymbolMap[key] = tradingSymbol;
          }
          global.currentPrices = currentPrices;
          if (pollCount === 1 && totalTicks <= 3) console.log("Sample: " + key + " ltp=" + ltp);

          const state = updateTick(key, ltp, 0, now);
          updateCandle(state, ltp, 0, now);
          if (pollCount <= WARMUP_POLLS) continue;

          const signal = evaluateBreakout(key, state);
          if (signal) await processSignal(key, ltp, state, "strategy", accessToken);

          const td = tickStore(key, ltp);
          // Feed preBreakoutEngine via breakoutEngine on every tick
          breakoutEngineTick(key, ltp);
          // FIX: previousHigh is the 5min high BEFORE adding current tick
          // ltp >= td.high5Min is always true — we need ltp to be a NEW high
          // i.e. ltp > what the high was last poll (stored as td.prevHigh5Min)
          const prevHigh = td.prevHigh5Min || 0;
          td.prevHigh5Min = td.high5Min;
          // Require MINIMUM 0.4% move above prev high to filter ₹0.1 noise
          const minBreakoutPct = 0.004; // 0.4%
          const pctMove = prevHigh > 0 ? (ltp - prevHigh) / prevHigh : 0;
          const isRealBreakout = prevHigh > 0 && pctMove >= minBreakoutPct && ltp >= td.high5Min;
          if (isRealBreakout && td.ticks.length >= 5 &&
              now - (td.lastBreakoutTime || 0) > 120000) {
            td.lastBreakoutTime = now;
            console.log("5MIN BREAKOUT: " + key.replace("NSE_EQ|","") + " +" + (pctMove*100).toFixed(2) + "% prev=" + prevHigh.toFixed(2) + " now=" + ltp);
            await processSignal(key, ltp, state, "5min_high", accessToken);
          }
        } catch (e) {}
      }

      if (i + BATCH_SIZE < instrumentKeys.length) {
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
      }
    }

    await monitorPositions(accessToken, currentPrices);

    const elapsed = Date.now() - start;
    if (pollCount <= WARMUP_POLLS) {
      console.log("Warmup " + pollCount + "/" + WARMUP_POLLS + " ticks=" + totalTicks + " " + elapsed + "ms Nifty=" + context.niftyDirection + " VIX=" + context.vixLevel);
    } else if (pollCount % 6 === 0) {
      console.log(
        "Poll #" + pollCount + " ticks=" + totalTicks + " " + elapsed + "ms" +
        " | Nifty=" + context.niftyDirection + " VIX=" + context.vix + "(" + context.vixLevel + ")" +
        " | Score=" + context.overallScore + " Safe=" + require("./marketContext").isSafeToTrade().safe
      );
    }

    setTimeout(poll, Math.max(0, POLL_INTERVAL_MS - elapsed));
  }

  poll();
}

module.exports = { startPoller, currentPrices };