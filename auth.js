// auth.js — Main server entry point
require("dotenv").config();
const express  = require("express");
const { loadInstruments }      = require("./instrumentLoader");
const { startPoller }          = require("./poller");
const { executeBuy }           = require("./orderManager");
const { startResearchEngine }  = require("./researchEngine");
const { getOpenPositions, getAllPositions, getTodayPnL } = require("./riskEngine");

const app         = express();
const PORT        = process.env.PORT || 3000;
const accessToken = process.env.UPSTOX_ACCESS_TOKEN;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

if (!accessToken) { console.error("UPSTOX_ACCESS_TOKEN missing"); process.exit(1); }

// ── In-memory stores ──────────────────────────────────────────────────
const breakouts = [];
const trades    = [];

global.addBreakout = (data) => {
  const recent = breakouts.find(b => b.symbol === data.symbol && Date.now() - new Date(b.time).getTime() < 120000);
  if (recent) return;
  breakouts.unshift(data);
  if (breakouts.length > 100) breakouts.pop();
};

global.addTrade = (data) => { trades.unshift(data); if (trades.length > 200) trades.pop(); };
global.updateTradeStatus = (id, status, orderId) => {
  const b = breakouts.find(b => b.id === id);
  if (b) { b.status = status; if (orderId) b.orderId = orderId; }
};

// ── Trading Routes ────────────────────────────────────────────────────

app.get("/api/breakouts", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const type  = req.query.type;
  const grade = req.query.grade;
  let data = breakouts;
  if (type)  data = data.filter(b => b.type === type);
  if (grade) data = data.filter(b => b.grade === grade);
  res.json({ count: data.length, data: data.slice(0, limit) });
});

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

app.post("/api/skip-trade", (req, res) => {
  const b = breakouts.find(b => b.id === req.body.id);
  if (b) b.status = "skipped";
  res.json({ success: true });
});

app.get("/api/positions", (req, res) => {
  res.json({ positions: getOpenPositions(), todayPnL: getTodayPnL() });
});

app.get("/api/trades", (req, res) => {
  res.json({ count: trades.length, trades: trades.slice(0, 50), todayPnL: getTodayPnL() });
});

app.get("/api/status", (req, res) => {
  const open = getOpenPositions();
  res.json({
    status: "running",
    signals: breakouts.filter(b => b.status === "pending").length,
    openPositions: open.length,
    todayPnL: getTodayPnL(),
    marketOpen: isMarketOpen(),
    researchReady: !!global.researchData.aiReport,
    time: new Date().toISOString()
  });
});

// ── Research Routes ───────────────────────────────────────────────────

// Full research bundle (most important — app polls this)
app.get("/api/research", (req, res) => {
  const rd = global.researchData;
  res.json({
    lastUpdate:   rd.lastUpdate,
    isRefreshing: rd.isRefreshing,
    marketOpen:   isMarketOpen(),
    aiReport:     rd.aiReport,
    sectors:      rd.sectors,
    fiidii:       rd.fiidii,
    newsCount:    rd.news.length
  });
});

// News with optional category filter
app.get("/api/news", (req, res) => {
  const category = req.query.category;
  let news = global.researchData.news || [];
  if (category) news = news.filter(n => n.category === category);
  res.json({ count: news.length, news: news.slice(0, 30) });
});

// Tomorrow's watchlist only
app.get("/api/watchlist", (req, res) => {
  const report = global.researchData.aiReport;
  res.json({
    watchlist:     report ? report.watchlist      || [] : [],
    marketOutlook: report ? report.marketOutlook  || {} : {},
    generatedAt:   report ? report.generatedAt    : null
  });
});

// Sector heatmap
app.get("/api/sectors", (req, res) => {
  res.json(global.researchData.sectors || { sectors: [], breadth: {} });
});

// FII/DII
app.get("/api/fiidii", (req, res) => {
  res.json(global.researchData.fiidii || {});
});

// Force refresh research now (useful for testing)
app.post("/api/research/refresh", async (req, res) => {
  const { refreshResearch } = require("./researchEngine");
  refreshResearch();
  res.json({ message: "Research refresh triggered" });
});

app.get("/", (req, res) => res.json({
  status: "NSE Full Trading System",
  signals: breakouts.length,
  researchReady: !!global.researchData.aiReport,
  marketOpen: isMarketOpen()
}));

// ── Helpers ───────────────────────────────────────────────────────────

function isMarketOpen() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const d = now.getDay(), h = now.getHours(), m = now.getMinutes();
  if (d === 0 || d === 6) return false;
  if (h < 9 || (h === 9 && m < 15)) return false;
  if (h > 15 || (h === 15 && m > 35)) return false;
  return true;
}

// ── Start ─────────────────────────────────────────────────────────────

async function start() {
  console.log("Starting NSE Full Trading System + Research Engine...");

  // Research engine runs always (market open or closed)
  startResearchEngine();

  // Trading engine only during market hours (poller handles its own check)
  const instruments = await loadInstruments();
  if (instruments.length === 0) { console.error("No instruments loaded"); process.exit(1); }
  await startPoller(accessToken, instruments);
}

app.listen(PORT, "0.0.0.0", () => { console.log("Server on port " + PORT); start(); });
