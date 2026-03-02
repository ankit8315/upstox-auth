function updateCandle(state, price, volume, timestamp) {
  const fiveMin = 5 * 60 * 1000;
  const bucket = Math.floor(timestamp / fiveMin) * fiveMin;

  if (!state.currentCandle || state.currentCandle.start !== bucket) {
    if (state.currentCandle) {
      state.candles.push(state.currentCandle);
    }

    state.currentCandle = {
      start: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volume
    };
  } else {
    state.currentCandle.high = Math.max(state.currentCandle.high, price);
    state.currentCandle.low = Math.min(state.currentCandle.low, price);
    state.currentCandle.close = price;
    state.currentCandle.volume += volume;
  }
}
module.exports = { updateCandle };