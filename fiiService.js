// fiiService.js — Fetches FII/DII activity from NSE India
// NSE provides free public data — no API key needed
// Also tracks SGX Nifty (now Gift Nifty) as pre-market indicator

const axios = require("axios");

let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000;

const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/"
};

async function fetchFIIDII() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data;

  let fiidii = null;

  // Try NSE India FII/DII data
  try {
    const session = axios.create({ headers: NSE_HEADERS, timeout: 10000 });
    // First hit NSE homepage to get cookies
    await session.get("https://www.nseindia.com/");
    await new Promise(r => setTimeout(r, 1000));
    const resp = await session.get("https://www.nseindia.com/api/fiidiiTradeReact");
    const raw = resp.data;
    if (raw && raw.length > 0) {
      const today = raw[0];
      fiidii = {
        date:         today.date || new Date().toDateString(),
        fii: {
          buyValue:   parseFloat(today.fii_buy_value  || 0),
          sellValue:  parseFloat(today.fii_sell_value || 0),
          netValue:   parseFloat(today.fii_net_value  || 0),
          sentiment:  parseFloat(today.fii_net_value  || 0) > 0 ? "BUYING" : "SELLING"
        },
        dii: {
          buyValue:   parseFloat(today.dii_buy_value  || 0),
          sellValue:  parseFloat(today.dii_sell_value || 0),
          netValue:   parseFloat(today.dii_net_value  || 0),
          sentiment:  parseFloat(today.dii_net_value  || 0) > 0 ? "BUYING" : "SELLING"
        },
        // Last 5 days rolling
        history:      raw.slice(0, 5).map(d => ({
          date:       d.date,
          fiiNet:     parseFloat(d.fii_net_value || 0),
          diiNet:     parseFloat(d.dii_net_value || 0)
        }))
      };
    }
  } catch (e) {
    console.error("NSE FII/DII error:", e.message);
  }

  // Fallback: estimated data with market signal
  if (!fiidii) {
    fiidii = {
      date:    new Date().toDateString(),
      fii:     { buyValue: 0, sellValue: 0, netValue: 0, sentiment: "UNKNOWN" },
      dii:     { buyValue: 0, sellValue: 0, netValue: 0, sentiment: "UNKNOWN" },
      history: [],
      note:    "NSE data temporarily unavailable"
    };
  }

  // Derive overall smart money signal
  const fiiNet = fiidii.fii.netValue;
  const diiNet = fiidii.dii.netValue;
  const combined = fiiNet + diiNet;

  fiidii.smartMoneySignal = combined > 500
    ? { signal: "STRONG_BUY",  label: "Smart money buying hard",    color: "green" }
    : combined > 0
    ? { signal: "BUY",         label: "Smart money net positive",   color: "green" }
    : combined > -500
    ? { signal: "SELL",        label: "Smart money net negative",   color: "red"   }
    : { signal: "STRONG_SELL", label: "Smart money selling hard",   color: "red"   };

  // 5-day FII trend
  if (fiidii.history.length >= 3) {
    const fiiTrend = fiidii.history.slice(0, 3).reduce((s, d) => s + d.fiiNet, 0);
    fiidii.fii3DayTrend = fiiTrend > 0 ? "NET_BUYER_3D" : "NET_SELLER_3D";
  }

  cache = { data: fiidii, fetchedAt: now };
  console.log("FII/DII: FII=" + fiidii.fii.netValue + " DII=" + fiidii.dii.netValue);
  return fiidii;
}

// Gift Nifty (pre-market Nifty futures — indicator of next day open)
async function fetchGiftNifty() {
  try {
    // NSE Gift Nifty data
    const resp = await axios.get(
      "https://ifsca.gov.in/api/gift-nifty", // placeholder — use actual endpoint
      { timeout: 5000 }
    );
    return resp.data;
  } catch (e) {
    // Fallback: derive from SGX data or return null
    return null;
  }
}

module.exports = { fetchFIIDII, fetchGiftNifty };
