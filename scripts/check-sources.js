const { request } = require('undici');

const sources = [
  { name: 'WatchFooty', url: 'https://api.watchfooty.st/api/v1/matches/football' },
  { name: 'TimStreams', url: 'https://timst.cfd/api/live-upcoming' },
  { name: 'StreamSports', url: 'https://api.cdnlivetv.is/matches' },
  { name: 'StreamSports99', url: 'https://api.cdnlivetv.is/api/v1/events/sports/?user=streamsports99&plan=vip' },
  { name: 'Streamic', url: 'https://streamic.st/api/J.php' },
  { name: 'StreamFree', url: 'https://streamfree.top/streams' },
  { name: 'SportyHunter', url: 'https://sportyhunter.xyz' },
  { name: 'PPV / BinTv', url: 'https://api.ppv.st/api/streams' },
  { name: 'NTV', url: 'http://ntv.cx' },
  { name: 'CdnLive', url: 'https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free' }
];

async function checkSources() {
  console.log('Checking streaming sources...\n');
  
  const results = await Promise.allSettled(sources.map(async (source) => {
    try {
      const response = await request(source.url, { method: 'GET', headersTimeout: 10000, bodyTimeout: 10000 });
      response.body.dump();
      if (response.statusCode >= 400) {
        return { ...source, status: 'FAILED', error: `HTTP ${response.statusCode}` };
      }
      return { ...source, status: 'OK', statusCode: response.statusCode };
    } catch (error) {
      return { ...source, status: 'FAILED', error: error.message };
    }
  }));

  results.forEach(result => {
    if (result.status === 'fulfilled') {
      const res = result.value;
      if (res.status === 'OK') {
        console.log(`[✓] ${res.name.padEnd(16)} | RUNNING | ${res.url}`);
      } else {
        console.log(`[✗] ${res.name.padEnd(16)} | DOWN    | ${res.error} | ${res.url}`);
      }
    } else {
      console.log(`[✗] Failed to process ${result.reason}`);
    }
  });
  
  console.log('\nFinished checking all sources.');
}

checkSources();
