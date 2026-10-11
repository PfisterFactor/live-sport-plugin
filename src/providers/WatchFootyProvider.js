const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { findEmbedIframe } = require('./embedIframe');
const { parseTimezone } = require('../timezone');

class WatchFootyProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'WatchFooty';
    this.embedIndiaProvider = opts.embedIndiaProvider;
    // Hitting the /all endpoint to fetch 13+ sports instead of just football
    this.apiUrl = 'https://api.watchfooty.st/api/v1/matches/all';
    
    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      const headers = { 'User-Agent': DEFAULT_UA };
      const res = await this.proxyFetch(this.apiUrl, { headers, timeoutMs: 10000 });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.fetchMatchDetails = this.circuitBreaker.wrap(`${this.name}_fetchMatch`, async (matchId) => {
      const url = `https://api.watchfooty.st/api/v1/match/${matchId}`;
      const headers = { 'User-Agent': DEFAULT_UA };
      const res = await this.proxyFetch(url, { headers, timeoutMs: 10000 });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchMain.fire();
      
      if (Array.isArray(data)) {
        for (const item of data) {
          const matchId = item.matchId;
          const title = item.title || `${item.teams?.home?.name || 'Home'} vs ${item.teams?.away?.name || 'Away'}`;
          
          // CRITICAL: Only include matches that actually have streams available!
          // WatchFooty returns thousands of livescore-only fixtures with streams: []
          if (!Array.isArray(item.streams) || item.streams.length === 0) {
            continue;
          }

          let status = 'upcoming';
          
          if (item.status === 'in' || item.status === 'live') {
            status = 'live';
          } else if (item.status === 'post' || item.status === 'post-final' || item.status === 'postponed' || item.status === 'cancelled') {
            continue; // Skip ended matches
          } else if (item.status === 'pre') {
            // 'pre' means the fixture has NOT kicked off; keeping it distinct stops a
            // delayed match from showing as live once its nominal kickoff passes.
            status = 'pre';
          }

          const matchTime = item.timestamp ? parseTimezone(item.timestamp, 'UTC') : Date.now();
          
          // Map dynamic sports directly from the API
          const category = this.normalizeCategory(item.sport);

          const posterUrl = item.poster ? new URL(item.poster, 'https://api.watchfooty.st').toString() : null;

          matches.push(new MatchEntity({
            id: `wf_${matchId}`,
            title: title,
            category: category,
            status: status,
            timestamp: matchTime,
            poster: posterUrl,
            background: posterUrl,
            sources: [{ source: 'watchfooty', id: matchId }]
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    let skipped = 0;
    try {
      const data = await this.fetchMatchDetails.fire(sourceId);
      const match = Array.isArray(data) ? data[0] : data;
      
      if (match && match.streams && Array.isArray(match.streams)) {
        const dead = WatchFootyProvider._deadVariants;
        const now = Date.now();
        if (dead.size > 200) {
          for (const [k, v] of dead) if (v <= now) dead.delete(k);
        }

        let idx = 0;
        for (const s of match.streams) {
          if (s.url) {
            // An unreachable embed costs up to a minute of timeouts; remember it so
            // repeat requests skip it instead of paying again.
            if (!s.url.includes('.m3u8') && !s.url.includes('.mp4')) {
              const exp = dead.get(s.url);
              if (exp && exp > now) { skipped++; idx++; continue; }
              if (exp) dead.delete(s.url);
            }
            const isDirect = s.url.includes('.m3u8') || s.url.includes('.mp4');
            const entityParams = {
              name: `WatchFooty`,
              title: `WatchFooty Stream ${idx + 1}`,
              resolution: s.quality ? String(s.quality).toUpperCase() : 'SD'
            };
            
            if (isDirect) {
              entityParams.url = s.url;
              entityParams.behaviorHints = {
                notWebReady: true,
                proxyHeaders: {
                  request: {
                    "Origin": "https://watchfooty.st",
                    "Referer": "https://watchfooty.st/",
                    "User-Agent": DEFAULT_UA
                  }
                }
              };
              streams.push(new StreamEntity(entityParams));
            } else if (s.url.includes('sportsembed.su') || s.url.includes('watchfooty.st/embed')) {
              let resolvedViaIframe = false;
              try {
                const htmlRes = await this.proxyFetch(s.url, {
                  headers: { 'User-Agent': DEFAULT_UA, 'Referer': 'https://watchfooty.st/', 'Accept': 'text/html' },
                  timeoutMs: 6000,
                });
                const iframeSrc = findEmbedIframe(await htmlRes.text(), ['embedindia.st', 'embedindia.com', 'embedsport.xyz']);
                if (iframeSrc && iframeSrc.includes('embedindia') && this.embedIndiaProvider) {
                  console.log(`[WatchFootyProvider] Detected iframe redirect -> ${iframeSrc} for ${matchTitle}. Resolving via iframe provider.`);
                  const iframeReferer = new URL(iframeSrc).origin + '/';
                  const indiaStreams = await this.embedIndiaProvider.resolveStream(iframeSrc, matchCategory, matchTitle, { referer: iframeReferer });
                  if (indiaStreams.length > 0) {
                    indiaStreams.forEach((st) => {
                      st.name = 'WatchFooty';
                      st.title = st.title.replace('EmbedIndia', 'WatchFooty');
                    });
                    streams.push(...indiaStreams);
                    resolvedViaIframe = true;
                  }
                }
              } catch (e) {
                console.warn(`[WatchFootyProvider] Iframe detection failed for ${s.url}: ${e.message}`);
                dead.set(s.url, Date.now() + WatchFootyProvider.DEAD_TTL_MS);
              }

              if (!resolvedViaIframe) {
                try {
                    console.log(`[WatchFootyProvider] Triggering native extraction for: ${s.url}`);
                    const { extractSportsEmbed } = require('./SportsEmbedExtractor');
                    const { manifestProxyUrl } = require('../proxyUrl');
                    const m3u8Url = await extractSportsEmbed(s.url);
                    if (m3u8Url) {
                        console.log(`[WatchFootyProvider] Successfully extracted M3U8: ${m3u8Url}`);
                        const proxyUrl = manifestProxyUrl({
                          url: m3u8Url,
                          referer: 'https://sportsembed.su/',
                          renew: 'sportsembed',
                          embed: s.url,
                        });
                        entityParams.url = proxyUrl;
                        // wfty.st answers 403 without a Referer; declaring proxyHeaders lets
                        // pre-flight verification pass and lets clients send them too.
                        entityParams.behaviorHints = {
                          notWebReady: true,
                          proxyHeaders: {
                            request: {
                              'Referer': 'https://sportsembed.su/',
                              'Origin': 'https://sportsembed.su',
                              'User-Agent': DEFAULT_UA,
                            },
                          },
                        };
                        streams.push(new StreamEntity(entityParams));
                    }
                } catch (e) {
                    console.error(`[WatchFootyProvider] Native extract failed for ${s.url}`, e.message);
                    entityParams.externalUrl = this._webPlayerUrl(s.url, matchTitle);
                    streams.push(new StreamEntity(entityParams));
                }
              }
            } else {
              entityParams.externalUrl = this._webPlayerUrl(s.url, matchTitle);
              streams.push(new StreamEntity(entityParams));
            }
          }
          idx++;
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    if (skipped > 0) {
      console.log(`[WatchFootyProvider] Skipped ${skipped} known-dead embed variant(s) for ${sourceId}`);
    }
    return streams;
  }

  /** YouTube links open directly; every other embed goes through the web player page. */
  _webPlayerUrl(url, matchTitle) {
    if (/youtube\.com|youtu\.be/i.test(url)) return url;
    return `/watch?url=${encodeURIComponent(url)}&title=${encodeURIComponent(matchTitle || 'WatchFooty')}`;
  }
}

/** Embed variants that failed, url -> expiry (ms); expiry keeps a transient outage from being permanent. */
WatchFootyProvider._deadVariants = new Map();
WatchFootyProvider.DEAD_TTL_MS = Number(process.env.WATCHFOOTY_DEAD_TTL_MS || 5 * 60 * 1000);

module.exports = WatchFootyProvider;
