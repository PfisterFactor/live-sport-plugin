const container = require('./container');
const ChannelCountryService = require('./services/ChannelCountryService');
const { withRetry, isTransientStatus, isTransientError } = require('./services/retry');
const { parseLanguagePriority, compareStreams } = require('./services/LanguagePriorityService');

/**
 * Single source of truth for every selectable stream source: sort priority,
 * container registration, display label, whether it is on by default, and the
 * provider call shape (some providers take the raw source object as 4th arg).
 */
const SOURCES = {
  watchfooty: { priority: 2, registration: 'watchFootyProvider', label: 'WatchFooty', defaultEnabled: true, referer: 'https://watchfooty.st/' },
  cdnlive: { priority: 3, registration: 'cdnLiveProvider', label: 'CDNLiveTV', defaultEnabled: true, referer: 'https://cdnlivetv.tv/' },
  streamsports99: { priority: 4, registration: 'streamSports99Provider', label: 'StreamSports99', defaultEnabled: true, referer: 'https://streamsports99.is/' },
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
  ppv: { priority: 1.5, registration: 'ppvProvider', label: 'PPV', defaultEnabled: true, passSrc: true },
  streamedpk: { priority: 1.5, registration: 'streamedPkProvider', label: 'Streamed.pk', defaultEnabled: true, passSrc: true, referer: 'https://embed.st/' },
  streamcorner: { priority: 6, registration: 'streamCornerProvider', label: 'StreamCorner', defaultEnabled: true, referer: 'https://streamcorner.st/' },
  zlive: { priority: 7, registration: 'zliveProvider', label: 'ZLive', defaultEnabled: true, passSrc: true },
  replayzone: { priority: 2, registration: 'replayzoneProvider', label: 'ReplayZone', defaultEnabled: true, passSrc: true },
  livetv: { priority: 2, registration: 'liveTvProvider', label: 'LiveTV', defaultEnabled: true, passSrc: true },
  damitv: { priority: 3, registration: 'damiTvProvider', label: 'DamiTV', defaultEnabled: true, passSrc: true, referer: 'https://damitv.st/' },
  dlive: { priority: 10, registration: 'dliveProvider', label: 'DaddyLive', defaultEnabled: true, passSrc: true, referer: 'https://dlive.sx/' },
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

// How hard to try a provider before giving up on this source for the mint.
// Providers do multi-hop network work (embed page -> extractor -> CDN), so a
// single reset or edge timeout is common and is not evidence the source is
// dead; the budget stays small because handleStream races a soft deadline and a
// slow source simply lands in the resolve cache for the next request.
const RESOLVE_ATTEMPTS = Number(process.env.RESOLVE_ATTEMPTS || 2);
const RESOLVE_TOTAL_BUDGET_MS = Number(process.env.RESOLVE_TOTAL_BUDGET_MS || 12000);

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
    resStreams = await withRetry(
      () => container.resolve(entry.registration).resolveStream(...args),
      {
        attempts: RESOLVE_ATTEMPTS,
        baseDelayMs: 300,
        maxDelayMs: 1200,
        deadlineAt: Date.now() + RESOLVE_TOTAL_BUDGET_MS,
        label: `resolve:${src.source}`,
        // An empty result is a real answer, not a failure worth retrying.
        onRetry: ({ attempt, delay, error }) =>
          console.warn(`[streams.js] ${src.source}/${src.id} transient on attempt ${attempt} (${error.message}); retrying in ${delay}ms`),
      }
    ) || [];

    for (const s of resStreams) {
      s.score = streamScorer.calculateScore(s, src.source);
      s._source = src.source;
    }
  } catch (e) {
    if (isTransientError(e)) {
      console.warn(`[streams.js] ${src.source}/${src.id} unreachable after ${RESOLVE_ATTEMPTS} attempt(s): ${e.message}`);
    } else {
      console.warn(`[streams.js] Error resolving ${src.source} for ${src.id}:`, e.message);
    }
    resStreams = [];
  }

  return resStreams;
}

// Safe impit+undici helper — works on all platforms (Windows, Linux x64/ARM64, musl).
// impit is tried first for browser TLS fingerprinting; undici is the automatic fallback.
const impitClient = require('./impitClient');


// --- Stream Health Verification ---
// Pings each direct stream and drops dead ones (404/403/5xx, or 200 bodies
// that are not M3U8). Web player links, direct VOD files and (no url or
// '/watch?') pass through untouched. Runs once per mint (see
// mintVerifiedSources), not per request, so cached results are served without
// re-verification.

