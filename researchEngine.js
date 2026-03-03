// researchEngine.js — Orchestrates all research services
// Runs every 5 minutes always (market open or closed)
// Exposes data via global.researchData

const { fetchNews }           = require("./newsService");
const { fetchFIIDII }         = require("./fiiService");
const { fetchSectors }        = require("./sectorService");
const { generateResearch }    = require("./aiResearcher");

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min

// Global research state
global.researchData = {
  news:      [],
  fiidii:    null,
  sectors:   null,
  aiReport:  null,
  lastUpdate: null,
  isRefreshing: false
};

async function refreshResearch() {
  if (global.researchData.isRefreshing) return;
  global.researchData.isRefreshing = true;

  const start = Date.now();
  console.log("Research refresh started...");

  try {
    // Step 1: Fetch all data sources in parallel
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

    // Step 2: AI synthesis (only if we have meaningful data)
    if (newsData.length > 0) {
      const aiReport = await generateResearch(newsData, fiidiiData, sectorsData);
      if (aiReport) global.researchData.aiReport = aiReport;
    }

    global.researchData.lastUpdate = new Date().toISOString();
    console.log("Research refresh done in " + (Date.now() - start) + "ms | news=" + newsData.length + " sectors=" + sectorsData.sectors.length);

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
