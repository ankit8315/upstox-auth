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

// Smart refresh schedule — not a fixed 5-min timer
// Overnight: runs once per hour (AI does homework, no need to redo every 5 min)
// Intraday:  runs every 15 min (price action meaningful at that cadence)
// News spike: immediate re-run triggered by newsEngine if major headline breaks
const REFRESH_INTERVAL_INTRADAY_MS  = 15 * 60 * 1000;  // 15 min
const REFRESH_INTERVAL_OVERNIGHT_MS = 60 * 60 * 1000;  // 60 min
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // kept for compatibility

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

    // ── Step 3 & 4: Build enriched watchlist ─────────────────────────────────
    // OVERNIGHT / PRE-MARKET: skip live price fetch (Upstox quotes only work during
    // market hours). Attach the full AI research context to each watchlist item so
    // traderBrain can reason with news + causal chains + sector data instead of prices.
    //
    // INTRADAY: enrich with live Upstox quotes as before.

    const aiWatchlist = global.researchData.aiReport &&
                        Array.isArray(global.researchData.aiReport.watchlist) &&
                        global.researchData.aiReport.watchlist.length > 0
      ? global.researchData.aiReport.watchlist
      : null;

    if (!aiWatchlist) {
      // AI hasn't produced a watchlist yet (429 cooldown or first boot)
      // Check if all providers are still in backoff — if so, log once and skip
      const { providerBackoff } = require("./aiResearcher");
      const now = Date.now();
      const allBacked = providerBackoff &&
        Object.values(providerBackoff).every(t => t > now);
      if (allBacked) {
        const earliest = Math.min(...Object.values(providerBackoff));
        const minLeft  = Math.round((earliest - now) / 60000);
        console.log("[Research] All AI providers in cooldown — retrying in ~" + minLeft + " min. Skipping cycle.");
      } else {
        console.log("[Research] AI watchlist not ready yet — waiting for AI to complete analysis");
      }
      global.researchData.enrichedWatchlist = [];
      global.researchData.lastUpdate = new Date().toISOString();
      return;
    }

    const watchlistSource = aiWatchlist;

    if (marketPhase === "INTRADAY") {
      // During market hours: enrich with live Upstox quotes
      try {
        const enriched = await enrichWatchlist(watchlistSource);
        if (enriched && enriched.length > 0) {
          global.researchData.enrichedWatchlist = enriched;
          console.log("[Research] Enriched " + enriched.length + " stocks with live data");
        } else if (global.researchData.enrichedWatchlist.length === 0) {
          global.researchData.enrichedWatchlist = watchlistSource.map(w => ({
            ...w, signals: [], conviction: (w.confidence || 5) * 8, trafficLight: "AMBER"
          }));
        }
      } catch (e) {
        console.error("[Research] Enrichment error:", e.message);
      }
    } else {
      // OVERNIGHT / PRE-MARKET: attach AI research context to each stock so
      // traderBrain has causal chains, sector data, and news to reason from.
      // No live prices needed — AI will use its knowledge of NSE price levels.
      const aiReport = global.researchData.aiReport || {};
      const causalMap = {};
      (aiReport.causalChains || []).forEach(chain => {
        (chain.impactedStocks || []).forEach(s => {
          if (!causalMap[s.symbol]) causalMap[s.symbol] = [];
          causalMap[s.symbol].push({
            chain:     chain.chain,
            trigger:   chain.trigger,
            direction: s.direction,
            reason:    s.reason,
            magnitude: s.magnitude
          });
        });
      });

      global.researchData.enrichedWatchlist = watchlistSource.map(w => ({
        ...w,
        liveData:     null,   // no live data — AI uses own knowledge
        oiData:       null,
        deliveryData: null,
        volumeData:   null,
        signals:      [],
        conviction:   (w.confidence || 5) * 10,
        trafficLight: (w.confidence || 5) >= 7 ? "GREEN" : (w.confidence || 5) >= 5 ? "AMBER" : "RED",
        // Attach matching causal chains from AI research
        causalContext: causalMap[w.symbol] || [],
        enrichedAt:   new Date().toISOString()
      }));

      console.log("[Research] Overnight mode: " + global.researchData.enrichedWatchlist.length +
        " stocks prepared with AI research context (no live prices needed)");
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
  console.log("[Research] Engine started — smart schedule: overnight=60min, intraday=15min");
  refreshResearch(); // immediate first run

  // Smart scheduler — overnight calls AI once per hour, intraday every 15 min
  // This keeps API calls at ~20/day instead of ~288/day — no more rate limits
  function scheduleNext() {
    const phase = require("./aiResearcher").getMarketPhase();
    const isMarket = (phase === "INTRADAY" || phase === "OPENING");
    const interval = isMarket ? REFRESH_INTERVAL_INTRADAY_MS : REFRESH_INTERVAL_OVERNIGHT_MS;
    console.log("[Research] Next refresh in " + Math.round(interval/60000) + "min [" + phase + "]");
    setTimeout(async () => {
      await refreshResearch();
      scheduleNext();
    }, interval);
  }
  scheduleNext();
}

module.exports = { startResearchEngine, refreshResearch };