// How long one verification ping may take, and how long all its retries may
// take together. The total stays under handleStream's soft deadline so a
// retrying verification can still make it into the first response.
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 5000);
const VERIFY_TOTAL_BUDGET_MS = Number(process.env.VERIFY_TOTAL_BUDGET_MS || 9000);
const VERIFY_ATTEMPTS = Number(process.env.VERIFY_ATTEMPTS || 3);

const VERIFY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Registry of iframe/terminal hosts -> the Referer that makes them serve. It is
// advisory: verification must keep working with the hard-coded chain below, so
// every failure mode of this lookup resolves to null.
let _iframeDomainRegistry;
function getIframeDomainRegistry() {
  if (_iframeDomainRegistry !== undefined) return _iframeDomainRegistry;
  try {
    _iframeDomainRegistry = container.resolve('iframeDomainRegistry') || null;
  } catch (_) {
    _iframeDomainRegistry = null;
  }
  return _iframeDomainRegistry;
}

/**
 * Referer to retry a refused request with, derived from the host of the
 * upstream (terminal) URL. In order of authority:
 *   1. the iframe-domain registry, which records which page serves a given
 *      terminal host and so covers hosts added after this code was written;
 *   2. the host-regex chain, hard-coded knowledge for hosts the registry has
 *      never seen.
 */
function repairRefererFor(targetUrl) {
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch (_) {
    return 'https://sportsembed.su/';
  }
  if (!host) return 'https://sportsembed.su/';

  try {
    const registry = getIframeDomainRegistry();
    // knowsTerminalHost() first: refererFor() answers a generic self-origin for
    // anything it has never seen, which is indistinguishable from knowledge.
    if (registry && registry.knowsTerminalHost(host)) {
      const known = registry.terminalRefererFor(host);
      if (known) return known;
    }
  } catch (_) { /* fall through to the hard-coded chain */ }

  if (/\.wfty\.st$/.test(host) || /watchfooty/i.test(host)) return 'https://sportsembed.su/';
  if (/\.strmd\.st$/.test(host) || /streamed/i.test(host)) return 'https://embed.st/';
  if (/tiestep|dlive|dlstreams|daddylive|assetrage|romponalis/i.test(host) || /\.7odxv0l067ka\.net$/.test(host)) return 'https://assetrage.net/';
  if (/dynproclaim\.net$/.test(host)) return `https://${host}/`;
  if (/hockey\.do$/.test(host)) return 'https://play.matchli.st/';
  // streame.center rotates its edge nodes (edgestream2/5/7.pro all observed
  // live), so match the family, not one numbered host.
  if (/edgestream[0-9]*\.pro$/.test(host)) return 'https://streame.center/';
  if (/\.a737cozfwjmm\.net$/.test(host)) return 'https://assetrage.net/';
  return `https://${host}/`;
}

/** True for streams that are not HLS playlists and must not be pinged as one. */
function skipsVerification(s) {
  if (!s.url || s.url.includes('/watch?')) return true;
  if (s.url.includes('.mp4') || s.url.includes('pixeldrain.com') || s.url.includes('okcdn.ru')) return true;
  return !!(s.behaviorHints && s.behaviorHints.notWebReady === false);
}

