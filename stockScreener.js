// stockScreener.js
// Reduces 2000+ stocks → highest quality candidates
// Runs once at market open, updates every 30 mins
// Filters: liquidity, sector strength, relative strength, F&O eligibility
//
// FNO_STOCKS and SECTOR_MAP are no longer hardcoded constants.
// They are fetched live from NSE via fnoRegistry.js (cached 4 hours).

const { context } = require("./marketContext");
const {
  ensureLoaded,
  isFNOStock,
  getSectorForSymbol,
  getFNOStocks
} = require("./fnoRegistry");

// Track daily performance per stock
const stockPerformance = {};

function updateStockPerformance(symbol, ltp, open) {
  if (!open || open === 0) return;
  const change = ((ltp - open) / open) * 100;
  stockPerformance[symbol] = { ltp, open, change, lastUpdate: Date.now() };
}

// Get watchlist — stocks worth monitoring right now
// NOTE: async because getFNOStocks() may need to load the registry
async function getWatchlist(allInstruments) {
  await ensureLoaded();
  const hotSectors = getHotSectors();

  return allInstruments.filter(symbol => {
    const isFNO = isFNOStock(symbol);

    const sector = getSectorForSymbol(symbol);
    const inHotSector = !sector || sector === "Other" || hotSectors.includes(sector);

    const perf = stockPerformance[symbol];
    const isPerforming = !perf || perf.change > -1;

    return (isFNO || inHotSector) && isPerforming;
  });
}

function getHotSectors() {
  const sectors = context.sectors || {};
  return Object.entries(sectors)
    .filter(([, data]) => data.change > 0)
    .sort((a, b) => b[1].change - a[1].change)
    .slice(0, 4)
    .map(([name]) => name);
}

// Priority score for a stock — higher = scan first
function getStockPriority(symbol) {
  let priority = 0;

  if (isFNOStock(symbol)) priority += 50;

  const sector = getSectorForSymbol(symbol);
  const sectorData = context.sectors && context.sectors[sector];
  if (sectorData) {
    if (sectorData.change > 0.5) priority += 30;
    else if (sectorData.change > 0) priority += 15;
  }

  const perf = stockPerformance[symbol];
  if (perf) {
    if (perf.change > 1)       priority += 20;
    else if (perf.change > 0.5) priority += 10;
    else if (perf.change < -1)  priority -= 30;
  }
  return priority;
}

// Sort instruments by priority — best opportunities first
function prioritizeInstruments(instruments) {
  return [...instruments].sort((a, b) => getStockPriority(b) - getStockPriority(a));
}

module.exports = {
  getWatchlist,
  prioritizeInstruments,
  updateStockPerformance,
  getSectorForSymbol,  // re-exported for convenience (delegates to fnoRegistry)
  isFNOStock,          // re-exported for convenience
  // getFNOStocks kept async for callers that need the full Set
  getFNOStocks
};
