const fetch  = require("node-fetch");
const zlib   = require("zlib");
const csv    = require("csv-parser");
const stream = require("stream");

async function loadInstruments() {
  try {
    console.log("Downloading NSE instrument master...");

    const response = await fetch(
      "https://assets.upstox.com/market-quote/instruments/exchange/complete.csv.gz",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    if (!response.ok) throw new Error("HTTP " + response.status);

    const buffer  = await response.buffer();
    const unzipped = zlib.gunzipSync(buffer);
    const results  = [];

    await new Promise((resolve, reject) => {
      const readable = new stream.PassThrough();
      readable.end(unzipped);
      readable.pipe(csv())
        .on("data", (row) => {
          if (
            row.exchange        === "NSE_EQ" &&
            row.instrument_type === "EQUITY" &&
            row.lot_size        === "1" &&
            parseFloat(row.last_price) > 1 &&
            /^[A-Z][A-Z0-9&-]{0,19}$/.test(row.tradingsymbol)
          ) {
            results.push({
              key:   row.instrument_key,
              price: parseFloat(row.last_price)
            });
          }
        })
        .on("end", resolve)
        .on("error", reject);
    });

    // Sort by price descending (higher price = more liquid typically)
    // Take top 500 to stay within Upstox rate limits
    results.sort((a, b) => b.price - a.price);
    const top = results.slice(0, 500).map(r => r.key);

    console.log("Loaded top " + top.length + " NSE EQ instruments");
    return top;

  } catch (error) {
    console.error("Failed to load instruments:", error.message);
    return [];
  }
}

module.exports = { loadInstruments };