// preBreakoutEngine.js
// Detects PRE-BREAKOUT conditions BEFORE a stock moves 5%+
//
// Signals (fires BEFORE the move):
//   🔥 VOLUME_SURGE   — 3x volume, price flat = accumulation
//   ⚡ COILING        — tight range + tick acceleration = spring loading
//   🌊 SECTOR_FOLLOW  — sector leader moved, laggard hasn't yet
//   📰 NEWS_CATALYST  — fresh news, price hasn't reacted
//   🚀 IGNITION       — 2+ signals + price starting to move = enter now

const { sendTelegramAlert } = require("./alertService");

const stockState     = {};   // per-symbol tick/volume history
const sectorMoves    = {};   // sector → { leader, movePct, time }
const alertCooldown  = {};   // symbol → last alert ms
const volumeBaseline = {};   // symbol → { baseline, samples, lockedAt }

const ALERT_COOLDOWN_MS   = 10 * 60 * 1000;
const BASELINE_WINDOW_MS  = 30 * 60 * 1000;
const VOLUME_SURGE_RATIO  = 3.0;
const VOLUME_WARN_RATIO   = 2.0;
const COIL_RANGE_PCT      = 0.8;
const SECTOR_LAG_MAX_PCT  = 1.0;
const SECTOR_LEAD_MIN_PCT = 2.5;
const NEWS_STALE_MS       = 30 * 60 * 1000;

// ── Main entry — call on every tick ──────────────────────────────────────────
// extraData: { openPrice, sector, volumeToday, avgVolume, high52w, news[] }
function processTick(symbol, ltp, extraData) {
  const now = Date.now();

  // Init state
  if (!stockState[symbol]) {
    stockState[symbol] = {
      ticks:     [],
      volumes:   [],
      openPrice: ltp,
      peakPrice: ltp
    };
  }

  const s = stockState[symbol];
  s.ticks.push({ price: ltp, time: now });
  s.volumes.push({ time: now });
  s.peakPrice = Math.max(s.peakPrice, ltp);

  // Keep 15 min rolling window
  const cutoff15 = now - 15 * 60 * 1000;
  const cutoff5  = now - 5  * 60 * 1000;
  s.ticks   = s.ticks.filter(t => t.time > cutoff15);
  s.volumes = s.volumes.filter(t => t.time > cutoff15);

  // Market hours only: 9:30–15:15
  const ist  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  if (mins < 9 * 60 + 30 || mins > 15 * 60 + 15) return;

  updateBaseline(symbol, now, s);

  // Track sector moves for contagion detection
  const openPrice = (extraData && extraData.openPrice > 0) ? extraData.openPrice : s.openPrice;
  if (extraData && extraData.sector && openPrice > 0) {
    const movePct = ((ltp - openPrice) / openPrice) * 100;
    if (movePct >= SECTOR_LEAD_MIN_PCT) {
      const existing = sectorMoves[extraData.sector];
      if (!existing || movePct > existing.movePct) {
        sectorMoves[extraData.sector] = { leader: symbol, movePct, time: now };
        console.log("[preBreakout] Sector leader: " + symbol + " +" + movePct.toFixed(1) + "% in " + extraData.sector);
      }
    }
  }

  // Run all checks
  const volAlert    = checkVolumeSurge(symbol, ltp, s, now, extraData);
  const coilAlert   = checkCoiling(symbol, ltp, s, now, cutoff5);
  const sectorAlert = checkSectorContagion(symbol, ltp, extraData, now);
  const newsAlert   = checkNewsCatalyst(symbol, ltp, extraData, now);
  const ignition    = checkIgnition(symbol, ltp, s, now, volAlert, coilAlert, newsAlert);

  const alerts = [volAlert, coilAlert, sectorAlert, newsAlert, ignition].filter(Boolean);
  if (alerts.length === 0) return;

  // Fire only the highest priority alert
  const best = alerts.sort((a, b) => b.priority - a.priority)[0];
  sendAlert(symbol, ltp, best, extraData);
}

