const axios = require("axios");

async function sendTelegramAlert(message) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
      }
    );
    console.log("📤 Telegram sent:", res.data.ok);
  } catch (err) {
    console.error("❌ Telegram error:", err.response?.data || err.message);
  }
}

module.exports = { sendTelegramAlert };