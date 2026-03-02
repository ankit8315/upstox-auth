// riskEngine.js v2 — Institutional grade risk management
// Kelly Criterion sizing, correlation check, daily loss limits, streak detection

const TOTAL_CAPITAL     = parseFloat(process.env.CAPITAL || "1000");
const RISK_PCT          = 0.05;   // 5% risk per trade (₹50 on ₹1000)
const RISK_PER_TRADE    = TOTAL_CAPITAL * RISK_PCT;
const MAX_POSITIONS     = 2;      // max 2 open at once (with ₹1000)
const MAX_SINGLE_STOCK  = 0.30;   // max 30% capital in one stock
const MAX_DAILY_LOSS    = TOTAL_CAPITAL * 0.03; // stop at 3% daily loss
const MIN_RR_RATIO      = 1.5;    // minimum 1:1.5 risk/reward
const MAX_LOSS_STREAK   = 3;      // pause after 3 consecutive losses

const openPositions  = {};
const closedTrades   = [];
let dailyPnL         = 0;
let lossStreak       = 0;
let tradingPaused    = false;
let pauseReason      = "";

// ── Kelly Criterion ───────────────────────────────────────────────────
// Optimal position size based on win rate and avg win/loss
function kellyFraction(winRate, avgWin, avgLoss) {
  if (avgLoss === 0) return 0.25;
  const b = avgWin / avgLoss; // win/loss ratio
  const p = winRate;          // probability of win
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  // Use half-Kelly for safety
  return Math.max(0.05, Math.min(0.25, kelly * 0.5));
}

// Get historical stats for Kelly calculation
function getHistoricalStats() {
  if (closedTrades.length < 5) return { winRate: 0.5, avgWin: RISK_PER_TRADE * 2, avgLoss: RISK_PER_TRADE };
  const wins   = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl <= 0);
  const winRate  = wins.length / closedTrades.length;
  const avgWin   = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : RISK_PER_TRADE * 2;
  const avgLoss  = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : RISK_PER_TRADE;
  return { winRate, avgWin, avgLoss };
}

// ── Position Sizing ───────────────────────────────────────────────────
function calculatePosition(symbol, ltp, aiRec, signalScore) {
  const entry    = aiRec ? parseFloat(aiRec.entry)    : ltp;
  const stopLoss = aiRec ? parseFloat(aiRec.stopLoss) : parseFloat((ltp * 0.995).toFixed(2));
  const target1  = aiRec ? parseFloat(aiRec.target1)  : parseFloat((ltp * 1.01).toFixed(2));
  const target2  = aiRec ? parseFloat(aiRec.target2)  : parseFloat((ltp * 1.02).toFixed(2));

  const riskPerShare = entry - stopLoss;
  if (riskPerShare <= 0) return null;

  // Kelly-adjusted position size
  const stats  = getHistoricalStats();
  const kelly  = kellyFraction(stats.winRate, stats.avgWin, stats.avgLoss);
  const riskAmount = TOTAL_CAPITAL * kelly * (signalScore ? signalScore / 100 : 0.5);
  const cappedRisk = Math.min(riskAmount, RISK_PER_TRADE * 1.5); // never exceed 1.5x base risk

  let quantity = Math.floor(cappedRisk / riskPerShare);
  if (quantity <= 0) quantity = 1;

  // Cap by max single stock allocation
  const maxByCapital = Math.floor((TOTAL_CAPITAL * MAX_SINGLE_STOCK) / entry);
  quantity = Math.min(quantity, maxByCapital);

  const totalCost  = parseFloat((quantity * entry).toFixed(2));
  const maxLoss    = parseFloat((quantity * riskPerShare).toFixed(2));
  const reward     = target1 - entry;
  const rrRatio    = parseFloat((reward / riskPerShare).toFixed(2));

  return {
    symbol, entry, stopLoss, target1, target2,
    quantity, totalCost, maxLoss, rrRatio,
    kellyFraction: parseFloat(kelly.toFixed(3)),
    riskOk: rrRatio >= MIN_RR_RATIO && maxLoss <= RISK_PER_TRADE * 2
  };
}

