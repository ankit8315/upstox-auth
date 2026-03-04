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

// Full research bundle
app.get("/api/research", (req, res) => {
  const rd = global.researchData;
  res.json({
    lastUpdate:        rd.lastUpdate,
    isRefreshing:      rd.isRefreshing,
    marketOpen:        isMarketOpen(),
    aiReport:          rd.aiReport,
    enrichedWatchlist: rd.enrichedWatchlist || [],
    sectors:           rd.sectors,
    fiidii:            rd.fiidii,
    newsCount:         rd.news.length
  });
});

// Enriched watchlist only (lighter payload for watchlist tab)
app.get("/api/watchlist/enriched", (req, res) => {
  const rd  = global.researchData;
  const tl  = req.query.trafficLight; // GREEN | AMBER | RED
  let list  = rd.enrichedWatchlist || [];
  if (tl) list = list.filter(w => w.trafficLight === tl);
  res.json({
    count:         list.length,
    watchlist:     list,
    marketOutlook: rd.aiReport ? rd.aiReport.marketOutlook : null,
    generatedAt:   rd.aiReport ? rd.aiReport.analysisTimestamp : null
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

// Force refresh research now
app.post("/api/research/refresh", async (req, res) => {
  const { refreshResearch } = require("./researchEngine");
  refreshResearch();
  res.json({ message: "Research refresh triggered" });
});

// ── TraderBrain endpoints ─────────────────────────────────────────────────────

// GET exact trade calls — the main endpoint for TRADE tab
app.get("/api/trade-calls", (req, res) => {
  const rd  = global.researchData;
  const tc  = rd.tradeCalls || {};
  res.json({
    tradeCalls:    tc.calls        || [],
    traderMindset: tc.traderMindset|| "",
    marketRead:    tc.marketRead   || {},
    capitalPlan:   tc.capitalPlan  || {},
    skipList:      tc.skipList     || [],
    checklist:     tc.checklist    || [],
    thesisUpdates: rd.thesisUpdates|| null,
    generatedAt:   tc.generatedAt  || null,
    lastUpdate:    rd.lastUpdate
  });
});

// Force regenerate trade calls (invalidates cache)
app.post("/api/trade-calls/refresh", (req, res) => {
  const { invalidateCache } = require("./traderBrain");
  invalidateCache();
  const { refreshResearch } = require("./researchEngine");
  refreshResearch();
  res.json({ message: "Trade calls refresh triggered" });
});

app.get("/", (req, res) => res.json({
  status: "NSE Full Trading System",
  signals: breakouts.length,
  researchReady: !!global.researchData.aiReport,
  marketOpen: isMarketOpen()
}));

// ── Upstox Token Auto-Refresh ─────────────────────────────────────────────────
// Step 1: Visit http://YOUR_SERVER:3000/auth/login → redirects to Upstox login
// Step 2: Upstox redirects back with code → server auto-saves token to .env
// You only need to visit /auth/login once per day (bookmark it on phone)

const fs   = require("fs");
const path = require("path");

const UPSTOX_CLIENT_ID     = process.env.UPSTOX_CLIENT_ID     || "";
const UPSTOX_CLIENT_SECRET = process.env.UPSTOX_CLIENT_SECRET || "";
const UPSTOX_REDIRECT_URI  = process.env.UPSTOX_REDIRECT_URI  || "http://" + (process.env.SERVER_IP || "34.132.17.241") + ":3000/auth/callback";

app.get("/auth/login", (req, res) => {
  if (!UPSTOX_CLIENT_ID) {
    return res.send("Add UPSTOX_CLIENT_ID and UPSTOX_CLIENT_SECRET to .env first.<br>Get them from https://developer.upstox.com");
  }
  const url = "https://api.upstox.com/v2/login/authorization/dialog" +
    "?response_type=code" +
    "&client_id=" + UPSTOX_CLIENT_ID +
    "&redirect_uri=" + encodeURIComponent(UPSTOX_REDIRECT_URI);
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No auth code received from Upstox");

  try {
    const axios = require("axios");
    const resp  = await axios.post("https://api.upstox.com/v2/login/authorization/token", {
      code,
      client_id:     UPSTOX_CLIENT_ID,
      client_secret: UPSTOX_CLIENT_SECRET,
      redirect_uri:  UPSTOX_REDIRECT_URI,
      grant_type:    "authorization_code"
    }, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

    const newToken = resp.data.access_token;
    if (!newToken) throw new Error("No access_token in response");

    // Update .env file with new token
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.readFileSync(envPath, "utf8");
    if (envContent.includes("UPSTOX_ACCESS_TOKEN=")) {
      envContent = envContent.replace(/UPSTOX_ACCESS_TOKEN=.*/,  "UPSTOX_ACCESS_TOKEN=" + newToken);
    } else {
      envContent += "\nUPSTOX_ACCESS_TOKEN=" + newToken;
    }
    fs.writeFileSync(envPath, envContent);

    // Hot-reload the token — no restart needed
    process.env.UPSTOX_ACCESS_TOKEN = newToken;

    console.log("[Auth] Upstox token refreshed successfully at " +
      new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST");

    res.send(`
      <html><body style="font-family:monospace;background:#0a0a0a;color:#00ff88;padding:40px">
        <h2>✅ Upstox Token Refreshed!</h2>
        <p>New token saved to .env and activated immediately.</p>
        <p>No server restart needed.</p>
        <p><b>Bookmark this page on your phone:</b><br>
        <a style="color:#00ff88" href="/auth/login">http://34.132.17.241:3000/auth/login</a></p>
        <p>Visit it every morning before 9:15 AM to refresh your token.</p>
        <script>setTimeout(()=>window.close(),3000)</script>
      </body></html>
    `);
  } catch (e) {
    console.error("[Auth] Token refresh failed:", e.message);
    res.status(500).send("Token refresh failed: " + e.message);
  }
});

// Token status endpoint — shows if token is valid and when it was last refreshed
app.get("/auth/status", (req, res) => {
  const token = process.env.UPSTOX_ACCESS_TOKEN || "";
  res.json({
    hasToken:    token.length > 10,
    tokenPrefix: token.slice(0, 20) + "...",
    marketOpen:  isMarketOpen(),
    hint:        isMarketOpen() && !token ? "TOKEN MISSING — visit /auth/login NOW" : "OK"
  });
});

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