async function verifyStreams(streams, cacheKey, m3u8Parser, resolveCache) {

  const checkedStreams = await Promise.all(streams.map(async (s) => {
    if (skipsVerification(s)) return s;

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
      if (!referer && s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) {
        referer = s.behaviorHints.proxyHeaders.request.Referer || '';
      }
      if (!origin && referer) {
        try { origin = new URL(referer).origin; } catch (_) {}
      }

      let res;
      let bodySample = '';

      const reqHeaders = { 'User-Agent': VERIFY_USER_AGENT, 'Referer': referer };
      if (origin) reqHeaders['Origin'] = origin;

      // A verification ping is one sample of a flaky path: a CDN edge mid-
      // rotation, a reset socket, a 503 under load. Retry the transient
      // answers, within a budget that keeps the whole verification inside
      // handleStream's soft deadline.
      const verifyDeadlineAt = Date.now() + VERIFY_TOTAL_BUDGET_MS;
      try {
        const result = await withRetry(
          async () => {
            // A fresh controller per attempt: one that already fired aborts the
            // retry the moment it starts.
            const attemptController = new AbortController();
            const attemptTimer = setTimeout(() => attemptController.abort(), VERIFY_TIMEOUT_MS);
            try {
              // attempts: 1 - retrying is this layer's job, so the two do not
              // compound into a multi-minute stall.
              const r = await impitClient.safeFetch(targetUrl, {
                method: 'GET',
                headers: reqHeaders,
                signal: attemptController.signal,
                timeoutMs: VERIFY_TIMEOUT_MS,
                attempts: 1,
              });
              return { status: r.status, body: await r.text() };
            } finally {
              clearTimeout(attemptTimer);
            }
          },
          {
            attempts: VERIFY_ATTEMPTS,
            deadlineAt: verifyDeadlineAt,
            label: 'verify',
            shouldRetryResult: (r) => isTransientStatus(r.status),
            onRetry: ({ attempt, delay, result, error }) => {
              const why = error ? error.message : `HTTP ${result.status}`;
              console.log(`[Filter] transient ${why} on attempt ${attempt}, retrying in ${delay}ms: ${targetUrl}`);
            },
          }
        );
        res = { status: result.status };
        bodySample = result.body;
      } catch (fetchErr) {
        const kind = isTransientError(fetchErr) ? 'unreachable after retries' : 'hard error';
        console.log(`[Filter] Dropped stream (${kind}): ${targetUrl} - ${fetchErr.message}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Two upstream behaviours answer 403/401 to an otherwise healthy stream,
      // and both are repaired by a Referer: some CDNs (WatchFooty's wfty.st
      // edge) refuse when it is MISSING; DaddyLive's segment CDN refuses when it
      // is PRESENT but from the wrong family. The candidate comes from the
      // TERMINAL host of the upstream URL and is tried at most ONCE, so a truly
      // dead stream costs one extra ping.
      if (res.status === 403 || res.status === 401) {
        try {
          const guess = repairRefererFor(targetUrl);
          // Re-sending the very Referer just refused would only double latency.
          if (guess && guess !== referer) {
            console.log(`[Filter] ${res.status} with ${referer ? `refused referer ${referer}` : 'no referer'}; retrying once with ${guess}`);
            const r2 = await impitClient.safeFetch(targetUrl, {
              method: 'GET',
              headers: {
                'User-Agent': reqHeaders['User-Agent'],
                'Referer': guess,
                'Origin': guess.replace(/\/$/, ''),
              },
              timeoutMs: VERIFY_TIMEOUT_MS,
              attempts: 1,
            });
            res = { status: r2.status };
            bodySample = await r2.text();
            if (res.status === 200) referer = guess;
          }
        } catch (_) { /* fall through to the dead-stream handling below */ }
      }

      // Edge servers return 404 for dead streams, 403 for IP-locked/expired tokens, 502 for upstream failures
      if (res.status === 404 || res.status === 403 || res.status >= 500) {
        // A 403 with no referer available at all is not proof of a dead stream:
        // keep it and let the client try rather than silently discard a source.
        if (res.status === 403 && !referer) {
          console.log(`[Filter] Keeping stream despite 403 (no referer available): ${targetUrl}`);
          return s;
        }
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
  if ((type !== 'tv' && type !== 'series' && type !== 'channel') || !id.startsWith('nuvio_sport_')) {
    return { streams: [] };
  }

  // Replay hubs address one episode as `<matchId>:hub_<n>:<index>`; a hub
  // selection resolves every stream of the match, never a single part.
  let rawId = id.replace('nuvio_sport_', '');
  let episodeIndex = null;
  let isHubEpisode = false;
  if (rawId.includes(':')) {
    const parts = rawId.split(':');
    rawId = parts[0];
    isHubEpisode = !!(parts[1] && parts[1].startsWith('hub_'));
    episodeIndex = parseInt(parts[2], 10);
  }
  const matchId = rawId;
  if (!matchId) return { streams: [] };

  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match || !match.sources || match.sources.length === 0) {
    return { streams: [] };
  }

  const streams = [];

  let candidateSources = match.sources;
  if (!isHubEpisode && episodeIndex && !isNaN(episodeIndex) && episodeIndex > 0) {
    const isMultiPart = match.sources.some(s => s.name && /(part|half|period)\s*\d+/i.test(s.name));
    if (isMultiPart) {
      const cleanSources = match.sources.filter(s => s && s.url && !s.source?.includes('timstreams'));
      if (cleanSources[episodeIndex - 1]) candidateSources = [cleanSources[episodeIndex - 1]];
    }
  }

  const activeSources = selectSources(candidateSources, config);
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

  // Several sources of one match can resolve to the same underlying clip (e.g.
  // LiveTV's sibling videos are re-listed by every clip page). Key on playable
  // identity so genuine multi-part streams are preserved.
  if (streams.length > 1) {
    const seen = new Set();
    const unique = streams.filter((s) => {
      const key = s.ytId ? `yt:${s.ytId}` : s.url ? `url:${s.url}` : s.externalUrl ? `ext:${s.externalUrl}` : null;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    streams.length = 0;
    streams.push(...unique);
  }

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
    
    // A /watch wrapper around a YouTube link is unwrapped so the client opens YouTube directly.
    if (s.externalUrl && s.externalUrl.includes('/watch?')) {
      const wrapped = s.externalUrl.match(/[?&](?:url|embed)=([^&]+)/);
      if (wrapped) {
        try {
          const decoded = decodeURIComponent(wrapped[1]);
          if (/youtube\.com|youtu\.be/i.test(decoded)) s.externalUrl = decoded;
        } catch (_) {}
      }
    }
    const isYouTube = !!s.ytId || (!!s.externalUrl && /youtube\.com|youtu\.be/i.test(s.externalUrl));
    if (isYouTube && s.ytId && !s.externalUrl) s.externalUrl = `https://www.youtube.com/watch?v=${s.ytId}`;

    const isWeb = !isYouTube && (!!s.externalUrl || s.name === 'Nuvio Web Player');
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
    s.name = isYouTube ? '▶️ YouTube' : isWeb ? '🌐 Web Stream' : '⚡ Direct Stream';

    let countryTag = '';
    if (channelName) {
      channelName = channelName.trim();
      const countryInfo = ChannelCountryService.detectChannelCountry(channelName);
      if (countryInfo) {
        countryTag = ` ${countryInfo.flag} [${countryInfo.name} • ${countryInfo.language}]`;
        s.language = countryInfo.language;
        s.country = countryInfo.name;
      }
    }

    // Replay clips carry their position in the title ("Part 2", "1st Half", ...).
    let partLabel = '';
    const partMatch = originalTitle.match(/(?:^|[\s\[\]])(Part\s*\d+|[12]nd\s*Half|[12]st\s*Half|Full\s*Match|Full\s*Replay|Long\s*Highlights?|Highlights?|\d+:\d+)(?:[\s\]\()]|$)/i);
    if (partMatch) partLabel = partMatch[1].trim();
    const lowerChannel = channelName.toLowerCase();
    if (channelName && (lowerChannel === 'direct' || lowerChannel === 'browser' || lowerChannel === 'ok.ru' || lowerChannel === partLabel.toLowerCase())) {
      channelName = '';
      countryTag = '';
    }

    const partDisplay = partLabel ? ` | 🎬 ${partLabel}` : '';
    const channelDisplay = channelName ? ` | 📺 ${channelName}${countryTag}` : '';
    const bitrateDisplay = s.bitrate ? ` | ${s.bitrate}` : '';
    s.title = `${icon} ${providerName}${partDisplay}${channelDisplay}\n📺 Quality: ${quality}${bitrateDisplay}${viewersText}`;
    
    // Add behaviorHints to group streams and handle CORS for direct streams
    s.behaviorHints = s.behaviorHints || {};
    s.behaviorHints.bingeGroup = `nuvio_sport_${matchId}`;
    
    // Segment CDNs gate on Referer/Origin even when the playlist is proxied,
    // and the player fetches segments directly.
    if (s.url && s.url.includes('.m3u8')) {
      s.behaviorHints.notWebReady = true;

      if (!s.behaviorHints.proxyHeaders) {
        let referer = null;
        let origin = null;
        if (s.url.includes('/api/manifest')) {
          try {
            const q = new URL(s.url, 'http://localhost').searchParams;
            referer = q.get('referer');
            origin = q.get('origin');
          } catch (_) {}
        } else {
          referer = REFERER_BY_LABEL[providerName];
        }
        if (referer) {
          if (!origin) { try { origin = new URL(referer).origin; } catch (_) { origin = referer; } }
          s.behaviorHints.proxyHeaders = { request: { Referer: referer, Origin: origin } };
        }
      }
    }
  });

  if (config && config.webStreams === 'disabled') {
    const playable = streams.filter(s => {
      if (s.name === '⚡ Direct Stream' || s.name === '▶️ YouTube') return true;
      if (s.name === '🌐 Web Stream') return false;
      return !(s.externalUrl && !s.ytId && !s.url);
    });
    if (playable.length < streams.length) {
      console.log(`[streams.js] Hid ${streams.length - playable.length} web stream(s) due to config for ${matchId}`);
      streams.length = 0;
      streams.push(...playable);
    }
  }

  // Direct streams first, then English -> the user's `languages` -> unknown ->
  // other languages, then score. See LanguagePriorityService.
  const languagePriorities = parseLanguagePriority(config);
  streams.sort((a, b) => compareStreams(a, b, languagePriorities));

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
  SOURCES,
  verifyStreams
};
