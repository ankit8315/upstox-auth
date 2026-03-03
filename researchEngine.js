// researchEngine.js — Orchestrates all research services
// Runs every 5 minutes always (market open or closed)
// Exposes data via global.researchData

const { fetchNews }           = require("./newsService");
const { fetchFIIDII }         = require("./fiiService");
const { fetchSectors }        = require("./sectorService");
const { generateResearch }    = require("./aiResearcher");
const { enrichWatchlist }     = require("./stockIntelligence");
const { generateTradeCalls, checkTheses } = require("./traderBrain");

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Global research state
global.researchData = {
  news:             [],
  fiidii:           null,
  sectors:          null,
  aiReport:         null,
  enrichedWatchlist:[],
  tradeCalls:       null,   // ← AI trader's exact calls with math
  thesisUpdates:    null,   // ← 5-min re-evaluation
  lastUpdate:       null,
  isRefreshing:     false
};

async function refreshResearch() {
  if (global.researchData.isRefreshing) return;
  global.researchData.isRefreshing = true;

  const start = Date.now();
  console.log("Research refresh started...");

  try {
    // Step 1: All data sources in parallel
    const [news, fiidii, sectors] = await Promise.allSettled([
      fetchNews(),
      fetchFIIDII(),
      fetchSectors()
    ]);

    const newsData    = news.status    === "fulfilled" ? news.value    : [];
    const fiidiiData  = fiidii.status  === "fulfilled" ? fiidii.value  : {};
    const sectorsData = sectors.status === "fulfilled" ? sectors.value : { sectors: [], breadth: {} };

    global.researchData.news    = newsData;
    global.researchData.fiidii  = fiidiiData;
    global.researchData.sectors = sectorsData;

    // Step 2: AI deep research
    if (newsData.length > 0) {
      const aiReport = await generateResearch(newsData, fiidiiData, sectorsData);
      if (aiReport) {
        global.researchData.aiReport = aiReport;

        // Step 3: Enrich every AI-recommended stock with live NSE data
        if (aiReport.watchlist && aiReport.watchlist.length > 0) {
          const enriched = await enrichWatchlist(aiReport.watchlist);
          global.researchData.enrichedWatchlist = enriched;
          console.log("Enriched " + enriched.length + " stocks | Top: " +
            (enriched[0] || {}).symbol + " conviction=" + (enriched[0] || {}).conviction);

          // Step 4: TraderBrain — generate exact trade calls with math
          // Runs always (pre-market prep + live market calls)
          try {
            const openPositions  = require("./riskEngine").getOpenPositions();
            const todayPnL       = require("./riskEngine").getTodayPnL();
            const marketContext  = global.niftyContext || null;

            const tradeCalls = await generateTradeCalls(
              enriched,
              marketContext,
              openPositions,
              todayPnL
            );
            global.researchData.tradeCalls = tradeCalls;

            // Step 5: If market is open, also run 5-min thesis check
            const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            const h = now.getHours(), m = now.getMinutes(), d = now.getDay();
            const marketOpen = d >= 1 && d <= 5 && (h > 9 || (h === 9 && m >= 15)) && h < 15;

            if (marketOpen && tradeCalls.calls && tradeCalls.calls.length > 0) {
              const currentPrices = global.currentPrices || {};
              const thesisUpdates = await checkTheses(
                tradeCalls.calls.filter(tc => tc.urgency === "NOW" || tc.enteredAt),
                currentPrices,
                marketContext
              );
              global.researchData.thesisUpdates = thesisUpdates;
            }
          } catch (e) {
            console.error("TraderBrain integration error:", e.message);
          }
        }
      }
    }

    global.researchData.lastUpdate = new Date().toISOString();
    console.log("Research done in " + (Date.now() - start) + "ms | news=" + newsData.length);

  } catch (e) {
    console.error("Research refresh error:", e.message);
  } finally {
    global.researchData.isRefreshing = false;
  }
}

function startResearchEngine() {
  console.log("Research engine started — refreshing every 5 min");
  refreshResearch(); // immediate first run
  setInterval(refreshResearch, REFRESH_INTERVAL_MS);
}

module.exports = { startResearchEngine, refreshResearch };
