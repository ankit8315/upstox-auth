// signalEngine.js - Master signal scorer using ALL data layers
// Score breakdown:
// - Session timing:     0-15 pts
// - Nifty direction:    0-20 pts
// - VIX level:          0-15 pts
// - Price vs VWAP:      0-15 pts
// - Candle strength:    0-15 pts
// - Momentum:           0-10 pts
// - News catalyst:      0-20 pts (NEW)
// - Market context:     0-10 pts (NEW)
// - Price range:        0-10 pts
// Total possible:       130 pts → normalized to 100

const { context } = require("./marketContext");

const SIGNAL_THRESHOLD = 50; // was 60 — was blocking valid signals on high-VIX sideways days

function getSessionScore(hour, min) {
  const t = hour * 60 + min;
  if (t < 9 * 60 + 30)               return 0;   // 9:15-9:30 chaos
  if (t < 11 * 60)                    return 100;  // 9:30-11:00 best
  if (t < 12 * 60)                    return 80;   // 11:00-12:00 good
  if (t < 13 * 60)                    return 60;   // 12:00-1:00 ok
  if (t < 14 * 60 + 30)              return 30;   // 1:00-2:30 lunch avoid
  if (t < 15 * 60)                    return 70;   // 2:30-3:00 momentum
  return 0;                                         // 3:00+ avoid
}

function getISTHourMin() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return { hour: now.getHours(), min: now.getMinutes() };
}

const priceHistory = {};

function updatePriceHistory(symbol, ltp) {
  if (!priceHistory[symbol]) {
    priceHistory[symbol] = { prices: [], high: ltp, low: ltp };
  }
  const h = priceHistory[symbol];
  h.prices.push({ price: ltp, time: Date.now() });
  if (h.prices.length > 60) h.prices.shift();
  h.high = Math.max(h.high, ltp);
  h.low  = Math.min(h.low, ltp);
  return h;
}

