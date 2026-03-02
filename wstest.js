require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

async function test() {
  const r = await axios.get('https://api.upstox.com/v3/feed/market-data-feed', {
    headers: { Authorization: 'Bearer ' + process.env.UPSTOX_ACCESS_TOKEN, 'Api-Version': '3' },
    maxRedirects: 0,
    validateStatus: s => s === 302
  });

  const ws = new WebSocket(r.headers.location);
  let count = 0;

  ws.on('open', () => {
    console.log('CONNECTED');
    ws.send(JSON.stringify({
      guid: 'test1', method: 'subscribe',
      data: { mode: 'ltpc', instrumentKeys: ['NSE_EQ|INE002A01018','NSE_EQ|INE040A01034'] }
    }));
  });

  ws.on('message', (data) => {
    count++;
    console.log('MSG #' + count + ' size=' + data.length + ' hex=' + data.slice(0,20).toString('hex'));
    if (count >= 5) { ws.close(); process.exit(0); }
  });

  ws.on('error', e => console.error('ERROR:', e.message));
  ws.on('close', c => console.log('CLOSED:', c));
  setTimeout(() => { console.log('TIMEOUT msgs=' + count); process.exit(1); }, 20000);
}
test().catch(e => console.error(e.response && e.response.status, e.message));
