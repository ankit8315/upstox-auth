// technicalEngine.js
// Institutional-grade technical analysis
// EMA, RSI, VWAP bands, support/resistance, candlestick patterns
// Multi-timeframe confluence

const priceData = {}; // symbol → { prices[], volumes[] }

function updatePriceData(symbol, ltp, volume, timestamp) {
  if (!priceData[symbol]) {
    priceData[symbol] = { prices: [], volumes: [], timestamps: [] };
  }
  const d = priceData[symbol];
  d.prices.push(ltp);
  d.volumes.push(volume || 0);
  d.timestamps.push(timestamp);
  // Keep last 200 ticks (~33 mins at 10s interval)
  if (d.prices.length > 200) {
    d.prices.shift(); d.volumes.shift(); d.timestamps.shift();
  }
  return d;
}

// ── EMA Calculation ───────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

// ── RSI Calculation ───────────────────────────────────────────────────
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const recent = prices.slice(-period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs  = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// ── VWAP Bands ────────────────────────────────────────────────────────
function calcVWAPBands(prices, volumes, vwap) {
  if (!vwap || prices.length < 10) return null;
  const deviations = prices.map(p => Math.pow(p - vwap, 2));
  const stdDev = Math.sqrt(deviations.reduce((a, b) => a + b) / deviations.length);
  return {
    vwap,
    upper1: parseFloat((vwap + stdDev).toFixed(2)),
    lower1: parseFloat((vwap - stdDev).toFixed(2)),
    upper2: parseFloat((vwap + 2 * stdDev).toFixed(2)),
    lower2: parseFloat((vwap - 2 * stdDev).toFixed(2)),
    stdDev: parseFloat(stdDev.toFixed(2))
  };
}

// ── Support / Resistance ──────────────────────────────────────────────
function findSupportResistance(prices, lookback = 60) {
  const recent = prices.slice(-Math.min(lookback, prices.length));
  if (recent.length < 10) return { support: 0, resistance: 0 };

  // Find local highs and lows
  const highs = [], lows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i] > recent[i-1] && recent[i] > recent[i-2] &&
        recent[i] > recent[i+1] && recent[i] > recent[i+2]) {
      highs.push(recent[i]);
    }
    if (recent[i] < recent[i-1] && recent[i] < recent[i-2] &&
        recent[i] < recent[i+1] && recent[i] < recent[i+2]) {
      lows.push(recent[i]);
    }
  }

  const resistance = highs.length > 0 ? Math.max(...highs) : Math.max(...recent);
  const support    = lows.length  > 0 ? Math.min(...lows)  : Math.min(...recent);
  return { support: parseFloat(support.toFixed(2)), resistance: parseFloat(resistance.toFixed(2)) };
}

// ── Candlestick Pattern Detection ────────────────────────────────────
function detectCandlePattern(candles) {
  if (!candles || candles.length < 3) return { pattern: "none", bullish: false };
  const c  = candles[candles.length - 1]; // current
  const p  = candles[candles.length - 2]; // previous
  const pp = candles[candles.length - 3]; // 2 ago

  const cBody  = Math.abs(c.close - c.open);
  const cRange = c.high - c.low;
  const cUpper = c.high - Math.max(c.open, c.close);
  const cLower = Math.min(c.open, c.close) - c.low;

  // Hammer (bullish reversal)
  if (c.close > c.open && cLower > cBody * 2 && cUpper < cBody * 0.5) {
    return { pattern: "hammer", bullish: true, strength: 8 };
  }

  // Bullish engulfing
  if (p.close < p.open && c.close > c.open &&
      c.close > p.open && c.open < p.close) {
    return { pattern: "bullish_engulfing", bullish: true, strength: 9 };
  }

  // Morning star (3-candle)
  if (pp.close < pp.open &&                     // bearish
      Math.abs(p.close - p.open) < cBody * 0.3 && // small doji
      c.close > c.open && c.close > (pp.open + pp.close) / 2) {
    return { pattern: "morning_star", bullish: true, strength: 10 };
  }

  // Strong bullish candle (body > 70% of range)
  if (c.close > c.open && cRange > 0 && cBody / cRange > 0.7) {
    return { pattern: "strong_bull", bullish: true, strength: 7 };
  }

  // 3 consecutive green candles
  if (c.close > c.open && p.close > p.open && pp.close > pp.open) {
    return { pattern: "three_green", bullish: true, strength: 7 };
  }

  // Bearish signals
  if (c.close < c.open && cUpper > cBody * 2) {
    return { pattern: "shooting_star", bullish: false, strength: 8 };
  }

  if (c.close > c.open) return { pattern: "bullish", bullish: true, strength: 5 };
  return { pattern: "bearish", bullish: false, strength: 3 };
}

