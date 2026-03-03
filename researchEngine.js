// researchEngine.js — Orchestrates all research services
// Runs every 5 minutes always (market open or closed)
// Exposes data via global.researchData
//
// FIX 1: Pipeline no longer blocked when newsData is empty.
//         AI research runs regardless; watchlist enrichment falls back
//         to top F&O liquid stocks so the Watchlist tab always shows data.
// FIX 2: tradeCalls result is normalised to always be an object with a
//         .calls array, fixing "No trades today" when AI returns [] on error.

const { fetchNews }           = require("./newsService");
const { fetchFIIDII }         = require("./fiiService");
const { fetchSectors }        = require("./sectorService");
const { generateResearch, getMarketPhase } = require("./aiResearcher");
const { enrichWatchlist }     = require("./stockIntelligence");
const { generateTradeCalls, checkTheses } = require("./traderBrain");
const { getFallbackWatchlist } = require("./fnoRegistry");
const { refreshAll: refreshNewsEngine, symbolNews } = require("./newsEngine");

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Global research state
global.researchData = {
  news:              [],
  fiidii:            null,
  sectors:           null,
  aiReport:          null,
  enrichedWatchlist: [],
  tradeCalls:        null,
  thesisUpdates:     null,
  lastUpdate:        null,
  isRefreshing:      false
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMarketOpen() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const d = now.getDay(), h = now.getHours(), m = now.getMinutes();
  if (d === 0 || d === 6) return false;
  if (h < 9 || (h === 9 && m < 15)) return false;
  if (h > 15 || (h === 15 && m > 35)) return false;
  return true;
}

// Normalise whatever generateTradeCalls returns into { calls[], ... }
function normaliseTradeCalls(raw) {
  if (!raw) return { calls: [], traderMindset: "", marketRead: {} };
  // It returned a proper result object
  if (typeof raw === "object" && !Array.isArray(raw) && raw.calls) return raw;
  // It returned an array directly (shouldn't happen but guard anyway)
  if (Array.isArray(raw)) return { calls: raw, traderMindset: "", marketRead: {} };
  return { calls: [], traderMindset: "", marketRead: {} };
}

// ── Main refresh ──────────────────────────────────────────────────────────────

