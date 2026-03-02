const { updateTick } = require("./tickStore");
const { sendTelegramAlert } = require("./alertService"); // ← fixed import name
const { saveBreakout } = require("./db");

function processTick(instrumentKey, ltp) {
  const data = updateTick(instrumentKey, ltp);

  if (!data.high5Min) return;

  const now = Date.now();

  if (
    ltp >= data.high5Min &&
    now - (data.lastBreakoutTime || 0) > 60_000
  ) {
    data.lastBreakoutTime = now;

    console.log(`📈 5-min high breakout: ${instrumentKey} @ ${ltp}`);

    if (global.addBreakout) {
      global.addBreakout({
        symbol: instrumentKey,
        price: ltp,
        time: new Date().toISOString()
      });
    }

    sendTelegramAlert(`📈 5-min High Breakout: ${instrumentKey} @ ₹${ltp}`);

    if (saveBreakout) {
      try {
        saveBreakout(instrumentKey, ltp);
      } catch (e) {
        // Mongo disabled
      }
    }
  }
}

module.exports = { processTick };