// ── Volume Analysis ───────────────────────────────────────────────────
function analyzeVolume(volumes) {
  if (volumes.length < 10) return { surge: false, ratio: 1 };
  const recent  = volumes.slice(-3).reduce((a, b) => a + b) / 3;
  const average = volumes.slice(-20, -3).reduce((a, b) => a + b) / 17;
  const ratio   = average > 0 ? recent / average : 1;
  return {
    surge: ratio > 2.0,           // 2x average = volume surge
    high:  ratio > 1.5,
    ratio: parseFloat(ratio.toFixed(2))
  };
}

// ── Main Technical Score ──────────────────────────────────────────────
function getTechnicalScore(symbol, ltp, volume, state) {
  const data    = updatePriceData(symbol, ltp, volume, Date.now());
  const prices  = data.prices;
  const volumes = data.volumes;

  if (prices.length < 20) return null;

  let score = 0;
  const signals = [];
  const warnings = [];

  // EMA alignment
  const ema9  = calcEMA(prices, 9);
  const ema21 = calcEMA(prices, 21);
  const ema50 = calcEMA(prices, 50);

  if (ema9 && ema21 && ema50) {
    if (ltp > ema9 && ema9 > ema21 && ema21 > ema50) {
      score += 20; signals.push("EMA fully aligned (9>21>50)");
    } else if (ltp > ema9 && ema9 > ema21) {
      score += 12; signals.push("EMA short-term aligned");
    } else if (ltp < ema9) {
      warnings.push("Price below EMA9");
    }
  }

  // RSI
  const rsi = calcRSI(prices);
  if (rsi !== null) {
    if (rsi > 50 && rsi < 70)      { score += 15; signals.push("RSI strong " + rsi); }
    else if (rsi >= 70 && rsi < 80){ score += 5;  signals.push("RSI high " + rsi + " — overbought"); }
    else if (rsi >= 80)            { warnings.push("RSI overbought " + rsi + " — avoid"); }
    else if (rsi < 40)             { warnings.push("RSI weak " + rsi); }
  }

  // VWAP bands
  if (state && state.vwap) {
    const bands = calcVWAPBands(prices, volumes, state.vwap);
    if (bands) {
      if (ltp > bands.vwap && ltp < bands.upper1) {
        score += 15; signals.push("Price in VWAP+1σ zone (sweet spot)");
      } else if (ltp >= bands.upper1 && ltp < bands.upper2) {
        score += 8; signals.push("Above VWAP+1σ");
      } else if (ltp >= bands.upper2) {
        warnings.push("Above VWAP+2σ — stretched");
      }
    }
  }

  // Support / Resistance
  const { support, resistance } = findSupportResistance(prices);
  const range = resistance - support;
  if (range > 0) {
    const position = (ltp - support) / range;
    if (position > 0.7 && position < 0.95) {
      score += 10; signals.push("Breaking upper range");
    } else if (position >= 0.95) {
      warnings.push("Near resistance — may reject");
    }
  }

  // Candlestick pattern
  const pattern = detectCandlePattern(state && state.candles);
  if (pattern.bullish) {
    score += pattern.strength; signals.push("Pattern: " + pattern.pattern);
  } else if (!pattern.bullish && pattern.pattern !== "none") {
    warnings.push("Bearish pattern: " + pattern.pattern);
  }

  // Volume
  const vol = analyzeVolume(volumes);
  if (vol.surge) { score += 15; signals.push("Volume surge " + vol.ratio + "x average"); }
  else if (vol.high) { score += 8; signals.push("Above average volume " + vol.ratio + "x"); }
  else { warnings.push("Low volume " + vol.ratio + "x"); }

  return {
    score: Math.min(100, score),
    signals, warnings,
    ema9, ema21, ema50,
    rsi,
    support, resistance,
    candlePattern: pattern.pattern,
    volumeRatio: vol.ratio,
    volumeSurge: vol.surge
  };
}

module.exports = { getTechnicalScore, detectCandlePattern, calcEMA, calcRSI };
