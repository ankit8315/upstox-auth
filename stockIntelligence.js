// stockIntelligence.js
// Fetches granular stock data for every AI-recommended symbol
// Combines: LTP, volume, 52w high/low, VWAP, support/resistance, OI, delivery %
// Runs every 5 min — enriches the AI watchlist with real numbers

const axios = require("axios");

const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/"
};

// Cache per symbol: { data, fetchedAt }
const symbolCache = {};
const CACHE_TTL   = 5 * 60 * 1000;

// NSE session (reuse cookies)
let nseSession = null;
let sessionAt  = 0;

async function getNSESession() {
  if (nseSession && Date.now() - sessionAt < 15 * 60 * 1000) return nseSession;
  nseSession = axios.create({ headers: NSE_HEADERS, timeout: 12000 });
  await nseSession.get("https://www.nseindia.com/");
  await new Promise(r => setTimeout(r, 800));
  sessionAt = Date.now();
  return nseSession;
}

// ── Fetch full quote for one symbol ──────────────────────────────────────────
async function fetchUpstoxFullQuote(symbol) {
  const key = "NSE_EQ|" + symbol;

  // 1. Check poller's bulk-fetched cache first (fastest, no extra API call)
  if (global.upstoxFullQuotes && global.upstoxFullQuotes[key]) {
    const d = global.upstoxFullQuotes[key];
    if (d.last_price) {
      return parseUpstoxQuote(d);
    }
  }

  // 2. Individual fetch using token from env or global
  const token = process.env.UPSTOX_ACCESS_TOKEN || global.accessToken;
  if (!token) return null;
  try {
    const r = await axios.get("https://api.upstox.com/v2/market-quote/quotes", {
      headers: { Authorization: "Bearer " + token, "Api-Version": "2" },
      params:  { instrument_key: key },
      timeout: 8000
    });
    const d = (r.data.data || {})[key] || {};
    if (!d.last_price) return null;
    const result = parseUpstoxQuote(d);
    symbolCache[symbol] = { data: result, fetchedAt: Date.now() };
    return result;
  } catch (e) {
    return null;
  }
}

function parseUpstoxQuote(d) {
    const ohlc    = d.ohlc || {};
    const d52     = d["52_week"] || {};
    const ltp     = d.last_price || 0;
    const open    = ohlc.open    || ltp;
    const prevCl  = ohlc.close   || ltp;
    const high52  = d52.high     || 0;
    const low52   = d52.low      || 0;
    const vol     = d.volume     || 0;
    const vwap    = d.average_trade_price || 0;
    const change  = ltp - prevCl;
    const changePct = prevCl > 0 ? ((change / prevCl) * 100) : 0;
    const dayHigh = ohlc.high || ltp;
    const dayLow  = ohlc.low  || ltp;
    const range52 = high52 - low52;
    const pos52   = range52 > 0 ? ((ltp - low52) / range52) * 100 : 50;
    const distFromHigh = high52 > 0 ? ((ltp - high52) / high52) * 100 : 0;
    const distFromLow  = low52  > 0 ? ((ltp - low52)  / low52)  * 100 : 0;
    const aboveVWAP    = vwap > 0 ? ltp > vwap : null;
    const vwapDiff     = vwap > 0 ? ((ltp - vwap) / vwap) * 100 : 0;
    const gapPct       = open > 0 && prevCl > 0 ? ((open - prevCl) / prevCl) * 100 : 0;
    const isGapUp      = gapPct >  0.5;
    const isGapDown    = gapPct < -0.5;
    const near52wHigh  = high52 > 0 && distFromHigh > -3 && distFromHigh <= 0;
    const at52wHigh    = high52 > 0 && distFromHigh >= -0.5;
    return {
      ltp, open, prevClose: prevCl, change: parseFloat(change.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(2)),
      dayHigh, dayLow, vwap, aboveVWAP, vwapDiffPct: parseFloat(vwapDiff.toFixed(2)),
      volume: vol, volumeLakh: parseFloat((vol / 100000).toFixed(2)),
      high52, low52, pos52wPct: parseFloat(pos52.toFixed(1)),
      distFromHighPct: parseFloat(distFromHigh.toFixed(2)),
      distFromLowPct:  parseFloat(distFromLow.toFixed(2)),
      gapPct: parseFloat(gapPct.toFixed(2)), isGapUp, isGapDown,
      near52wHigh, at52wHigh,
      support: { s1: dayLow, s2: low52 },
      resistance: { r1: dayHigh, r2: high52 }
    };
}

