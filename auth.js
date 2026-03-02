// auth.js — Main entry point with order confirmation API
require("dotenv").config();
const express    = require("express");
const { loadInstruments }  = require("./instrumentLoader");
const { startPoller }      = require("./poller");
const { executeBuy }       = require("./orderManager");
const { getOpenPositions, getAllPositions, getTodayPnL } = require("./riskEngine");

const app         = express();
const PORT        = process.env.PORT || 3000;
const accessToken = process.env.UPSTOX_ACCESS_TOKEN;

app.use(express.json());

if (!accessToken) { console.error("UPSTOX_ACCESS_TOKEN missing"); process.exit(1); }

// ── In-memory stores ──────────────────────────────────────────────────
const breakouts = [];    // trade opportunities (pending)
const trades    = [];    // executed + closed trades

global.addBreakout = (data) => {
  // Avoid duplicate signals for same stock within 2 mins
  const recent = breakouts.find(b => b.symbol === data.symbol && Date.now() - new Date(b.time).getTime() < 120000);
  if (recent) return;
  breakouts.unshift(data);
  if (breakouts.length > 100) breakouts.pop();
};

global.addTrade = (data) => {
  trades.unshift(data);
  if (trades.length > 200) trades.pop();
};

global.updateTradeStatus = (id, status, orderId) => {
  const b = breakouts.find(b => b.id === id);
  if (b) { b.status = status; if (orderId) b.orderId = orderId; }
};

// ── Routes ────────────────────────────────────────────────────────────

// All pending signals
app.get("/api/breakouts", (req, res) => {
  const limit  = parseInt(req.query.limit) || 50;
  const type   = req.query.type;
  const grade  = req.query.grade;
  let data = breakouts;
  if (type)  data = data.filter(b => b.type === type);
  if (grade) data = data.filter(b => b.grade === grade);
  res.json({ count: data.length, data: data.slice(0, limit) });
});

// Confirm a trade (user taps BUY in app)
app.post("/api/confirm-trade", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });

  const opportunity = breakouts.find(b => b.id === id);
  if (!opportunity) return res.status(404).json({ error: "Signal not found or expired" });
  if (!opportunity.canTrade) return res.status(400).json({ error: opportunity.cantTradeReason });
  if (opportunity.status !== "pending") return res.status(400).json({ error: "Already " + opportunity.status });

  opportunity.status = "confirming";
  const result = await executeBuy(accessToken, opportunity);

  if (result.success) {
    opportunity.status = "placed";
    opportunity.orderId = result.orderId;
    res.json({ success: true, orderId: result.orderId, message: "Order placed!" });
  } else {
    opportunity.status = "failed";
    res.status(500).json({ success: false, error: result.reason });
  }
});

// Skip a signal
app.post("/api/skip-trade", (req, res) => {
  const { id } = req.body;
  const b = breakouts.find(b => b.id === id);
  if (b) b.status = "skipped";
  res.json({ success: true });
});

// Open positions
app.get("/api/positions", (req, res) => {
  res.json({ positions: getOpenPositions(), todayPnL: getTodayPnL() });
});

// Trade history
app.get("/api/trades", (req, res) => {
  res.json({ count: trades.length, trades: trades.slice(0, 50), todayPnL: getTodayPnL() });
});

// Dashboard summary
app.get("/api/status", (req, res) => {
  const open = getOpenPositions();
  res.json({
    status: "running",
    signals: breakouts.filter(b => b.status === "pending").length,
    openPositions: open.length,
    todayPnL: getTodayPnL(),
    time: new Date().toISOString()
  });
});

app.get("/", (req, res) => res.json({ status: "NSE Full Trading System", signals: breakouts.length }));

// ── Start ─────────────────────────────────────────────────────────────
async function start() {
  console.log("Starting NSE Full Trading System...");
  const instruments = await loadInstruments();
  if (instruments.length === 0) { console.error("No instruments loaded"); process.exit(1); }
  await startPoller(accessToken, instruments);
}

app.listen(PORT, "0.0.0.0", () => { console.log("Server on port " + PORT); start(); });
