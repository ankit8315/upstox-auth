// stockIntelligence.js
// Fetches granular stock data for every AI-recommended symbol
// Combines: LTP, volume, 52w high/low, VWAP, support/resistance, OI, delivery %
// Runs every 5 min — enriches the AI watchlist with real numbers

const axios = require("axios");

// Cache per symbol: { data, fetchedAt }
const symbolCache = {};
const CACHE_TTL   = 5 * 60 * 1000;

// Upstox access token (same one used by poller — works from GCP)
function getToken() { return process.env.UPSTOX_ACCESS_TOKEN; }

// ── Fetch full quote for one symbol ──────────────────────────────────────────
async function fetchNSEQuote(symbol) {
  const now = Date.now();
  if (symbolCache[symbol] && now - symbolCache[symbol].fetchedAt < CACHE_TTL) {
    return symbolCache[symbol].data;
  }

  // ── Use Upstox full market quote — works from GCP (NSE blocks datacenter IPs) ──
  try {
    const token = getToken();
    if (!token) return { symbol, error: "No access token", fetchedAt: now };

    const instrumentKey = "NSE_EQ|" + symbol;
    const resp = await axios.get(
      "https://api.upstox.com/v2/market-quote/quotes",
      {
        headers: { "Authorization": "Bearer " + token, "Api-Version": "2" },
        params:  { instrument_key: instrumentKey },
        timeout: 8000
      }
    );

    const raw = resp.data.data || {};
    const q   = raw[instrumentKey] || raw[Object.keys(raw)[0]] || {};
    const ohlc = q.ohlc || {};

    const ltp      = q.last_price          || 0;
    const open     = ohlc.open             || ltp;
    const prevCl   = q.prev_close_price    || ltp;
    const dayHigh  = ohlc.high             || ltp;
    const dayLow   = ohlc.low              || ltp;
    const vol      = q.volume              || 0;
    const change   = ltp - prevCl;
    const changePct= prevCl > 0 ? ((change / prevCl) * 100) : 0;
    const vwap     = q.average_trade_price || 0;

    // 52w — Upstox provides these in full quote
    const high52   = q.week_52_high        || dayHigh;
    const low52    = q.week_52_low         || dayLow;

    const gapPct       = prevCl > 0 ? ((open - prevCl) / prevCl) * 100 : 0;
    const range52      = high52 - low52;
    const pos52        = range52 > 0 ? ((ltp - low52) / range52) * 100 : 50;
    const distFromHigh = high52 > 0 ? ((ltp - high52) / high52) * 100 : 0;
    const distFromLow  = low52  > 0 ? ((ltp - low52)  / low52)  * 100 : 0;
    const aboveVWAP    = vwap > 0 ? ltp > vwap : null;
    const vwapDiff     = vwap > 0 ? ((ltp - vwap) / vwap) * 100 : 0;

    const r1 = parseFloat((dayHigh * 1.003).toFixed(2));
    const r2 = parseFloat((high52  * 0.99 ).toFixed(2));
    const s1 = parseFloat((dayLow  * 0.997).toFixed(2));
    const s2 = parseFloat((low52   * 1.01 ).toFixed(2));

    const data = {
      symbol,
      companyName:     q.company_name || symbol,
      sector:          "",
      ltp,
      open,
      prevClose:       prevCl,
      change:          parseFloat(change.toFixed(2)),
      changePct:       parseFloat(changePct.toFixed(2)),
      dayHigh,
      dayLow,
      vwap,
      aboveVWAP,
      vwapDiffPct:     parseFloat(vwapDiff.toFixed(2)),
      volume:          vol,
      volumeLakh:      parseFloat((vol / 100000).toFixed(1)),
      high52,
      low52,
      pos52wPct:       parseFloat(pos52.toFixed(1)),
      distFromHighPct: parseFloat(distFromHigh.toFixed(2)),
      distFromLowPct:  parseFloat(distFromLow.toFixed(2)),
      gapPct:          parseFloat(gapPct.toFixed(2)),
      isGapUp:         gapPct > 0.3,
      isGapDown:       gapPct < -0.3,
      near52wHigh:     distFromHigh > -2,
      near52wLow:      distFromLow  < 5,
      at52wHigh:       distFromHigh > -0.5,
      support:         { s1, s2 },
      resistance:      { r1, r2 },
      fetchedAt:       now
    };

    symbolCache[symbol] = { data, fetchedAt: now };
    return data;

  } catch (e) {
    // 401 = Upstox token expired (daily token, needs manual refresh in .env)
    // 429 = rate limited — both are expected, log once per symbol not every cycle
    if (e.response && e.response.status === 401) {
      // Only log once per hour per 401 — don't spam
      if (!stockIntelligence._401warned || Date.now() - stockIntelligence._401warned > 60*60*1000) {
        console.error("[stockIntelligence] Upstox token expired (401) — update UPSTOX_ACCESS_TOKEN in .env");
        stockIntelligence._401warned = Date.now();
      }
    } else {
      console.error("Quote fetch failed for " + symbol + ":", e.message);
    }
    return { symbol, error: e.message, fetchedAt: Date.now() };
  }
}

const stockIntelligence = { _401warned: 0 };

