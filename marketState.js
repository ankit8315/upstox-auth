const marketState = {};

function updateTick(symbol, price, volume, timestamp) {
  if (!marketState[symbol]) {
    marketState[symbol] = {
      lastPrice: price,
      totalVolume: volume,
      candles: [],
      currentCandle: null,
      vwap: 0,
      cumulativePV: 0,
      cumulativeVolume: 0,
      lastSignalTime: 0
    };
  }

  const state = marketState[symbol];

  state.lastPrice = price;
  state.totalVolume = volume;

  // VWAP calculation
  state.cumulativePV += price * volume;
  state.cumulativeVolume += volume;

  if (state.cumulativeVolume > 0) {
    state.vwap = state.cumulativePV / state.cumulativeVolume;
  }

  return state;
}

module.exports = { updateTick, marketState };