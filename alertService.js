const axios = require("axios");

// ── Rate-limited Telegram queue ───────────────────────────────────────────────
// Telegram allows ~1 msg/sec per chat. We use 3s gap to stay well under limit.
// On 429, we honour the retry_after value from the response.

const queue = [];
let busy    = false;
let blockedUntil = 0;

const MIN_INTERVAL_MS = 3000; // 3s between messages

async function drainQueue() {
  if (busy || queue.length === 0) return;
  busy = true;

  const wait = blockedUntil - Date.now();
  if (wait > 0) await sleep(wait);

  const message = queue.shift();
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: process.env.TELEGRAM_CHAT_ID, text: message },
      { timeout: 10000 }
    );
    console.log("📤 Telegram sent:", res.data.ok);
  } catch (err) {
    const data = err.response && err.response.data;
    if (data && data.error_code === 429) {
      const retryAfter = (data.parameters && data.parameters.retry_after) || 10;
      console.log(`⏳ Telegram rate limited — waiting ${retryAfter}s`);
      blockedUntil = Date.now() + retryAfter * 1000;
      // Re-queue the message that failed
      queue.unshift(message);
    } else {
      console.error("❌ Telegram error:", data || err.message);
      // Drop the message and move on
    }
  }

  busy = false;
  if (queue.length > 0) {
    const nextWait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - (blockedUntil - (blockedUntil > Date.now() ? blockedUntil - Date.now() : 0))));
    setTimeout(drainQueue, MIN_INTERVAL_MS);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTelegramAlert(message) {
  // Dedupe: don't queue the exact same message twice in a row
  if (queue.length > 0 && queue[queue.length - 1] === message) return;

  // Cap queue size — if >20 pending, drop oldest to avoid hours-long backlog
  if (queue.length >= 20) {
    console.log(`⚠️ Telegram queue full (${queue.length}), dropping oldest message`);
    queue.shift();
  }

  queue.push(message);
  setTimeout(drainQueue, 0);
}

module.exports = { sendTelegramAlert };