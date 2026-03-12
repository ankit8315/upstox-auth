// breakoutEngine.js
const { updateTick }      = require("./tickStore");
const { sendTelegramAlert } = require("./alertService");
const { saveBreakout }    = require("./db");
const { getSectorForSymbol } = require("./stockScreener");
const { processTick: preBreakoutCheck, registerSectorMove } = require("./preBreakoutEngine");

function processTick(instrumentKey, ltp) {
  const data = updateTick(instrumentKey, ltp);

  // Clean symbol: "NSE_EQ|INE123456789" → "JPPOWER"
  const symbol    = instrumentKey.split("|").pop().split("-")[0];
  const sector    = getSectorForSymbol(symbol) || "Unknown";
  const openPrice = data.ticks.length > 0 ? data.ticks[0].price : ltp;

  // ── PRE-BREAKOUT: fires BEFORE the move ──────────────────────────
  preBreakoutCheck(symbol, ltp, {
    openPrice,
    sector,
    volumeToday: data.volumeToday || 0,
    avgVolume:   data.avgVolume   || 0,
    high52w:     data.high52w     || 0,
    news:        global.recentNews || []   // set by newsEngine
  });

  // Register sector moves for contagion detection
  if (openPrice > 0) {
    const movePct = ((ltp - openPrice) / openPrice) * 100;
    if (movePct >= 2.5) registerSectorMove(symbol, sector, movePct);
  }

  // ── EXISTING: fires AFTER breakout (keep as confirmation) ────────
  if (!data.high5Min) return;
  const now = Date.now();
  if (ltp >= data.high5Min && now - (data.lastBreakoutTime || 0) > 60_000) {
    data.lastBreakoutTime = now;
    console.log("📈 5-min high breakout: " + instrumentKey + " @ " + ltp);
    if (global.addBreakout) {
      global.addBreakout({ symbol: instrumentKey, price: ltp, time: new Date().toISOString() });
    }
    sendTelegramAlert("📈 Breakout confirmed: " + symbol + " @ ₹" + ltp);
    if (saveBreakout) {
      try { saveBreakout(instrumentKey, ltp); } catch (e) { /* Mongo disabled */ }
    }
  }
}

module.exports = { processTick };