// ── Fetch F&O OI data — NSE option chain blocked from GCP, skip gracefully ────
async function fetchOIData(symbol) {
  return null; // NSE option chain API not reachable from GCP datacenter IPs
}

// ── Fetch delivery data — NSE bhav copy blocked from GCP, skip gracefully ────
async function fetchDeliveryData(symbol) {
  return null; // NSE delivery API not reachable from GCP datacenter IPs
}

// ── Volume ratio — NSE historical blocked from GCP, skip gracefully ──────────
async function fetchVolumeRatio(symbol) {
  return null; // NSE historical API not reachable from GCP datacenter IPs
}

// ── Main: enrich entire watchlist with real data ──────────────────────────────
async function enrichWatchlist(watchlistItems) {
  if (!watchlistItems || watchlistItems.length === 0) return [];

  console.log("Enriching " + watchlistItems.length + " watchlist symbols with live data...");

  const enriched = await Promise.all(watchlistItems.map(async item => {
    const symbol = item.symbol;
    try {
      // Fetch all data in parallel per symbol
      const [quote, oi, delivery, volume] = await Promise.allSettled([
        fetchNSEQuote(symbol),
        fetchOIData(symbol),
        fetchDeliveryData(symbol),
        fetchVolumeRatio(symbol)
      ]);

      const q = quote.status    === "fulfilled" ? quote.value    : null;
      const o = oi.status       === "fulfilled" ? oi.value       : null;
      const d = delivery.status === "fulfilled" ? delivery.value : null;
      const v = volume.status   === "fulfilled" ? volume.value   : null;

      // Compute screener signals
      const signals = [];
      if (v && v.isVolumeShock)    signals.push({ type: "VOL_SHOCK",    label: v.volumeLabel + " avg vol",   urgency: "HIGH"   });
      if (q && q.at52wHigh)        signals.push({ type: "52W_BREAKOUT", label: "52W HIGH BREAKOUT",           urgency: "HIGH"   });
      if (q && q.near52wHigh)      signals.push({ type: "NEAR_52W_HIGH",label: "Near 52W high",               urgency: "MEDIUM" });
      if (q && q.isGapUp)          signals.push({ type: "GAP_UP",       label: "Gap up " + q.gapPct.toFixed(1) + "%", urgency: "HIGH" });
      if (q && q.isGapDown)        signals.push({ type: "GAP_DOWN",     label: "Gap down " + Math.abs(q.gapPct).toFixed(1) + "%", urgency: "HIGH" });
      if (d && d.deliverySpike)    signals.push({ type: "DEL_SPIKE",    label: d.deliverySpikeRatio + "x delivery (inst.)", urgency: "MEDIUM" });
      if (o && o.pcrSignal === "BULLISH") signals.push({ type: "OI_BULL", label: "PCR " + o.pcr + " (bullish OI)", urgency: "MEDIUM" });
      if (o && o.pcrSignal === "BEARISH") signals.push({ type: "OI_BEAR", label: "PCR " + o.pcr + " (bearish OI)", urgency: "MEDIUM" });
      if (q && q.aboveVWAP)        signals.push({ type: "ABOVE_VWAP",   label: "Above VWAP +" + q.vwapDiffPct + "%", urgency: "LOW" });
      if (q && !q.aboveVWAP && q.vwap > 0) signals.push({ type: "BELOW_VWAP", label: "Below VWAP " + q.vwapDiffPct + "%", urgency: "LOW" });

      // Compute overall conviction score (0-100)
      let conviction = (item.confidence || 5) * 8; // AI confidence base (max 80)
      if (v && v.volumeRatio >= 10) conviction += 20;
      else if (v && v.volumeRatio >= 3) conviction += 12;
      else if (v && v.volumeRatio >= 1.5) conviction += 6;
      if (q && q.at52wHigh)    conviction += 15;
      if (q && q.near52wHigh)  conviction += 8;
      if (q && q.aboveVWAP)    conviction += 8;
      if (d && d.deliverySpike)conviction += 10;
      if (o && o.pcrSignal === "BULLISH" && item.direction !== "SHORT") conviction += 8;
      if (o && o.pcrSignal === "BEARISH" && item.direction === "SHORT")  conviction += 8;
      conviction = Math.min(100, Math.round(conviction));

      // Traffic light
      const trafficLight = conviction >= 75 ? "GREEN"
                         : conviction >= 50 ? "AMBER"
                         : "RED";

      return {
        ...item,
        liveData: q,
        oiData:   o,
        deliveryData: d,
        volumeData: v,
        signals,
        conviction,
        trafficLight,
        enrichedAt: new Date().toISOString()
      };

    } catch (e) {
      console.error("Enrich failed for " + symbol + ":", e.message);
      return { ...item, signals: [], conviction: (item.confidence || 5) * 8, trafficLight: "AMBER" };
    }
  }));

  // Sort by conviction descending
  enriched.sort((a, b) => b.conviction - a.conviction);

  console.log("Enrichment done. Top pick: " + (enriched[0] || {}).symbol + " conviction=" + (enriched[0] || {}).conviction);
  return enriched;
}

module.exports = { enrichWatchlist, fetchNSEQuote, fetchVolumeRatio };
