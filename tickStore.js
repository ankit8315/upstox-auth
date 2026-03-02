const tickStore = {};

/*
Structure:
{
  instrumentKey: {
     ticks: [],
     high5Min: number,
     lastBreakoutTime: timestamp
  }
}
*/

function updateTick(instrumentKey, ltp) {
  const now = Date.now();

  if (!tickStore[instrumentKey]) {
    tickStore[instrumentKey] = {
      ticks: [],
      high5Min: 0,
      lastBreakoutTime: 0
    };
  }

  const data = tickStore[instrumentKey];

  data.ticks.push({ price: ltp, time: now });

  // Remove ticks older than 5 min
  data.ticks = data.ticks.filter(
    t => now - t.time <= 5 * 60 * 1000
  );

  data.high5Min = Math.max(...data.ticks.map(t => t.price));

  return data;
}

module.exports = { updateTick, tickStore };