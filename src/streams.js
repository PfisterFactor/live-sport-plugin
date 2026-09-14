const container = require('./container');

/**
 * Single source of truth for every selectable stream source: sort priority,
 * container registration, display label, whether it is on by default, and the
 * provider call shape (some providers take the raw source object as 4th arg).
 */
const SOURCES = {
  watchfooty: { priority: 2, registration: 'watchFootyProvider', label: 'WatchFooty', defaultEnabled: true, referer: 'https://watchfooty.st/' },
  cdnlive: { priority: 3, registration: 'cdnLiveProvider', label: 'CDNLiveTV', defaultEnabled: true, referer: 'https://cdnlivetv.tv/' },
  streamsports99: { priority: 4, registration: 'streamSports99Provider', label: 'StreamSports99', defaultEnabled: true, referer: 'https://streamsports99.fun/' },
  streamic: { priority: 5, registration: 'streamicProvider', label: 'Streamic', defaultEnabled: true, passSrc: true, referer: 'https://streamic.st/' },
  streamfree: {
    priority: 8,
    registration: 'streamFreeProvider',
    label: 'StreamFree',
    defaultEnabled: true,
    args: (src, match) => [src.id, src.original_category || match.category, match.title],
  },
  timstreams: { priority: 9, registration: 'timStreamsProvider', label: 'TimStreams', defaultEnabled: true },
  sportyhunter: { priority: 12, registration: 'sportyHunterProvider', label: 'SportyHunter', defaultEnabled: true, referer: 'https://sportyhunter.xyz/' },
  embedindia: { priority: 15, registration: 'embedIndiaProvider', label: 'EmbedIndia', defaultEnabled: false, passSrc: true },
  embedst: { priority: 1.5, registration: 'embedStProvider', label: 'Embed.st', defaultEnabled: true, passSrc: true },
  streamedpk: { priority: 1.5, registration: 'streamedPkProvider', label: 'Streamed.pk', defaultEnabled: true, passSrc: true, referer: 'https://embed.st/' },
};

// Unknown sources are likely new Streamed.pk sub-sources - 1.5 keeps them near the top.
const UNKNOWN_PRIORITY = 1.5;

const REFERER_BY_LABEL = Object.fromEntries(
  Object.values(SOURCES).filter(s => s.referer).map(s => [s.label, s.referer])
);

function selectSources(matchSources, config) {
  const sorted = [...matchSources].sort((a, b) => {
    const pa = SOURCES[a.source]?.priority ?? UNKNOWN_PRIORITY;
    const pb = SOURCES[b.source]?.priority ?? UNKNOWN_PRIORITY;
    return pa - pb;
  });

  if (config && typeof config.sources === 'string' && config.sources !== 'none') {
    const enabled = config.sources.split(',');
    return sorted.filter(src => SOURCES[src.source] && enabled.includes(src.source));
  }

  return sorted.filter(src => SOURCES[src.source]?.defaultEnabled);
}

async function resolveSource(src, match) {
  const entry = SOURCES[src.source];
  if (!entry) return [];

  const streamScorer = container.resolve('streamScorer');
  let resStreams = [];

  try {
    const args = entry.args
      ? entry.args(src, match)
      : entry.passSrc
        ? [src.id, match.category, match.title, src]
        : [src.id, match.category, match.title];
    resStreams = await container.resolve(entry.registration).resolveStream(...args);

    for (const s of resStreams) {
      s.score = streamScorer.calculateScore(s, src.source);
      s._source = src.source;
    }
  } catch (e) {
    console.warn(`[streams.js] Error resolving ${src.source} for ${src.id}:`, e.message);
  }

  return resStreams;
}

// Safe impit+undici helper — works on all platforms (Windows, Linux x64/ARM64, musl).
// impit is tried first for browser TLS fingerprinting; undici is the automatic fallback.
const impitClient = require('./impitClient');


