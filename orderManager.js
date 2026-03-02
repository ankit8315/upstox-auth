// orderManager.js - Upstox order placement + SL/target monitoring + auto square-off

const axios = require("axios");
const { closePosition, getOpenPositions, addPosition } = require("./riskEngine");
const { sendTelegramAlert } = require("./alertService");

const UPSTOX_ORDER_URL = "https://api.upstox.com/v2/order/place";
let squaredOffToday = false;

function getIST() {
  const n = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return { hour: n.getHours(), min: n.getMinutes() };
}

async function placeOrder(accessToken, symbol, quantity, txType, orderType, price) {
  const payload = {
    quantity, product: "I", validity: "DAY",
    price: orderType === "MARKET" ? 0 : parseFloat(price),
    tag: "breakout-scanner",
    instrument_token: symbol,
    order_type: orderType,
    transaction_type: txType,
    disclosed_quantity: 0,
    trigger_price: orderType === "SL-M" ? parseFloat(price) : 0,
    is_amo: false
  };
  try {
    const resp = await axios.post(UPSTOX_ORDER_URL, payload, {
      headers: { Authorization: "Bearer " + accessToken, "Api-Version": "2", "Content-Type": "application/json" },
      timeout: 10000
    });
    const orderId = resp.data.data && resp.data.data.order_id;
    console.log(txType + " ORDER: " + symbol.replace("NSE_EQ|","") + " qty=" + quantity + " id=" + orderId);
    return { success: true, orderId };
  } catch (err) {
    const msg = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    console.error("ORDER FAILED: " + symbol + " — " + msg);
    return { success: false, reason: msg };
  }
}

// Called from app when user confirms a trade
async function executeBuy(accessToken, tradeOpportunity) {
  const { symbol, quantity, entry } = tradeOpportunity;
  const result = await placeOrder(accessToken, symbol, quantity, "BUY", "LIMIT", entry);
  if (result.success) {
    addPosition(symbol, tradeOpportunity, result.orderId);
    sendTelegramAlert("✅ ORDER PLACED: " + symbol.replace("NSE_EQ|","") + "\nEntry: ₹" + entry + " Qty: " + quantity + "\nSL: ₹" + tradeOpportunity.stopLoss + " T1: ₹" + tradeOpportunity.target1);
    if (global.updateTradeStatus) global.updateTradeStatus(tradeOpportunity.id, "placed", result.orderId);
  }
  return result;
}

async function monitorPositions(accessToken, currentPrices) {
  const { hour, min } = getIST();

  // Auto square-off at 3:15 PM
  if (!squaredOffToday && (hour > 15 || (hour === 15 && min >= 15))) {
    await squareOffAll(accessToken, currentPrices, "EOD auto square-off 3:15 PM");
    squaredOffToday = true;
    return;
  }

  const positions = getOpenPositions();
  for (const pos of positions) {
    const ltp = currentPrices[pos.symbol];
    if (!ltp) continue;

    // Stop loss hit
    if (ltp <= pos.stopLoss) {
      console.log("SL HIT: " + pos.symbol.replace("NSE_EQ|","") + " @ ₹" + ltp);
      const r = await placeOrder(accessToken, pos.symbol, pos.quantity, "SELL", "MARKET", 0);
      if (r.success) {
        const closed = closePosition(pos.symbol, ltp, "Stop loss");
        sendTelegramAlert("🔴 SL HIT: " + pos.symbol.replace("NSE_EQ|","") + "\nExit ₹" + ltp + " | P&L: ₹" + closed.pnl);
        if (global.addTrade) global.addTrade({ ...closed, exitType: "sl" });
      }
      continue;
    }

    // Target 1 hit → move SL to entry (free trade)
    if (ltp >= pos.target1 && !pos.target1Hit) {
      pos.target1Hit = true;
      pos.stopLoss = pos.entry;
      console.log("T1 HIT: " + pos.symbol.replace("NSE_EQ|","") + " SL moved to entry");
      sendTelegramAlert("🟡 TARGET 1: " + pos.symbol.replace("NSE_EQ|","") + " @ ₹" + ltp + "\nSL moved to ₹" + pos.entry + " (risk-free now)");
      if (global.updateTradeStatus) global.updateTradeStatus(pos.id, "target1_hit");
    }

    // Target 2 hit → full exit
    if (ltp >= pos.target2) {
      console.log("T2 HIT: " + pos.symbol.replace("NSE_EQ|","") + " @ ₹" + ltp);
      const r = await placeOrder(accessToken, pos.symbol, pos.quantity, "SELL", "MARKET", 0);
      if (r.success) {
        const closed = closePosition(pos.symbol, ltp, "Target 2");
        sendTelegramAlert("🟢 TARGET 2: " + pos.symbol.replace("NSE_EQ|","") + "\nExit ₹" + ltp + " | P&L: ₹" + closed.pnl);
        if (global.addTrade) global.addTrade({ ...closed, exitType: "target2" });
      }
    }
  }
}

async function squareOffAll(accessToken, currentPrices, reason) {
  const positions = getOpenPositions();
  if (positions.length === 0) return;
  console.log("SQUARING OFF " + positions.length + " positions — " + reason);
  for (const pos of positions) {
    const ltp = currentPrices[pos.symbol] || pos.entry;
    await placeOrder(accessToken, pos.symbol, pos.quantity, "SELL", "MARKET", 0);
    const closed = closePosition(pos.symbol, ltp, reason);
    sendTelegramAlert("⏹ CLOSED: " + pos.symbol.replace("NSE_EQ|","") + " ₹" + ltp + " P&L: ₹" + (closed && closed.pnl));
  }
}

function resetDailyFlags() { squaredOffToday = false; }

module.exports = { placeOrder, executeBuy, monitorPositions, squareOffAll, resetDailyFlags };
