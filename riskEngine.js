// riskEngine.js - Position sizing, SL/target calc, open position tracking

const RISK_PER_TRADE = 500;
const TOTAL_CAPITAL = 100000;
const MAX_POSITIONS = 3;
const MAX_SINGLE_STOCK_PCT = 0.30;
const MIN_RR_RATIO = 1.5;

const openPositions = {};

function getOpenPositionCount() {
  return Object.values(openPositions).filter(p => p.status === "open").length;
}

function calculatePosition(symbol, ltp, aiRec) {
  const entry      = aiRec ? parseFloat(aiRec.entry)     : ltp;
  const stopLoss   = aiRec ? parseFloat(aiRec.stopLoss)  : parseFloat((ltp * 0.995).toFixed(2));
  const target1    = aiRec ? parseFloat(aiRec.target1)   : parseFloat((ltp * 1.010).toFixed(2));
  const target2    = aiRec ? parseFloat(aiRec.target2)   : parseFloat((ltp * 1.020).toFixed(2));

  const riskPerShare = entry - stopLoss;
  if (riskPerShare <= 0) return null;

  let quantity = Math.floor(RISK_PER_TRADE / riskPerShare);
  if (quantity <= 0) quantity = 1;

  const maxByCapital = Math.floor((TOTAL_CAPITAL * MAX_SINGLE_STOCK_PCT) / entry);
  quantity = Math.min(quantity, maxByCapital);

  const totalCost   = parseFloat((quantity * entry).toFixed(2));
  const maxLoss     = parseFloat((quantity * riskPerShare).toFixed(2));
  const reward      = target1 - entry;
  const rrRatio     = parseFloat((reward / riskPerShare).toFixed(2));

  return {
    symbol, entry, stopLoss, target1, target2,
    quantity, totalCost, maxLoss, rrRatio,
    riskOk: rrRatio >= MIN_RR_RATIO && maxLoss <= RISK_PER_TRADE * 1.1
  };
}

function canTrade(symbol) {
  if (openPositions[symbol] && openPositions[symbol].status === "open")
    return { ok: false, reason: "Already holding " + symbol.replace("NSE_EQ|","") };
  if (getOpenPositionCount() >= MAX_POSITIONS)
    return { ok: false, reason: "Max " + MAX_POSITIONS + " positions open" };
  return { ok: true };
}

function addPosition(symbol, details, orderId) {
  openPositions[symbol] = { ...details, orderId, status: "open", openTime: new Date().toISOString(), target1Hit: false };
}

function closePosition(symbol, exitPrice, reason) {
  if (!openPositions[symbol]) return null;
  const pos = openPositions[symbol];
  pos.status    = "closed";
  pos.exitPrice = exitPrice;
  pos.closeTime = new Date().toISOString();
  pos.pnl       = parseFloat(((exitPrice - pos.entry) * pos.quantity).toFixed(2));
  pos.closeReason = reason;
  console.log("CLOSED: " + symbol.replace("NSE_EQ|","") + " PnL=₹" + pos.pnl + " (" + reason + ")");
  return pos;
}

function getOpenPositions()  { return Object.values(openPositions).filter(p => p.status === "open"); }
function getAllPositions()    { return Object.values(openPositions); }
function getTodayPnL()       { return getAllPositions().filter(p => p.status === "closed").reduce((s, p) => s + (p.pnl || 0), 0); }

module.exports = { calculatePosition, canTrade, addPosition, closePosition, getOpenPositions, getAllPositions, getTodayPnL, RISK_PER_TRADE, MAX_POSITIONS };
