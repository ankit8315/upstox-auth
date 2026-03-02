// WebSocket.js - Reserved for Upstox Pro plan
// Current setup uses REST polling (poller.js) which works on Basic/Trial plan
// When you upgrade to Pro, replace poller in auth.js with this

const WebSocket = require("ws");
const axios = require("axios");
const { loadProto, decodeMessage } = require("./decoder");

let protoReady = false;
loadProto()
  .then(() => { protoReady = true; console.log("Proto loaded"); })
  .catch(err => console.error("Proto load failed:", err.message));

async function connectWebSocket(accessToken, instrumentKeys) {
  try {
    const response = await axios.get(
      "https://api.upstox.com/v3/feed/market-data-feed",
      {
        headers: { Authorization: "Bearer " + accessToken, "Api-Version": "3" },
        maxRedirects: 0,
        validateStatus: (s) => s === 302
      }
    );

    const wsUrl = response.headers.location;
    if (!wsUrl) throw new Error("No redirect URL");

    const { updateTick } = require("./marketState");
    const { updateCandle } = require("./candleEngine");
    const { evaluateBreakout } = require("./strategyEngine");
    const { sendTelegramAlert } = require("./alertService");
    const { updateTick: tickStoreUpdate } = require("./tickStore");

    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log("WebSocket connected");
      setTimeout(() => {
        const batchSize = 100;
        for (let i = 0; i < instrumentKeys.length; i += batchSize) {
          ws.send(JSON.stringify({
            guid: "b" + i,
            method: "subscribe",
            data: { mode: "ltpc", instrumentKeys: instrumentKeys.slice(i, i + batchSize) }
          }));
        }
        console.log("Subscribed " + instrumentKeys.length + " instruments");
      }, 500);
    });

    ws.on("message", (data) => {
      if (!Buffer.isBuffer(data) || !protoReady) return;
      const decoded = decodeMessage(data);
      if (!decoded || !decoded.feeds) return;

      const now = Date.now();
      for (const [instrumentKey, feed] of Object.entries(decoded.feeds)) {
        try {
          let ltp = 0, volume = 0, timestamp = now;
          if (feed.fullFeed && feed.fullFeed.marketFF) {
            ltp = feed.fullFeed.marketFF.ltpc && feed.fullFeed.marketFF.ltpc.ltp;
            volume = feed.fullFeed.marketFF.vtt || 0;
            timestamp = (feed.fullFeed.marketFF.ltpc && feed.fullFeed.marketFF.ltpc.ltt) || now;
          } else if (feed.ltpc) {
            ltp = feed.ltpc.ltp;
            timestamp = feed.ltpc.ltt || now;
          }
          if (!ltp) continue;
          processSymbol(instrumentKey, ltp, volume, timestamp, updateTick, updateCandle, evaluateBreakout, sendTelegramAlert, tickStoreUpdate);
        } catch (e) {
          console.error("Tick error:", e.message);
        }
      }
    });

    ws.on("error", (err) => console.error("WS error:", err.message));
    ws.on("close", (code) => {
      console.log("WS closed:", code);
      if (code !== 1008) setTimeout(() => connectWebSocket(accessToken, instrumentKeys), 5000);
    });

  } catch (error) {
    console.error("WS init failed:", error.message);
    setTimeout(() => connectWebSocket(accessToken, instrumentKeys), 10000);
  }
}

function processSymbol(instrumentKey, ltp, volume, timestamp, updateTick, updateCandle, evaluateBreakout, sendTelegramAlert, tickStoreUpdate) {
  const state = updateTick(instrumentKey, ltp, volume, timestamp);
  updateCandle(state, ltp, volume, timestamp);
  const signal = evaluateBreakout(instrumentKey, state);
  if (signal) {
    console.log("BREAKOUT " + signal.symbol + " @ " + signal.price);
    if (global.addBreakout) global.addBreakout(signal);
    sendTelegramAlert("BREAKOUT: " + signal.symbol + "\nPrice: Rs." + signal.price + "\nVWAP: Rs." + (signal.vwap || 0).toFixed(2) + "\nLevel: Rs." + signal.breakoutLevel);
  }
  const td = tickStoreUpdate(instrumentKey, ltp);
  const now = Date.now();
  if (td.high5Min && ltp >= td.high5Min && now - (td.lastBreakoutTime || 0) > 60000) {
    td.lastBreakoutTime = now;
    if (global.addBreakout) global.addBreakout({ symbol: instrumentKey, price: ltp, time: new Date().toISOString() });
    sendTelegramAlert("5min High: " + instrumentKey + " @ Rs." + ltp);
  }
}

module.exports = { connectWebSocket };