// fnoRegistry.js
// Dynamically fetches F&O eligible stocks and sector mappings from NSE.
// Replaces all hardcoded FNO_STOCKS / SECTOR_MAP / FALLBACK_WATCHLIST constants.
//
// Sources:
//   F&O lot list  → https://www.nseindia.com/api/fo-marketlot
//   Sector map    → https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500
//   Fallback list → built from the F&O lot response itself (top stocks by symbol order)

const axios = require("axios");

// ── NSE session helper ────────────────────────────────────────────────────────
const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept":     "application/json, text/plain, */*",
  "Referer":    "https://www.nseindia.com/"
};

let _nseSession   = null;
let _sessionAt    = 0;

async function getNSESession() {
  if (_nseSession && Date.now() - _sessionAt < 15 * 60 * 1000) return _nseSession;
  _nseSession = axios.create({ headers: NSE_HEADERS, timeout: 12000 });
  await _nseSession.get("https://www.nseindia.com/");
  await new Promise(r => setTimeout(r, 600));
  _sessionAt = Date.now();
  return _nseSession;
}

// ── In-memory registry ────────────────────────────────────────────────────────
const REGISTRY_TTL_MS = 4 * 60 * 60 * 1000; // refresh every 4 hours (F&O list rarely changes)

let registry = {
  fnoStocks:       new Set(), // Set<string> of clean symbols e.g. "RELIANCE"
  sectorMap:       {},        // { "RELIANCE": "Energy", ... }
  fallbackWatchlist: [],      // [{ symbol, companyName, sector, ... }]
  fetchedAt:       0
};

// ── Fetch F&O lot list from NSE ───────────────────────────────────────────────
// NSE returns an array like: [{ symbol: "RELIANCE", lotSize: 250, ... }, ...]
async function fetchFNOStocks(session) {
  const resp = await session.get(
    "https://www.nseindia.com/api/fo-marketlot",
    { timeout: 10000 }
  );

  // Response is an array of objects; each has a `symbol` key
  const rows = Array.isArray(resp.data) ? resp.data : [];

  const symbols = rows
    .map(r => (r.symbol || r.Symbol || "").trim().toUpperCase())
    .filter(Boolean);

  console.log("[fnoRegistry] F&O stocks fetched: " + symbols.length);
  return new Set(symbols);
}

// ── Fetch sector map from NSE index constituents ──────────────────────────────
// We query several sectoral indices and tag each constituent with its sector.
const SECTOR_INDICES = [
  { param: "NIFTY%20BANK",    name: "Bank"    },
  { param: "NIFTY%20IT",      name: "IT"      },
  { param: "NIFTY%20PHARMA",  name: "Pharma"  },
  { param: "NIFTY%20AUTO",    name: "Auto"    },
  { param: "NIFTY%20FMCG",    name: "FMCG"   },
  { param: "NIFTY%20METAL",   name: "Metal"   },
  { param: "NIFTY%20ENERGY",  name: "Energy"  },
  { param: "NIFTY%20REALTY",  name: "Realty"  },
  { param: "NIFTY%20INFRA",   name: "Infra"   },
  { param: "NIFTY%20MEDIA",   name: "Media"   },
  { param: "NIFTY%20PSU%20BANK", name: "PSU Bank" },
  { param: "NIFTY%20TELECOM%20SERVICES", name: "Telecom" }
];

async function fetchSectorMap(session) {
  const sectorMap = {};

  await Promise.allSettled(
    SECTOR_INDICES.map(async ({ param, name }) => {
      try {
        const resp = await session.get(
          "https://www.nseindia.com/api/equity-stockIndices?index=" + param,
          { timeout: 10000 }
        );
        const stocks = (resp.data && resp.data.data) || [];
        stocks.forEach(s => {
          const sym = (s.symbol || "").trim().toUpperCase();
          if (sym && !sectorMap[sym]) sectorMap[sym] = name; // first sector wins
        });
      } catch (e) {
        // non-fatal — partial sector map is fine
      }
    })
  );

  console.log("[fnoRegistry] Sector map built: " + Object.keys(sectorMap).length + " symbols");
  return sectorMap;
}

// ── Build fallback watchlist from live F&O list ───────────────────────────────
// Takes the first N liquid F&O stocks (by NSE's own ordering) and creates
// minimal watchlist entries so researchEngine always has something to show.
function buildFallbackWatchlist(fnoSet, sectorMap, limit = 15) {
  // NSE returns stocks roughly by market-cap prominence
  const symbols = [...fnoSet].slice(0, limit);
  return symbols.map(sym => ({
    symbol:      sym,
    companyName: sym,                               // enrichWatchlist will overwrite with real name
    sector:      sectorMap[sym] || "Other",
    tradeType:   "MOMENTUM",
    direction:   "LONG",
    confidence:  5,
    thesis:      "Top F&O liquid stock — monitoring for momentum"
  }));
}

// ── Main refresh ──────────────────────────────────────────────────────────────
async function refreshRegistry() {
  console.log("[fnoRegistry] Refreshing F&O registry from NSE...");
  try {
    const session = await getNSESession();

    const [fnoResult, sectorResult] = await Promise.allSettled([
      fetchFNOStocks(session),
      fetchSectorMap(session)
    ]);

    const fnoStocks = fnoResult.status === "fulfilled"
      ? fnoResult.value
      : registry.fnoStocks; // keep stale on error

    const sectorMap = sectorResult.status === "fulfilled"
      ? sectorResult.value
      : registry.sectorMap;

    if (fnoResult.status === "rejected") {
      console.warn("[fnoRegistry] F&O fetch failed (kept stale):", fnoResult.reason && fnoResult.reason.message);
    }
    if (sectorResult.status === "rejected") {
      console.warn("[fnoRegistry] Sector fetch failed (kept stale):", sectorResult.reason && sectorResult.reason.message);
    }

    registry = {
      fnoStocks,
      sectorMap,
      fallbackWatchlist: buildFallbackWatchlist(fnoStocks, sectorMap),
      fetchedAt: Date.now()
    };

    console.log(
      "[fnoRegistry] Done — F&O=" + fnoStocks.size +
      " sectors=" + Object.keys(sectorMap).length +
      " fallback=" + registry.fallbackWatchlist.length
    );
  } catch (e) {
    console.error("[fnoRegistry] Unexpected refresh error:", e.message);
    // registry retains its last good state
  }
}

// ── Ensure registry is loaded before first use ────────────────────────────────
let _initPromise = null;

async function ensureLoaded() {
  if (registry.fetchedAt > 0 && Date.now() - registry.fetchedAt < REGISTRY_TTL_MS) return;
  if (!_initPromise) {
    _initPromise = refreshRegistry().finally(() => { _initPromise = null; });
  }
  await _initPromise;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getFNOStocks() {
  await ensureLoaded();
  return registry.fnoStocks;
}

async function getSectorMap() {
  await ensureLoaded();
  return registry.sectorMap;
}

async function getFallbackWatchlist() {
  await ensureLoaded();
  return registry.fallbackWatchlist;
}

function isFNOStock(symbol) {
  const clean = symbol.replace(/^(NSE_EQ|BSE_EQ)\|/, "").toUpperCase();
  // If registry not yet loaded, return false safely (will be correct after load)
  return registry.fnoStocks.has(clean);
}

function getSectorForSymbol(symbol) {
  const clean = symbol.replace(/^(NSE_EQ|BSE_EQ)\|/, "").toUpperCase();
  return registry.sectorMap[clean] || "Other";
}

// Kick off a background refresh on a 4-hour schedule once this module is required
setInterval(refreshRegistry, REGISTRY_TTL_MS);

module.exports = {
  getFNOStocks,
  getSectorMap,
  getFallbackWatchlist,
  isFNOStock,          // sync — works after first load
  getSectorForSymbol,  // sync — works after first load
  ensureLoaded,
  refreshRegistry
};