async function fetchNSEQuote(symbol) {
  const now = Date.now();
  if (symbolCache[symbol] && now - symbolCache[symbol].fetchedAt < CACHE_TTL) {
    return symbolCache[symbol].data;
  }

  // Try Upstox first (reliable on GCP — NSE blocks cloud IPs)
  const upstox = await fetchUpstoxFullQuote(symbol);
  if (upstox) return upstox;

  // Fallback: NSE direct (works only when not blocked)
  try {
    const session = await getNSESession();
    const resp    = await session.get(
      "https://www.nseindia.com/api/quote-equity?symbol=" + encodeURIComponent(symbol),
      { timeout: 8000 }
    );
    const raw  = resp.data;
    const info = raw.info        || {};
    const pd   = raw.priceInfo   || {};
    const ind  = raw.industryInfo|| {};
    const sec  = raw.securityInfo|| {};

    // 52w support/resistance (use 52w low as support, 52w high as resistance)
    const high52  = pd.weekHighLow ? pd.weekHighLow.max : 0;
    const low52   = pd.weekHighLow ? pd.weekHighLow.min : 0;
    const ltp     = pd.lastPrice   || 0;
    const open    = pd.open        || ltp;
    const prevCl  = pd.previousClose || ltp;
    const change  = pd.change      || 0;
    const changePct = pd.pChange   || 0;

    // Dynamic support/resistance from intraday high/low + 52w levels
    const dayHigh = pd.intraDayHighLow ? pd.intraDayHighLow.max : ltp;
    const dayLow  = pd.intraDayHighLow ? pd.intraDayHighLow.min : ltp;
    const vwap    = pd.vwap || 0;

    // Volume data
    const vol     = pd.totalTradedVolume || 0;
    const volLakh = (vol / 100000).toFixed(1);

    // Gap calculation
    const gapPct  = prevCl > 0 ? ((open - prevCl) / prevCl) * 100 : 0;

    // 52w position
    const range52 = high52 - low52;
    const pos52   = range52 > 0 ? ((ltp - low52) / range52) * 100 : 50;

    // Distance from 52w high/low
    const distFromHigh = high52 > 0 ? ((ltp - high52) / high52) * 100 : 0;
    const distFromLow  = low52  > 0 ? ((ltp - low52)  / low52)  * 100 : 0;

    // VWAP position
    const aboveVWAP = vwap > 0 ? ltp > vwap : null;
    const vwapDiff  = vwap > 0 ? ((ltp - vwap) / vwap) * 100 : 0;

    // Key levels (simplified support/resistance)
    const r1 = parseFloat((dayHigh * 1.003).toFixed(2));
    const r2 = parseFloat((high52  * 0.99 ).toFixed(2)); // just below 52w high = resistance
    const s1 = parseFloat((dayLow  * 0.997).toFixed(2));
    const s2 = parseFloat((low52   * 1.01 ).toFixed(2)); // just above 52w low = support

    const data = {
      symbol,
      companyName:  info.companyName || symbol,
      sector:       ind.basicIndustry || ind.industry || "",
      isin:         info.isin || "",
      ltp,
      open,
      prevClose:    prevCl,
      change,
      changePct,
      dayHigh,
      dayLow,
      vwap,
      aboveVWAP,
      vwapDiffPct:  parseFloat(vwapDiff.toFixed(2)),
      volume:       vol,
      volumeLakh:   parseFloat(volLakh),
      high52,
      low52,
      pos52wPct:    parseFloat(pos52.toFixed(1)),
      distFromHighPct: parseFloat(distFromHigh.toFixed(2)),
      distFromLowPct:  parseFloat(distFromLow.toFixed(2)),
      gapPct:       parseFloat(gapPct.toFixed(2)),
      isGapUp:      gapPct > 0.3,
      isGapDown:    gapPct < -0.3,
      near52wHigh:  distFromHigh > -2,   // within 2% of 52w high
      near52wLow:   distFromLow  < 5,    // within 5% of 52w low
      at52wHigh:    distFromHigh > -0.5, // at/above 52w high = breakout
      support: { s1, s2 },
      resistance: { r1, r2 },
      fetchedAt: now
    };

    symbolCache[symbol] = { data, fetchedAt: now };
    return data;

  } catch (e) {
    console.error("Quote fetch failed for " + symbol + ":", e.message);
    return { symbol, error: e.message, fetchedAt: Date.now() };
  }
}

