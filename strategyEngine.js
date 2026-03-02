function evaluateBreakout(symbol, state) {
  if (state.candles.length < 2) return null;

  const lastClosed = state.candles[state.candles.length - 1];
  const price = state.lastPrice;

  const volumeSpike = state.currentCandle.volume > lastClosed.volume * 1.5;
  const aboveVWAP = price > state.vwap;
  const breakout = price > lastClosed.high;

  const now = Date.now();

  if (
    breakout &&
    volumeSpike &&
    aboveVWAP &&
    now - state.lastSignalTime > 60_000
  ) {
    state.lastSignalTime = now;

    return {
      symbol,
      price,
      vwap: state.vwap,
      breakoutLevel: lastClosed.high,
      time: new Date().toISOString()
    };
  }

  return null;
}

module.exports = { evaluateBreakout };