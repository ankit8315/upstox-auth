// stockScreener.js
// Reduces 2000+ stocks → 50-100 highest quality candidates
// Runs once at market open, updates every 30 mins
// Filters: liquidity, sector strength, relative strength, F&O eligibility

const axios = require("axios");
const { context } = require("./marketContext");

// NSE F&O eligible stocks (top 200 by market cap — highly liquid)
// These are the safest intraday stocks
const FNO_STOCKS = new Set([
  "RELIANCE","HDFCBANK","INFY","ICICIBANK","TCS","KOTAKBANK","HINDUNILVR",
  "BHARTIARTL","SBIN","BAJFINANCE","AXISBANK","LT","WIPRO","HCLTECH","ONGC",
  "NTPC","POWERGRID","SUNPHARMA","TECHM","MARUTI","M&M","ULTRACEMCO","ADANIENT",
  "TATAMOTORS","INDUSINDBK","TITAN","BAJAJFINSV","JSWSTEEL","TATASTEEL","CIPLA",
  "DIVISLAB","DRREDDY","EICHERMOT","HEROMOTOCO","HINDALCO","ITC","NESTLEIND",
  "BRITANNIA","GRASIM","ASIANPAINT","HDFCLIFE","SBILIFE","BAJAJ-AUTO","COALINDIA",
  "BPCL","IOC","DABUR","GODREJCP","PIDILITIND","BERGEPAINT","HAVELLS","VOLTAS",
  "MOTHERSON","APOLLOHOSP","FORTIS","MAXHEALTH","APOLLOTYRE","MRF","CEATLTD",
  "BALKRISIND","ESCORTS","TVSMOTOR","ASHOKLEY","EXIDEIND","AMBUJACEM","ACCLTD",
  "SHREECEM","RAMCOCEM","DALMIACEME","ADANIPORTS","ADANIGREEN","ADANIPOWER",
  "TATAPOWER","TORNTPOWER","CANBK","BANKBARODA","PNB","FEDERALBNK","IDFCFIRSTB",
  "RBLBANK","BANDHANBNK","MUTHOOTFIN","BAJAJHLDNG","CHOLAFIN","MANAPPURAM",
  "LICHSGFIN","RECLTD","PFC","IRFC","HUDCO","SAIL","NMDC","MOIL","NATIONALUM",
  "VEDL","HINDZINC","GMRINFRA","IRB","NHAI","CONCOR","INDIGOPNTS","STARCEMENT"
]);

// Sector mapping
const SECTOR_MAP = {
  "RELIANCE":"Energy","ONGC":"Energy","BPCL":"Energy","IOC":"Energy",
  "HDFCBANK":"Bank","ICICIBANK":"Bank","SBIN":"Bank","KOTAKBANK":"Bank","AXISBANK":"Bank",
  "INFY":"IT","TCS":"IT","WIPRO":"IT","HCLTECH":"IT","TECHM":"IT",
  "SUNPHARMA":"Pharma","CIPLA":"Pharma","DRREDDY":"Pharma","DIVISLAB":"Pharma",
  "MARUTI":"Auto","TATAMOTORS":"Auto","M&M":"Auto","BAJAJ-AUTO":"Auto","HEROMOTOCO":"Auto",
  "TATASTEEL":"Metal","JSWSTEEL":"Metal","HINDALCO":"Metal","SAIL":"Metal",
  "BHARTIARTL":"Telecom","LT":"Infra","NTPC":"Power","POWERGRID":"Power"
};

// Track daily performance per stock
const stockPerformance = {};

function updateStockPerformance(symbol, ltp, open) {
  if (!open || open === 0) return;
  const change = ((ltp - open) / open) * 100;
  stockPerformance[symbol] = { ltp, open, change, lastUpdate: Date.now() };
}

// Get watchlist — stocks worth monitoring right now
function getWatchlist(allInstruments) {
  const hotSectors = getHotSectors();

  return allInstruments.filter(symbol => {
    const cleanSymbol = symbol.replace("NSE_EQ|", "").replace("BSE_EQ|", "");

    // Prefer F&O stocks (most liquid)
    const isFNO = FNO_STOCKS.has(cleanSymbol);

    // Check sector
    const sector = SECTOR_MAP[cleanSymbol];
    const inHotSector = !sector || hotSectors.includes(sector);

    // Check performance
    const perf = stockPerformance[symbol];
    const isPerforming = !perf || perf.change > -1; // not falling hard

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
  const cleanSymbol = symbol.replace("NSE_EQ|", "");
  let priority = 0;
  if (FNO_STOCKS.has(cleanSymbol)) priority += 50;
  const sector = SECTOR_MAP[cleanSymbol];
  if (sector) {
    const sectorData = context.sectors && context.sectors[sector];
    if (sectorData && sectorData.change > 0.5) priority += 30;
    else if (sectorData && sectorData.change > 0) priority += 15;
  }
  const perf = stockPerformance[symbol];
  if (perf) {
    if (perf.change > 1) priority += 20;
    else if (perf.change > 0.5) priority += 10;
    else if (perf.change < -1) priority -= 30;
  }
  return priority;
}

// Sort instruments by priority — best opportunities first
function prioritizeInstruments(instruments) {
  return [...instruments].sort((a, b) => getStockPriority(b) - getStockPriority(a));
}

function getSectorForSymbol(symbol) {
  const clean = symbol.replace("NSE_EQ|", "").replace("BSE_EQ|", "");
  return SECTOR_MAP[clean] || "Other";
}

function isFNOStock(symbol) {
  return FNO_STOCKS.has(symbol.replace("NSE_EQ|", "").replace("BSE_EQ|", ""));
}

module.exports = {
  getWatchlist,
  prioritizeInstruments,
  updateStockPerformance,
  getSectorForSymbol,
  isFNOStock,
  FNO_STOCKS
};