// ── Fetch F&O OI data ─────────────────────────────────────────────────────────
async function fetchOIData(symbol) {
  try {
    const session = await getNSESession();
    const resp    = await session.get(
      "https://www.nseindia.com/api/option-chain-equities?symbol=" + encodeURIComponent(symbol),
      { timeout: 8000 }
    );
    const data = resp.data;
    if (!data || !data.records) return null;

    const records = data.records.data || [];
    let totalCallOI = 0, totalPutOI = 0;
    let maxCallOI = 0, maxPutOI = 0;
    let maxCallStrike = 0, maxPutStrike = 0;

    records.forEach(r => {
      if (r.CE) {
        totalCallOI += r.CE.openInterest || 0;
        if ((r.CE.openInterest || 0) > maxCallOI) {
          maxCallOI = r.CE.openInterest;
          maxCallStrike = r.strikePrice;
        }
      }
      if (r.PE) {
        totalPutOI += r.PE.openInterest || 0;
        if ((r.PE.openInterest || 0) > maxPutOI) {
          maxPutOI = r.PE.openInterest;
          maxPutStrike = r.strikePrice;
        }
      }
    });

    const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI) : 0;

    return {
      totalCallOI,
      totalPutOI,
      pcr:           parseFloat(pcr.toFixed(2)),
      pcrSignal:     pcr > 1.2 ? "BULLISH" : pcr < 0.8 ? "BEARISH" : "NEUTRAL",
      maxCallStrike, // key resistance (max call pain)
      maxPutStrike,  // key support (max put pain)
      maxPainLevel:  Math.round((maxCallStrike + maxPutStrike) / 2)
    };
  } catch (e) {
    return null; // F&O data optional
  }
}

// ── Fetch delivery/volume data from NSE bhav copy ────────────────────────────
async function fetchDeliveryData(symbol) {
  try {
    const session = await getNSESession();
    const resp    = await session.get(
      "https://www.nseindia.com/api/historical/securityArchives?from=01-01-2024&to=01-01-2024&symbol=" + encodeURIComponent(symbol) + "&dataType=priceVolumeDeliverable&series=EQ",
      { timeout: 8000 }
    );
    const data = resp.data && resp.data.data;
    if (!data || data.length === 0) return null;

    const latest = data[0];
    const delivQty  = parseFloat(latest.CH_DELIV_QTY  || 0);
    const tradedQty = parseFloat(latest.CH_TOT_TRDQTY  || 1);
    const delivPct  = tradedQty > 0 ? (delivQty / tradedQty) * 100 : 0;

    // Average delivery over 5 days
    const avg5dDel = data.slice(0, 5).reduce((s, d) => {
      const dq = parseFloat(d.CH_DELIV_QTY  || 0);
      const tq = parseFloat(d.CH_TOT_TRDQTY  || 1);
      return s + (tq > 0 ? (dq / tq) * 100 : 0);
    }, 0) / Math.min(data.length, 5);

    return {
      deliveryPct:        parseFloat(delivPct.toFixed(1)),
      avg5dDeliveryPct:   parseFloat(avg5dDel.toFixed(1)),
      deliverySpike:      delivPct > avg5dDel * 1.5,  // 50% above avg = institutional buying
      deliverySpikeRatio: parseFloat((delivPct / (avg5dDel || 1)).toFixed(1))
    };
  } catch (e) {
    return null;
  }
}

// ── Volume shocker detection ──────────────────────────────────────────────────
// Compares today's volume to 20-day average
async function fetchVolumeRatio(symbol) {
  try {
    const session = await getNSESession();
    // Get 20-day historical
    const today = new Date();
    const past  = new Date(today - 30 * 24 * 60 * 60 * 1000);
    const fmt   = d => d.toLocaleDateString("en-GB").split("/").join("-"); // dd-mm-yyyy

    const resp = await session.get(
      "https://www.nseindia.com/api/historical/securityArchives?from=" + fmt(past) +
      "&to=" + fmt(today) + "&symbol=" + encodeURIComponent(symbol) +
      "&dataType=priceVolumeDeliverable&series=EQ",
      { timeout: 8000 }
    );
    const data = resp.data && resp.data.data;
    if (!data || data.length < 5) return null;

    const avg20Vol = data.slice(1, 21).reduce((s, d) =>
      s + parseFloat(d.CH_TOT_TRDQTY || 0), 0) / Math.min(data.length - 1, 20);

    const todayVol = parseFloat(data[0].CH_TOT_TRDQTY || 0);
    const ratio    = avg20Vol > 0 ? todayVol / avg20Vol : 1;

    return {
      todayVolume:   todayVol,
      avg20dVolume:  parseFloat(avg20Vol.toFixed(0)),
      volumeRatio:   parseFloat(ratio.toFixed(1)),
      isVolumeShock: ratio >= 3,       // 3x+ = volume shocker
      isHighVolume:  ratio >= 1.5,     // 1.5x+ = above average
      volumeLabel:   ratio >= 10 ? "🔥 " + ratio.toFixed(0) + "x"
                   : ratio >= 3  ? "⚡ " + ratio.toFixed(1) + "x"
                   : ratio >= 1.5? "↑ " + ratio.toFixed(1) + "x"
                   : ratio.toFixed(1) + "x"
    };
  } catch (e) {
    return null;
  }
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