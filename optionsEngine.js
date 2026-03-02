// optionsEngine.js
// Fetches options chain data for F&O stocks
// Extracts: PCR, max pain, OI buildup, smart money direction

const axios = require("axios");

const cache = {};
const CACHE_MS = 3 * 60 * 1000; // 3 min cache

async function fetchOptionsChain(symbol) {
  const cleanSymbol = symbol.replace("NSE_EQ|", "");
  const cacheKey = "opt_" + cleanSymbol;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].time < CACHE_MS) {
    return cache[cacheKey].data;
  }

  try {
    const resp = await axios.get(
      "https://www.nseindia.com/api/option-chain-equities?symbol=" + cleanSymbol,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.nseindia.com/option-chain",
          "Connection": "keep-alive"
        },
        timeout: 10000
      }
    );

    const data = resp.data;
    const result = analyzeOptionsChain(data, cleanSymbol);
    cache[cacheKey] = { data: result, time: Date.now() };
    return result;

  } catch (e) {
    // Options data optional — don't crash
    return null;
  }
}

function analyzeOptionsChain(data, symbol) {
  if (!data || !data.records || !data.records.data) return null;

  const records  = data.records.data;
  const spotPrice = data.records.underlyingValue || 0;
  const expiries  = data.records.expiryDates || [];
  const nearExpiry = expiries[0]; // nearest expiry

  // Filter to nearest expiry
  const nearRecords = records.filter(r => r.expiryDate === nearExpiry);

  let totalCallOI = 0, totalPutOI  = 0;
  let callOIByStrike = {}, putOIByStrike = {};
  let maxCallOI = 0, maxPutOI = 0;
  let maxCallStrike = 0, maxPutStrike = 0;

  nearRecords.forEach(r => {
    const strike = r.strikePrice;
    const callOI = r.CE ? r.CE.openInterest || 0 : 0;
    const putOI  = r.PE ? r.PE.openInterest || 0 : 0;

    totalCallOI += callOI;
    totalPutOI  += putOI;
    callOIByStrike[strike] = callOI;
    putOIByStrike[strike]  = putOI;

    if (callOI > maxCallOI) { maxCallOI = callOI; maxCallStrike = strike; }
    if (putOI  > maxPutOI)  { maxPutOI  = putOI;  maxPutStrike  = strike; }
  });

  // Put-Call Ratio
  const pcr = totalCallOI > 0 ? parseFloat((totalPutOI / totalCallOI).toFixed(2)) : 0;

  // PCR interpretation
  let pcrSentiment;
  if (pcr > 1.5)      pcrSentiment = "very_bullish";  // too many puts = contrarian buy
  else if (pcr > 1.2) pcrSentiment = "bullish";
  else if (pcr > 0.8) pcrSentiment = "neutral";
  else if (pcr > 0.5) pcrSentiment = "bearish";
  else                pcrSentiment = "very_bearish";

  // Max pain = strike where options buyers lose most
  const maxPain = calculateMaxPain(callOIByStrike, putOIByStrike);

  // OI buildup near spot (within 2%)
  const nearStrikes = nearRecords.filter(r =>
    Math.abs(r.strikePrice - spotPrice) / spotPrice < 0.02
  );
  const nearCallOIChange = nearStrikes.reduce((s, r) => s + (r.CE ? r.CE.changeinOpenInterest || 0 : 0), 0);
  const nearPutOIChange  = nearStrikes.reduce((s, r) => s + (r.PE ? r.PE.changeinOpenInterest || 0 : 0), 0);

  // Smart money direction
  let smartMoneyDirection = "neutral";
  if (nearPutOIChange > nearCallOIChange * 1.5)  smartMoneyDirection = "bullish";  // put writing = expect up
  else if (nearCallOIChange > nearPutOIChange * 1.5) smartMoneyDirection = "bearish"; // call writing = expect down

  // Resistance = max call OI strike (call writers defending)
  // Support = max put OI strike (put writers defending)
  const resistanceLevel = maxCallStrike;
  const supportLevel    = maxPutStrike;

  // Is price near resistance? (within 0.5%)
  const nearResistance = spotPrice > 0 &&
    Math.abs(spotPrice - resistanceLevel) / spotPrice < 0.005;

  return {
    symbol, spotPrice, expiry: nearExpiry,
    pcr, pcrSentiment,
    totalCallOI, totalPutOI,
    maxPain,
    resistanceLevel,  // where call writers will defend
    supportLevel,     // where put writers will defend
    smartMoneyDirection,
    nearResistance,   // if true = be cautious buying here
    nearCallOIChange, nearPutOIChange,
    score: getOptionsScore(pcr, smartMoneyDirection, nearResistance)
  };
}

function calculateMaxPain(callOI, putOI) {
  const strikes = Object.keys(callOI).map(Number).sort((a, b) => a - b);
  let minPain = Infinity, maxPainStrike = 0;

  strikes.forEach(targetStrike => {
    let totalPain = 0;
    strikes.forEach(strike => {
      // Call pain at this strike
      if (targetStrike > strike) {
        totalPain += callOI[strike] * (targetStrike - strike);
      }
      // Put pain at this strike
      if (targetStrike < strike) {
        totalPain += putOI[strike] * (strike - targetStrike);
      }
    });
    if (totalPain < minPain) { minPain = totalPain; maxPainStrike = targetStrike; }
  });

  return maxPainStrike;
}

function getOptionsScore(pcr, smartMoney, nearResistance) {
  let score = 0;
  if (pcr > 1.2)           score += 20;
  else if (pcr > 0.8)      score += 10;
  else if (pcr < 0.5)      score -= 10;
  if (smartMoney === "bullish")   score += 20;
  else if (smartMoney === "neutral") score += 5;
  else if (smartMoney === "bearish") score -= 15;
  if (nearResistance)      score -= 10; // buying near resistance = risky
  return score;
}

module.exports = { fetchOptionsChain };