// ── 1. Volume Surge ───────────────────────────────────────────────────────────
function checkVolumeSurge(symbol, ltp, s, now, extraData) {
  const baseline = volumeBaseline[symbol];
  if (!baseline || baseline.samples.length < 5) return null;

  // Tick-based volume ratio
  const cutoff5 = now - 5 * 60 * 1000;
  const recent5 = s.volumes.filter(t => t.time > cutoff5).length;
  const ratio   = baseline.baseline > 0 ? (recent5 / 5) / baseline.baseline : 0;

  // Actual volume ratio if available
  let actualRatio = 0;
  if (extraData && extraData.volumeToday > 0 && extraData.avgVolume > 0) {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hoursElapsed = Math.max(0.5, ist.getHours() - 9.5);
    actualRatio = ((extraData.volumeToday / hoursElapsed) * 6.25) / extraData.avgVolume;
  }

  const effectiveRatio = Math.max(ratio, actualRatio);

  // Price must NOT have moved yet (pre-breakout condition)
  const openPrice  = (extraData && extraData.openPrice > 0) ? extraData.openPrice : s.openPrice;
  const priceMoved = openPrice > 0 ? Math.abs((ltp - openPrice) / openPrice) * 100 : 0;

  if (effectiveRatio >= VOLUME_SURGE_RATIO && priceMoved < 2.0) {
    return { type: "VOLUME_SURGE", emoji: "🔥", priority: 80,
      msg: "Volume " + effectiveRatio.toFixed(1) + "x normal — price barely moved (" + priceMoved.toFixed(1) + "%) — accumulation" };
  }
  if (effectiveRatio >= VOLUME_WARN_RATIO && priceMoved < 1.5) {
    return { type: "VOLUME_BUILDING", emoji: "👀", priority: 50,
      msg: "Volume building " + effectiveRatio.toFixed(1) + "x normal — watch closely" };
  }
  return null;
}

// ── 2. Coiling ────────────────────────────────────────────────────────────────
function checkCoiling(symbol, ltp, s, now, cutoff5) {
  const ticks5 = s.ticks.filter(t => t.time > cutoff5);
  if (ticks5.length < 10) return null;

  const prices   = ticks5.map(t => t.price);
  const mid      = (Math.max(...prices) + Math.min(...prices)) / 2;
  const rangePct = mid > 0 ? ((Math.max(...prices) - Math.min(...prices)) / mid) * 100 : 0;

  const half1 = ticks5.slice(0, Math.floor(ticks5.length / 2)).length;
  const half2 = ticks5.slice(Math.floor(ticks5.length / 2)).length;
  const accel  = half1 > 0 ? half2 / half1 : 1;

  if (rangePct < COIL_RANGE_PCT && accel > 1.5 && ticks5.length > 15) {
    return { type: "COILING", emoji: "⚡", priority: 70,
      msg: "Price coiling (" + rangePct.toFixed(2) + "% range 5min) — tick rate " + accel.toFixed(1) + "x — spring loading" };
  }
  return null;
}

// ── 3. Sector Contagion ───────────────────────────────────────────────────────
function checkSectorContagion(symbol, ltp, extraData, now) {
  if (!extraData || !extraData.sector) return null;
  const move = sectorMoves[extraData.sector];
  if (!move || move.leader === symbol) return null;
  if (now - move.time > 60 * 60 * 1000) return null;

  const open     = (extraData.openPrice > 0) ? extraData.openPrice : ltp;
  const thisMoved = open > 0 ? ((ltp - open) / open) * 100 : 0;

  if (thisMoved < SECTOR_LAG_MAX_PCT && move.movePct >= SECTOR_LEAD_MIN_PCT) {
    return { type: "SECTOR_FOLLOW", emoji: "🌊", priority: 65,
      msg: move.leader + " already +" + move.movePct.toFixed(1) + "% in " + extraData.sector + " — this laggard hasn't moved yet" };
  }
  return null;
}

// ── 4. News Catalyst ──────────────────────────────────────────────────────────
function checkNewsCatalyst(symbol, ltp, extraData, now) {
  if (!extraData || !extraData.news || extraData.news.length === 0) return null;

  const fresh = extraData.news.filter(n => {
    const age = now - new Date(n.publishedAt || 0).getTime();
    return age > 0 && age < NEWS_STALE_MS;
  });
  if (fresh.length === 0) return null;

  const open     = (extraData.openPrice > 0) ? extraData.openPrice : ltp;
  const priceMoved = open > 0 ? ((ltp - open) / open) * 100 : 0;

  if (priceMoved < 1.5) {
    return { type: "NEWS_CATALYST", emoji: "📰", priority: 75,
      msg: "Fresh news, price flat (" + priceMoved.toFixed(1) + "%) — not priced in yet: " + (fresh[0].title || "").slice(0, 70) };
  }
  return null;
}

