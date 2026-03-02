const mongoose = require("mongoose");

async function initMongo() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.log("🟡 Mongo disabled. Running without database.");
    return;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000
    });
    console.log("✅ Mongo connected");
  } catch (err) {
    console.log("🟠 Mongo failed. Continuing without DB:", err.message);
  }
}

module.exports = { initMongo };