async function refreshResearch() {
  if (global.researchData.isRefreshing) return;
  global.researchData.isRefreshing = true;

  const start = Date.now();
  console.log("[Research] Refresh started...");

  try {
    // ── Step 1: Fetch all data sources in parallel ────────────────────────────
    const [newsResult, fiidiiResult, sectorsResult] = await Promise.allSettled([
      fetchNews(),
      fetchFIIDII(),
      fetchSectors()
    ]);

    const newsData    = newsResult.status    === "fulfilled" ? (newsResult.value    || []) : [];
    const fiidiiData  = fiidiiResult.status  === "fulfilled" ? (fiidiiResult.value  || {}) : {};
    const sectorsData = sectorsResult.status === "fulfilled" ? (sectorsResult.value || { sectors: [], breadth: {} }) : { sectors: [], breadth: {} };

    if (newsResult.status    === "rejected") console.warn("[Research] News fetch failed:", newsResult.reason && newsResult.reason.message);
    if (fiidiiResult.status  === "rejected") console.warn("[Research] FII fetch failed:",  fiidiiResult.reason && fiidiiResult.reason.message);
    if (sectorsResult.status === "rejected") console.warn("[Research] Sectors fetch failed:", sectorsResult.reason && sectorsResult.reason.message);

    global.researchData.news    = newsData;
    global.researchData.fiidii  = fiidiiData;
    global.researchData.sectors = sectorsData;

    console.log("[Research] Data fetched: news=" + newsData.length + " sectors=" + (sectorsData.sectors || []).length);

    // ── Step 2: AI deep research ──────────────────────────────────────────────
    // Works in ALL market phases — overnight, pre-market, and intraday.
    // Overnight: does tomorrow's homework using news + FII + earnings calendar.
    // Intraday:  live causal chain analysis with sector data.
    const marketPhase = getMarketPhase();
    console.log("[Research] Market phase: " + marketPhase);

    // Collect upcoming earnings/board meetings from newsEngine symbol store
    const upcomingEarnings = Object.entries(symbolNews || {})
      .flatMap(([sym, events]) =>
        (events || [])
          .filter(e => e.type === "board_meeting")
          .map(e => ({ symbol: sym.replace("NSE_EQ|", ""), purpose: e.purpose, date: e.meetingDate }))
      )
      .slice(0, 20);

    try {
      const aiReport = await generateResearch(newsData, fiidiiData, sectorsData, upcomingEarnings);
      if (aiReport) {
        global.researchData.aiReport = aiReport;
        console.log(
          "[Research] AI done (" + (aiReport.mode || marketPhase) + "): bias=" + ((aiReport.marketOutlook || {}).bias || "?") +
          " watchlist=" + (aiReport.watchlist || []).length +
          " chains=" + (aiReport.causalChains || []).length
        );
      } else {
        console.warn("[Research] AI returned null — will use fallback watchlist");
      }
    } catch (e) {
      console.error("[Research] AI research error (non-fatal):", e.message);
    }

    // ── Step 3: Decide which watchlist to enrich ──────────────────────────────
    // Priority: AI watchlist → fallback F&O list
    // This guarantees enrichedWatchlist is NEVER empty after the first run.
    const aiWatchlist = global.researchData.aiReport &&
                        Array.isArray(global.researchData.aiReport.watchlist) &&
                        global.researchData.aiReport.watchlist.length > 0
      ? global.researchData.aiReport.watchlist
      : null;

    const usingFallback = !aiWatchlist;
    const dynamicFallback = usingFallback ? await getFallbackWatchlist() : null;
    const watchlistToEnrich = aiWatchlist || dynamicFallback;

    if (usingFallback) {
      console.log("[Research] Using fallback watchlist (" + (dynamicFallback || []).length + " F&O stocks from NSE)");
    }

    // ── Step 4: Enrich watchlist with live NSE data ───────────────────────────
    try {
      const enriched = await enrichWatchlist(watchlistToEnrich);
      if (enriched && enriched.length > 0) {
        global.researchData.enrichedWatchlist = enriched;
        console.log("[Research] Enriched " + enriched.length + " stocks | Top: " +
          (enriched[0] || {}).symbol + " conviction=" + (enriched[0] || {}).conviction);
      } else {
        // enrichWatchlist returned [] — keep existing enrichedWatchlist if we have it
        if (global.researchData.enrichedWatchlist.length === 0) {
          // First run, nothing yet — set minimal stubs so iOS never sees empty
          global.researchData.enrichedWatchlist = watchlistToEnrich.map(w => ({
            ...w,
            signals: [], conviction: (w.confidence || 5) * 8, trafficLight: "AMBER"
          }));
          console.warn("[Research] Enrichment returned empty — using stub entries");
        }
      }
    } catch (e) {
      console.error("[Research] Enrichment error (non-fatal):", e.message);
      // On error keep whatever we already have; don't wipe it
    }

    // ── Step 5: TraderBrain — generate exact trade calls ──────────────────────
    // Runs as long as we have enriched stocks (even fallback stubs).
    // BUG FIX: result is normalised via normaliseTradeCalls() so .calls always
    //          exists and the iOS "No trades today" guard works correctly.
    const enriched = global.researchData.enrichedWatchlist;
    if (enriched && enriched.length > 0) {
      try {
        const openPositions = require("./riskEngine").getOpenPositions();
        const todayPnL      = require("./riskEngine").getTodayPnL();
        const marketContext = global.niftyContext || null;

        const rawCalls   = await generateTradeCalls(enriched, marketContext, openPositions, todayPnL);
        const tradeCalls = normaliseTradeCalls(rawCalls);

        // Only replace if we actually got calls (preserve stale good data otherwise)
        if (tradeCalls.calls && tradeCalls.calls.length > 0) {
          global.researchData.tradeCalls = tradeCalls;
          console.log("[Research] TraderBrain: " + tradeCalls.calls.length + " calls generated");
        } else {
          // AI returned 0 calls — keep previous if exists, else store the empty object
          // so the iOS app at least gets traderMindset / marketRead
          if (!global.researchData.tradeCalls) {
            global.researchData.tradeCalls = tradeCalls;
          }
          console.log("[Research] TraderBrain: 0 calls (market conditions or after-hours)");
        }

        // ── Step 6: 5-min thesis check (only during market hours) ─────────────
        const tc = global.researchData.tradeCalls;
        if (isMarketOpen() && tc && tc.calls && tc.calls.length > 0) {
          try {
            const activeCalls   = tc.calls.filter(c => c.urgency === "NOW" || c.enteredAt);
            const currentPrices = global.currentPrices || {};
            if (activeCalls.length > 0) {
              const thesisUpdates = await checkTheses(activeCalls, currentPrices, marketContext);
              global.researchData.thesisUpdates = thesisUpdates;
            }
          } catch (e) {
            console.error("[Research] Thesis check error (non-fatal):", e.message);
          }
        }
      } catch (e) {
        console.error("[Research] TraderBrain error (non-fatal):", e.message);
      }
    }

    global.researchData.lastUpdate = new Date().toISOString();
    console.log("[Research] Done in " + (Date.now() - start) + "ms" +
      " | news=" + newsData.length +
      " | watchlist=" + (global.researchData.enrichedWatchlist || []).length +
      " | calls="     + ((global.researchData.tradeCalls || {}).calls || []).length);

  } catch (e) {
    console.error("[Research] Unexpected error:", e.message);
  } finally {
    global.researchData.isRefreshing = false;
  }
}

function startResearchEngine() {
  console.log("[Research] Engine started — refreshing every 5 min");
  refreshResearch(); // immediate first run
  setInterval(refreshResearch, REFRESH_INTERVAL_MS);
}

module.exports = { startResearchEngine, refreshResearch };
