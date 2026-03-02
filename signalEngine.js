// signalEngine.js - Scores signals 0-100 based on all market factors

const SIGNAL_THRESHOLD = 60;

function getSessionScore(hour, min) {
  const t = hour * 60 + min;
  if (t < 9 * 60 + 30) return 0;
  if (t < 11 * 60) return 90;
  if (t < 13 * 60) return 70;
  if (t < 14 * 60 + 30) return 40;
  if (t < 15 * 60) return 75;
  return 0;
}

function getISTHourMin() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return { hour: now.getHours(), min: now.getMinutes() };
}

const marketContext = {
  niftyLTP: 0,
  niftyOpen: 0,
  niftyDirection: "unknown",
  niftyChangePercent: 0,
  lastUpdate: 0
};

function updateNiftyContext(ltp, open) {
  marketContext.niftyLTP = ltp;
  if (open > 0) marketContext.niftyOpen = open;
  marketContext.lastUpdate = Date.now();
  const base = marketContext.niftyOpen || ltp;
  if (base > 0) {
    const change = ((ltp - base) / base) * 100;
    marketContext.niftyChangePercent = change;
    if (change > 0.3) marketContext.niftyDirection = "bull";
    else if (change < -0.3) marketContext.niftyDirection = "bear";
    else marketContext.niftyDirection = "sideways";
  }
}

const priceHistory = {};

function updatePriceHistory(symbol, ltp, timestamp) {
  if (!priceHistory[symbol]) {
    priceHistory[symbol] = { prices: [], open: ltp, high: ltp, low: ltp };
  }
  const h = priceHistory[symbol];
  h.prices.push({ price: ltp, time: timestamp });
  if (h.prices.length > 60) h.prices.shift();
  h.high = Math.max(h.high, ltp);
  h.low = Math.min(h.low, ltp);
  return h;
}

function scoreSignal(symbol, ltp, state, signalType) {
  const { hour, min } = getISTHourMin();
  const history = updatePriceHistory(symbol, ltp, Date.now());
  let score = 0;
  const reasons = [];
  const warnings = [];

  // 1. Session timing (0-20 pts)
  const sessionScore = getSessionScore(hour, min) / 100 * 20;
  score += sessionScore;
  if (sessionScore >= 16) reasons.push("Good window " + hour + ":" + String(min).padStart(2,"0"));
  else if (sessionScore < 10) warnings.push("Poor trading time");

  // 2. Nifty direction (0-20 pts)
  if (marketContext.niftyDirection === "bull") {
    score += 20;
    reasons.push("Nifty bullish " + marketContext.niftyChangePercent.toFixed(2) + "%");
  } else if (marketContext.niftyDirection === "sideways") {
    score += 10;
  } else if (marketContext.niftyDirection === "bear") {
    warnings.push("Nifty bearish — avoid longs");
  } else {
    score += 10;
  }

  // 3. Price vs VWAP (0-15 pts)
  if (state.vwap > 0) {
    const vwapDiff = ((ltp - state.vwap) / state.vwap) * 100;
    if (vwapDiff > 0.5) { score += 15; reasons.push("Strong above VWAP +" + vwapDiff.toFixed(2) + "%"); }
    else if (vwapDiff > 0) { score += 8; reasons.push("Above VWAP +" + vwapDiff.toFixed(2) + "%"); }
    else { warnings.push("Below VWAP " + vwapDiff.toFixed(2) + "%"); }
  }

  // 4. Candle strength (0-15 pts)
  if (state.candles && state.candles.length >= 2) {
    const last = state.candles[state.candles.length - 1];
    const prev = state.candles[state.candles.length - 2];
    const bodySize = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    const bodyRatio = range > 0 ? bodySize / range : 0;
    if (last.close > last.open && bodyRatio > 0.6) { score += 15; reasons.push("Strong bullish candle"); }
    else if (last.close > last.open) { score += 8; reasons.push("Bullish candle"); }
    else { warnings.push("Bearish last candle"); }
    if (last.close > last.open && prev.close > prev.open) { score += 5; reasons.push("2 green candles"); }
  }

  // 5. Momentum (0-15 pts)
  if (history.prices.length >= 6) {
    const recent = history.prices.slice(-3).map(p => p.price);
    const older = history.prices.slice(-6, -3).map(p => p.price);
    const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b) / older.length;
    const momentum = ((recentAvg - olderAvg) / olderAvg) * 100;
    if (momentum > 0.3) { score += 15; reasons.push("Strong momentum +" + momentum.toFixed(2) + "%"); }
    else if (momentum > 0) { score += 8; reasons.push("Positive momentum"); }
    else { warnings.push("Negative momentum"); }
  }

  // 6. Price range (0-15 pts)
  if (ltp >= 100 && ltp <= 5000) { score += 15; reasons.push("Good price ₹" + ltp); }
  else if (ltp < 20) { score = Math.min(score, 30); warnings.push("Penny stock"); }
  else if (ltp > 5000) { score += 8; }

  if (signalType === "strategy") { score += 5; reasons.push("Strategy breakout"); }

  score = Math.min(100, Math.round(score));

  const hardBlock = warnings.some(w =>
    w.includes("Nifty bearish") || w.includes("Penny") || w.includes("Poor trading")
  );

  return {
    symbol, ltp, score,
    grade: score >= 80 ? "A" : score >= 60 ? "B" : "C",
    reasons, warnings,
    sessionTime: hour + ":" + String(min).padStart(2, "0"),
    niftyDirection: marketContext.niftyDirection,
    vwap: state.vwap || 0,
    pass: score >= SIGNAL_THRESHOLD && !hardBlock
  };
}

module.exports = { scoreSignal, updateNiftyContext, marketContext, SIGNAL_THRESHOLD };