// --- Stream Health Verification ---
// Pings each direct stream once and drops dead ones (404/403/5xx, or 200 bodies
// that are not M3U8). Web player links (no url or '/watch?') pass through
// untouched. Runs once per mint (see mintVerifiedSources), not per request, so
// cached results are served without re-verification.
async function verifyStreams(streams, cacheKey, m3u8Parser, resolveCache) {

  const checkedStreams = await Promise.all(streams.map(async (s) => {
    // We only pre-flight check direct streams (m3u8 urls). Web player links are kept blindly.
    if (!s.url || s.url.includes('/watch?')) return s;

    let targetUrl = s.url;
    let referer = '';
    let origin = '';
    // If the stream is routed through our manifest proxy, we extract the true upstream URL to ping
    if (targetUrl.includes('/api/manifest')) {
      try {
        const urlObj = new URL('http://localhost' + targetUrl);
        if (urlObj.searchParams.has('url')) {
          targetUrl = urlObj.searchParams.get('url');
        }
        if (urlObj.searchParams.has('referer')) {
          referer = urlObj.searchParams.get('referer');
        }
        if (urlObj.searchParams.has('origin')) {
          origin = urlObj.searchParams.get('origin');
        }
      } catch (e) {}
    }

    try {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 5000); // 5 second timeout to allow slow edge CDNs (wfty/strmd) to respond

      if (!referer && s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) {
        referer = s.behaviorHints.proxyHeaders.request.Referer || '';
      }
      if (!origin && referer) {
        try { origin = new URL(referer).origin; } catch (_) {}
      }

      let res;
      let bodySample = '';

      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': referer
      };
      if (origin) reqHeaders['Origin'] = origin;

      try {
        // safeFetch handles impit -> undici fallback automatically on all platforms
        const result = await impitClient.safeFetch(targetUrl, {
          method: 'GET',
          headers: reqHeaders,
          signal: abortController.signal,
          timeoutMs: 5000,
        });
        res = { status: result.status };
        bodySample = await result.text();
      } catch (fetchErr) {
        clearTimeout(timeout);
        console.log(`[Filter] Dropped timeout/error stream: ${targetUrl} - ${fetchErr.message}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      clearTimeout(timeout);

      // Edge servers return 404 for dead streams, 403 for IP-locked/expired tokens, 502 for upstream failures
      if (res.status === 404 || res.status === 403 || res.status >= 500) {
        console.log(`[Filter] Dropped dead stream (${res.status}): ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Some CDNs (like lb8.strmd.st) return 200 OK with "Not found" when token is expired.
      // If it doesn't contain #EXT, it's not a valid m3u8 playlist.
      if (!bodySample.includes('#EXT')) {
        console.log(`[Filter] Dropped fake 200 stream (Invalid M3U8 body): ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Parse Master Playlist quality, framerate (FPS), and bitrate in real-time
      const parsedQuality = m3u8Parser.parseManifestText(bodySample);
      if (parsedQuality) {
        if (parsedQuality.qualityTag) s.quality = parsedQuality.qualityTag;
        if (parsedQuality.resolution) s.resolution = parsedQuality.resolution;
        if (parsedQuality.bitrateTag) s.bitrate = parsedQuality.bitrateTag;
      }

      if (cacheKey) resolveCache.noteSuccess(cacheKey);
      return s;
    } catch (err) {
      console.log(`[Filter] Dropped timeout/error stream: ${targetUrl} - ${err.message}`);
      return null;
    }
  }));

  return checkedStreams.filter(Boolean);
}

// Mint streams for a single source and health-verify them before they enter the
// cache, so verification runs once per mint instead of on every request.
async function mintVerifiedSources(src, match, cacheKey) {
  const resolveCache = container.resolve('streamResolveCache');
  const m3u8Parser = container.resolve('m3u8Parser');
  const minted = await resolveSource(src, match);
  return verifyStreams(minted, cacheKey, m3u8Parser, resolveCache);
}

// Prewarm: mint tokens for a match's top sources before the user clicks
async function prewarmMatch(match, config, topN = 3) {
  try {
    if (!match || !match.sources || !match.sources.length) return;
    const resolveCache = container.resolve('streamResolveCache');
    const activeSources = selectSources(match.sources, config || null);
    const targets = activeSources.slice(0, topN);
    if (targets.length === 0) return;
    console.log(`[Prewarm] minting ${targets.length} sources for ${match.id}`);
    await Promise.allSettled(targets.map(src => {
      const key = `${src.source}:${match.id}:${src.id}`;
      if (resolveCache.get(key)) return Promise.resolve(null);
      return resolveCache.getOrCreate(key, () => mintVerifiedSources(src, match, key));
    }));
  } catch (err) {
    console.warn('[Prewarm] failed:', err.message);
  }
}

// Response budget for a stream request. At the soft deadline we answer with
// whatever resolved, provided there is at least one stream; otherwise we keep
// waiting to the hard deadline rather than hand the player an empty list.
function streamDeadlines() {
  return {
    soft: parseInt(process.env.STREAM_SOFT_DEADLINE_MS, 10) || 4500,
    hard: parseInt(process.env.STREAM_HARD_DEADLINE_MS, 10) || 12000,
  };
}

/** Resolves when every task settles, or at a deadline `hasResult()` permits. */
async function settleWithin(tasks, hasResult) {
  if (tasks.length === 0) return;
  const { soft, hard } = streamDeadlines();
  let finished = false;
  const all = Promise.all(tasks).then(() => { finished = true; });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

  await Promise.race([all, sleep(soft)]);
  if (finished || hasResult()) return;
  await Promise.race([all, sleep(Math.max(hard - soft, 0))]);
}


async function handleStream(type, id, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { streams: [] };
  }

  const matchId = id.replace('nuvio_sport_', '');
  
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match || !match.sources || match.sources.length === 0) {
    return { streams: [] };
  }

  const streams = [];

  const activeSources = selectSources(match.sources, config);
  const streamScorer = container.resolve('streamScorer');

  const resolveCache = container.resolve('streamResolveCache');

  // Sources that miss the deadline keep running into the resolve cache, so the
  // next request for this match serves them from a warm entry.
  const collected = [];
  const tasks = activeSources.map((src) => {
    const key = `${src.source}:${matchId}:${src.id}`;
    return resolveCache.getOrCreate(key, () => mintVerifiedSources(src, match, key))
      .then((minted) => {
        for (const s of minted) collected.push({ ...s, _cacheKey: key });
      })
      .catch((e) => console.warn(`[streams.js] Resolve failed for ${key}:`, e.message));
  });

  // --- Inject relevant 24/7 channels based on category ---
  const isStreamFreeEnabled = !config || !config.sources || config.sources === 'none' || config.sources.split(',').includes('streamfree');
  if (match.category === 'cricket' && isStreamFreeEnabled) {
    const extraChannels = [
      { id: 'willow', title: 'Willow TV' },
      { id: 'skycricket', title: 'Sky Sports Cricket' }
    ];
    for (const channel of extraChannels) {
      const key = `streamfree:__channel__:${channel.id}`;
      tasks.push(
        resolveCache.getOrCreate(key, () => mintVerifiedSources(
          { source: 'streamfree', id: channel.id, original_category: 'cricket' },
          { category: 'cricket', title: channel.title },
          key
        ))
          .then((resolved) => {
            for (const s of resolved) {
              collected.push({ ...s, _cacheKey: key, _source: 'streamfree', score: streamScorer.calculateScore(s, 'streamfree') });
            }
          })
          .catch((e) => console.warn('[streams.js] Error injecting 24/7 cricket channels:', e.message))
      );
    }
  }

  await settleWithin(tasks, () => collected.length > 0);
  streams.push(...collected);

  // Standardize Stream Labels
  const sportIcons = {
    football: '⚽', cricket: '🏏', motorsport: '🏎️',
    basketball: '🏀', american_football: '🏈', rugby: '🏉', networks: '📺'
  };
  const icon = sportIcons[match.category] || '📡';
  
  const niceNames = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.label]));

  streams.forEach(s => {
    let quality = s.resolution || s.quality || 'Auto';
    if (String(quality).includes('x')) {
       const h = String(quality).split('x')[1];
       quality = h + 'p';
    }
    
    const isWeb = !!s.externalUrl || s.name === 'Nuvio Web Player';
    const titleText = (s.title || '').toLowerCase();
    let providerName = niceNames[s._source]
      || niceNames[Object.keys(niceNames).find(k => titleText.includes(k))]
      || 'Streamed.pk';

    if (titleText.includes('timstreams')) providerName = 'TimStreams';
    else if (titleText.includes('sporty')) providerName = 'SportyHunter';
    else if (titleText.includes('streamfree')) providerName = 'StreamFree';
    else if (titleText.includes('watchfooty')) providerName = 'WatchFooty';
    else if (titleText.includes('cdnlive')) providerName = 'CDNLiveTV';
    else if (titleText.includes('streamsports99')) providerName = 'StreamSports99';
    else if (titleText.includes('streamic')) providerName = 'Streamic';

    let originalTitle = s.title || '';
    let channelName = '';
    let viewersText = '';
    if (originalTitle) {
      const vMatch = originalTitle.match(/👥\s*\d+\s*Viewers/);
      if (vMatch) viewersText = `\n${vMatch[0]}`;

      const match = originalTitle.match(/\(([^)]+)\)/);
      if (match && match[1]) {
        const inner = match[1];
        if (!inner.match(/^[0-9]{3,4}p$/i) && inner !== 'Auto' && !inner.toLowerCase().startsWith('stream')) {
          channelName = inner;
        }
      } else if (!originalTitle.includes('Stream') && !originalTitle.includes('Auto')) {
        channelName = originalTitle;
      }
    }
    // Determine Group
    s.name = isWeb ? '🌐 Web Stream' : '⚡ Direct Stream';
    
    if (channelName) {
      // Don't format title case if it breaks our channel name. Actually, just clean it up slightly.
      channelName = channelName.trim();
    }
    
    const channelDisplay = channelName ? ` | 📺 ${channelName}` : '';
    const bitrateDisplay = s.bitrate ? ` | ${s.bitrate}` : '';
    s.title = `${icon} ${providerName}${channelDisplay}\n📺 Quality: ${quality}${bitrateDisplay}${viewersText}`;
    
    // Add behaviorHints to group streams and handle CORS for direct streams
    s.behaviorHints = s.behaviorHints || {};
    s.behaviorHints.bingeGroup = `nuvio_sport_${matchId}`;
    
    // If it's a direct m3u8 stream and not routed through our proxy, mark it notWebReady
    if (s.url && s.url.includes('.m3u8') && !s.url.includes('/api/manifest')) {
      s.behaviorHints.notWebReady = true;

      const referer = REFERER_BY_LABEL[providerName];
      if (referer && !s.behaviorHints.proxyHeaders) {
        s.behaviorHints.proxyHeaders = { request: { Referer: referer, Origin: referer } };
      }
    }
  });

  // Sort streams: Direct streams first, then by score descending
  streams.sort((a, b) => {
    const aIsDirect = a.name === '⚡ Direct Stream' ? 1 : 0;
    const bIsDirect = b.name === '⚡ Direct Stream' ? 1 : 0;
    if (aIsDirect !== bIsDirect) return bIsDirect - aIsDirect;
    return b.score - a.score;
  });

  // Verification now happens once per mint (mintVerifiedSources), not per request.
  // Adaptive per-source TTLs keep tokens fresh, so clients may hold the list 30s.
  // An empty list may just mean a source missed the deadline and is still
  // minting in the background, so it must not be cached.
  if (streams.length === 0) return { streams, cacheMaxAge: 0 };

  return {
    streams,
    cacheMaxAge: 30,
    staleRevalidate: 30,
    staleError: 60
  };
}

module.exports = {
  handleStream,
  prewarmMatch,
  selectSources,
  resolveSource,
  SOURCES
};