// ── Trade Checks ──────────────────────────────────────────────────────
function canTrade(symbol) {
  if (tradingPaused) return { ok: false, reason: "Trading paused: " + pauseReason };

  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS && dailyPnL < 0) {
    tradingPaused = true;
    pauseReason = "Daily loss limit hit ₹" + Math.abs(dailyPnL).toFixed(0);
    return { ok: false, reason: pauseReason };
  }

  if (lossStreak >= MAX_LOSS_STREAK) {
    tradingPaused = true;
    pauseReason = MAX_LOSS_STREAK + " consecutive losses — cooling off";
    return { ok: false, reason: pauseReason };
  }

  if (openPositions[symbol] && openPositions[symbol].status === "open") {
    return { ok: false, reason: "Already holding " + symbol.replace("NSE_EQ|","") };
  }

  if (getOpenPositionCount() >= MAX_POSITIONS) {
    return { ok: false, reason: "Max " + MAX_POSITIONS + " positions open" };
  }

  // Sector correlation check — don't hold 2 stocks in same sector
  const { getSectorForSymbol } = require("./stockScreener");
  const newSector = getSectorForSymbol(symbol);
  const openSectors = Object.values(openPositions)
    .filter(p => p.status === "open")
    .map(p => getSectorForSymbol(p.symbol));

  if (newSector !== "Other" && openSectors.includes(newSector)) {
    return { ok: false, reason: "Already in " + newSector + " sector" };
  }

  return { ok: true };
}

function getOpenPositionCount() {
  return Object.values(openPositions).filter(p => p.status === "open").length;
}

function addPosition(symbol, details, orderId) {
  openPositions[symbol] = {
    ...details, orderId, status: "open",
    openTime: new Date().toISOString(),
    target1Hit: false
  };
}

function closePosition(symbol, exitPrice, reason) {
  if (!openPositions[symbol]) return null;
  const pos      = openPositions[symbol];
  pos.status     = "closed";
  pos.exitPrice  = exitPrice;
  pos.closeTime  = new Date().toISOString();
  pos.pnl        = parseFloat(((exitPrice - pos.entry) * pos.quantity).toFixed(2));
  pos.closeReason = reason;

  // Update daily PnL and streak
  dailyPnL += pos.pnl;
  closedTrades.push(pos);
  if (pos.pnl > 0) lossStreak = 0;
  else lossStreak++;

  console.log("CLOSED: " + symbol.replace("NSE_EQ|","") +
    " PnL=₹" + pos.pnl +
    " Daily=₹" + dailyPnL.toFixed(0) +
    " Streak=" + lossStreak +
    " (" + reason + ")");
  return pos;
}

function resumeTrading() {
  tradingPaused = false;
  pauseReason   = "";
  lossStreak    = 0;
}

function resetDailyStats() {
  dailyPnL      = 0;
  lossStreak    = 0;
  tradingPaused = false;
  pauseReason   = "";
}

function getOpenPositions()  { return Object.values(openPositions).filter(p => p.status === "open"); }
function getAllPositions()    { return Object.values(openPositions); }
function getTodayPnL()       { return parseFloat(dailyPnL.toFixed(2)); }
function getStats() {
  const stats = getHistoricalStats();
  return {
    totalTrades: closedTrades.length,
    winRate: parseFloat((stats.winRate * 100).toFixed(1)),
    avgWin: parseFloat(stats.avgWin.toFixed(2)),
    avgLoss: parseFloat(stats.avgLoss.toFixed(2)),
    todayPnL: dailyPnL,
    lossStreak, tradingPaused, pauseReason,
    openCount: getOpenPositionCount()
  };
}

module.exports = {
  calculatePosition, canTrade, addPosition, closePosition,
  getOpenPositions, getAllPositions, getTodayPnL, getStats,
  resetDailyStats, resumeTrading,
  RISK_PER_TRADE, MAX_POSITIONS, TOTAL_CAPITAL
};