function scoreSignal(symbol, ltp, state, signalType, newsScore) {
  const { hour, min } = getISTHourMin();
  updatePriceHistory(symbol, ltp);

  let rawScore = 0;
  const reasons  = [];
  const warnings = [];

  // ── 1. Session timing (0-15) ─────────────────────────────────────
  const sessionPct = getSessionScore(hour, min) / 100;
  const sessionPts = Math.round(sessionPct * 15);
  rawScore += sessionPts;
  if (sessionPts >= 12) reasons.push("Prime trading window " + hour + ":" + String(min).padStart(2,"0"));
  else if (sessionPts < 5) warnings.push("Poor trading time — consider skipping");

  // ── 2. Nifty direction (0-20) ────────────────────────────────────
  const niftyDir = context.niftyDirection;
  const niftyChg = context.niftyChange || 0;
  if (niftyDir === "bull") {
    const pts = niftyChg > 0.8 ? 20 : niftyChg > 0.3 ? 15 : 10;
    rawScore += pts;
    reasons.push("Nifty bullish +" + niftyChg.toFixed(2) + "%");
  } else if (niftyDir === "sideways") {
    // Sideways = rotation day, individual stocks move a LOT
    rawScore += 14;
    reasons.push("Nifty sideways — rotation/momentum plays active");
  } else if (niftyDir === "bear") {
    // Bear market still has 5%+ movers — score lower but don't block
    rawScore += 3;
    warnings.push("Nifty bearish " + niftyChg.toFixed(2) + "% — select stocks only");
  } else {
    rawScore += 10; // unknown
  }

  // ── 3. VIX level (0-15) ──────────────────────────────────────────
  const vixLevel = context.vixLevel;
  if (vixLevel === "low")      { rawScore += 15; reasons.push("Low VIX " + context.vix + " — stable market"); }
  else if (vixLevel === "medium") { rawScore += 10; }
  else if (vixLevel === "high")   { rawScore += 3; warnings.push("High VIX " + context.vix + " — volatile"); }
  else if (vixLevel === "high")    { rawScore += 5; warnings.push("High VIX " + context.vix + " — use tight SL"); }
  else if (vixLevel === "extreme") { warnings.push("Extreme VIX " + context.vix + " — only high-conviction plays"); }
  else { rawScore += 8; } // unknown

  // ── 4. US market cues (0-10) ─────────────────────────────────────
  const usSentiment = context.usMarkets.sentiment;
  if (usSentiment === "positive") {
    rawScore += 10;
    reasons.push("US markets positive S&P " + context.usMarkets.sp500Change + "%");
  } else if (usSentiment === "neutral") {
    rawScore += 5;
  } else if (usSentiment === "negative") {
    warnings.push("US markets weak — global selling pressure");
  }

  // ── 5. Price vs VWAP (0-15) ──────────────────────────────────────
  if (state.vwap > 0) {
    const vwapDiff = ((ltp - state.vwap) / state.vwap) * 100;
    if (vwapDiff > 1.0)       { rawScore += 15; reasons.push("Strong above VWAP +" + vwapDiff.toFixed(2) + "%"); }
    else if (vwapDiff > 0.3)  { rawScore += 10; reasons.push("Above VWAP +" + vwapDiff.toFixed(2) + "%"); }
    else if (vwapDiff > 0)    { rawScore += 5;  }
    else                      { warnings.push("Below VWAP " + vwapDiff.toFixed(2) + "%"); }
  }

  // ── 6. Candle strength (0-15) ────────────────────────────────────
  if (state.candles && state.candles.length >= 2) {
    const last = state.candles[state.candles.length - 1];
    const prev = state.candles[state.candles.length - 2];
    const bodySize  = Math.abs(last.close - last.open);
    const range     = last.high - last.low;
    const bodyRatio = range > 0 ? bodySize / range : 0;

    if (last.close > last.open && bodyRatio > 0.6) {
      rawScore += 15; reasons.push("Strong bullish candle " + (bodyRatio * 100).toFixed(0) + "% body");
    } else if (last.close > last.open) {
      rawScore += 8;  reasons.push("Bullish candle");
    } else {
      warnings.push("Bearish last candle");
    }
    if (last.close > last.open && prev.close > prev.open) {
      rawScore += 5; reasons.push("2 consecutive green candles");
    }
  }

  // ── 7. Momentum (0-10) ───────────────────────────────────────────
  const hist = priceHistory[symbol];
  if (hist && hist.prices.length >= 6) {
    const recent   = hist.prices.slice(-3).map(p => p.price);
    const older    = hist.prices.slice(-6, -3).map(p => p.price);
    const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
    const olderAvg  = older.reduce((a, b) => a + b) / older.length;
    const momentum  = ((recentAvg - olderAvg) / olderAvg) * 100;
    if (momentum > 0.5)      { rawScore += 10; reasons.push("Strong momentum +" + momentum.toFixed(2) + "%"); }
    else if (momentum > 0.1) { rawScore += 6;  reasons.push("Positive momentum"); }
    else if (momentum < 0)   { warnings.push("Weakening momentum"); }
  }

  // ── 8. News catalyst (0-20) — NEW ────────────────────────────────
  if (newsScore) {
    if (newsScore.score >= 30) {
      rawScore += 20;
      reasons.push("Strong positive news catalyst");
    } else if (newsScore.score >= 10) {
      rawScore += 12;
      reasons.push("Positive news sentiment");
    } else if (newsScore.score <= -20) {
      warnings.push("Negative news — avoid");
      rawScore -= 10;
    }
    if (newsScore.hasDividend)   reasons.push("Dividend announcement");
    if (newsScore.hasEarnings)   reasons.push("Earnings announcement today");
    if (newsScore.hasBlockDeal && newsScore.blockDealSentiment.includes("BUY")) {
      rawScore += 10; reasons.push("Institutional block BUY deal");
    }
  }

  // ── 9. Price range quality (0-10) ────────────────────────────────
  if (ltp >= 50 && ltp <= 5000)   { rawScore += 10; }
  else if (ltp < 20)              { rawScore = Math.min(rawScore, 40); warnings.push("Penny stock — risky"); }
  else if (ltp > 5000)            { rawScore += 6; }

  // ── Signal type bonus ─────────────────────────────────────────────
  if (signalType === "strategy")  rawScore += 5;

  // ── Normalize to 100 ─────────────────────────────────────────────
  const score = Math.max(0, Math.min(100, Math.round(rawScore * 100 / 130)));

  // ── Hard blocks — only truly untradeable conditions ──────────────
  // NOTE: Nifty bearish is NOT a hard block — individual stocks still move 5%+
  // NOTE: VIX extreme is handled by isSafeToTrade() with corrected thresholds
  // NOTE: Poor trading time reduces score but doesn't block — can still catch news plays
  const hardBlock = warnings.some(w =>
    w.includes("Penny stock")    // under ₹10 — skip always
  );

  return {
    symbol, ltp, score,
    grade: score >= 75 ? "A" : score >= 60 ? "B" : "C",
    reasons, warnings,
    sessionTime: hour + ":" + String(min).padStart(2, "0"),
    niftyDirection: context.niftyDirection,
    niftyChange: context.niftyChange,
    vix: context.vix,
    vixLevel: context.vixLevel,
    usSentiment: context.usMarkets.sentiment,
    overallMarketScore: context.overallScore,
    vwap: state.vwap || 0,
    newsScore: newsScore || null,
    pass: score >= SIGNAL_THRESHOLD && !hardBlock
  };
}

module.exports = { scoreSignal, SIGNAL_THRESHOLD };