// ── 5. Ignition ───────────────────────────────────────────────────────────────
function checkIgnition(symbol, ltp, s, now, volAlert, coilAlert, newsAlert) {
  const fired = [volAlert, coilAlert, newsAlert].filter(Boolean);
  if (fired.length < 2) return null;

  const cutoff3 = now - 3 * 60 * 1000;
  const t3 = s.ticks.filter(t => t.time > cutoff3);
  if (t3.length < 5) return null;

  const micro = t3[0].price > 0 ? ((t3[t3.length-1].price - t3[0].price) / t3[0].price) * 100 : 0;

  if (micro > 0.3 && micro < 3.0) {
    return { type: "IGNITION", emoji: "🚀", priority: 95,
      msg: fired.length + " signals aligned + price +" + micro.toFixed(2) + "% in 3min — ENTER NOW" };
  }
  return null;
}

// ── Volume baseline ───────────────────────────────────────────────────────────
function updateBaseline(symbol, now, s) {
  if (!volumeBaseline[symbol]) {
    volumeBaseline[symbol] = { baseline: 0, samples: [], lockedAt: 0 };
  }
  const b = volumeBaseline[symbol];
  if (b.lockedAt > 0) return; // already locked

  const marketOpen = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  marketOpen.setHours(9, 30, 0, 0);
  const elapsed = now - marketOpen.getTime();

  if (elapsed < BASELINE_WINDOW_MS) {
    const bucket = Math.floor(elapsed / 60000);
    if (!b.samples[bucket]) b.samples[bucket] = 0;
    b.samples[bucket]++;
  } else if (b.samples.length > 5) {
    const valid = b.samples.filter(Boolean);
    b.baseline = valid.reduce((a, c) => a + c, 0) / valid.length;
    b.lockedAt = now;
    console.log("[preBreakout] Baseline locked: " + symbol + " = " + b.baseline.toFixed(1) + " ticks/min");
  }
}

// ── Send Telegram alert ───────────────────────────────────────────────────────
function sendAlert(symbol, ltp, alert, extraData) {
  const now = Date.now();
  if (now - (alertCooldown[symbol] || 0) < ALERT_COOLDOWN_MS) return;
  alertCooldown[symbol] = now;

  const sector = (extraData && extraData.sector) || "?";
  const open   = extraData && extraData.openPrice > 0 ? extraData.openPrice : ltp;
  const chg    = open > 0 ? (((ltp - open) / open) * 100).toFixed(2) : "?";
  const dist52 = extraData && extraData.high52w > 0
    ? "\n📍 " + (((extraData.high52w - ltp) / ltp) * 100).toFixed(1) + "% to 52W high ₹" + extraData.high52w
    : "";

  const msg =
    alert.emoji + " PRE-BREAKOUT: " + symbol + "\n" +
    "₹" + ltp + " (" + (chg >= 0 ? "+" : "") + chg + "%) | " + sector + "\n\n" +
    alert.type + ": " + alert.msg +
    dist52 + "\n\n" +
    "⏱ Act before it moves.";

  console.log("[preBreakout] " + alert.emoji + " " + symbol + " — " + alert.type);
  sendTelegramAlert(msg);

  if (global.addPreBreakout) {
    global.addPreBreakout({
      symbol, price: ltp, type: alert.type,
      emoji: alert.emoji, msg: alert.msg,
      sector, change: parseFloat(chg),
      time: new Date().toISOString(), priority: alert.priority
    });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function registerSectorMove(symbol, sector, movePct) {
  if (!sector || movePct < SECTOR_LEAD_MIN_PCT) return;
  const existing = sectorMoves[sector];
  if (!existing || movePct > existing.movePct) {
    sectorMoves[sector] = { leader: symbol, movePct, time: Date.now() };
  }
}

function getPreBreakoutCandidates() {
  const now = Date.now();
  return Object.entries(alertCooldown)
    .filter(([, t]) => now - t < ALERT_COOLDOWN_MS)
    .map(([symbol]) => ({ symbol, alertedAt: alertCooldown[symbol] }))
    .sort((a, b) => b.alertedAt - a.alertedAt);
}

module.exports = { processTick, registerSectorMove, getPreBreakoutCandidates, stockState, sectorMoves };