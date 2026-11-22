/**
 * DashToHlsService.js — MPEG-DASH to HLS v7 converter for ClearKey streams.
 *
 * The playlists point back at this server (`/api/dash/init.mp4`,
 * `/api/dash/segment.mp4`); the route decrypts each CENC fragment in memory and
 * serves plaintext fMP4, so the output is ordinary unencrypted HLS. No
 * `#EXT-X-KEY` is ever emitted.
 *
 * This class owns manifest parsing, live-window computation, playlist
 * rendering and the representation/segment lookup the routes need; ISO-BMFF
 * bytes are `cenc/*`'s business. `#EXT-X-MEDIA-SEQUENCE` is the DASH `$Number$`
 * of the first window segment, so it slides with the upstream SegmentTimeline.
 */

'use strict';

const { BROWSER_UA, safeFetch } = require('../impitClient');
const { parseXml, childrenNamed, firstChild } = require('./MpdXml');
const { buildPolicy, fetchGuarded } = require('./DashUpstream');

const DALVIK_UA_RE = /dalvik/i;
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);

const MPD_CACHE_TTL_MS = 3000;
const MPD_CACHE_MAX_ENTRIES = 120;
const CTX_CACHE_TTL_MS = Number(process.env.DASH_CTX_TTL_MS) || 60000;
const CTX_CACHE_MAX_ENTRIES = 60;
const MAX_WINDOW_SEGMENTS = 15;
const LIVE_EDGE_TRIM_SEGMENTS = 1;
const AUDIO_GROUP_ID = 'aud';

/**
 * Parses an ISO 8601 duration (PT12H34M56.78S) into seconds; 0 when malformed.
 * @param {string} str
 * @returns {number}
 */
function parseIsoDuration(str) {
  if (!str || typeof str !== 'string') return 0;
  const m = str.match(/^[-+]?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  return (y ? parseFloat(y) * 365 * 86400 : 0) + (mo ? parseFloat(mo) * 30 * 86400 : 0) +
    (d ? parseFloat(d) * 86400 : 0) + (h ? parseFloat(h) * 3600 : 0) +
    (mi ? parseFloat(mi) * 60 : 0) + (s ? parseFloat(s) : 0);
}

/**
 * Substitutes DASH `$Identifier$` templates ($RepresentationID$, $Number$,
 * $Time$, $Bandwidth$, optional `%0Nd` width; `$$` is a literal dollar).
 * @param {string} template
 * @param {{representationId: string, bandwidth: number, number: number, time: number}} vars
 * @returns {string}
 */
function fillSegmentTemplate(template, vars) {
  return template
    .replace(/\$\$/g, '\u0000')
    .replace(/\$RepresentationID\$/g, String(vars.representationId))
    .replace(/\$Bandwidth\$/g, String(vars.bandwidth))
    .replace(/\$Number%0(\d+)d\$/g, (_, width) => String(vars.number).padStart(parseInt(width, 10), '0'))
    .replace(/\$Number\$/g, String(vars.number))
    .replace(/\$Time%0(\d+)d\$/g, (_, width) => String(vars.time).padStart(parseInt(width, 10), '0'))
    .replace(/\$Time\$/g, String(vars.time))
    .replace(/\u0000/g, '$');
}

/**
 * Resolves `uri` against `base`, returning `uri` unchanged when that fails.
 * @param {string} uri
 * @param {string} base
 * @returns {string}
 */
function absolutize(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch (_) {
    return uri;
  }
}

/** Converts DASH manifests to HLS playlists and maps playlist entries back to upstream URLs. */
class DashToHlsService {
  /**
   * @param {{fetcher?: Function}} [options]
   *   `fetcher` is safeFetch-shaped (tests inject a fake)
   */
  constructor(options = {}) {
    this._fetcher = options.fetcher || safeFetch;
    this._mpdCache = new Map();
    this._ctxCache = new Map();
  }

  /**
   * Request headers for upstream fetches: Dalvik UAs (Akamai answers 403) are
   * replaced, hop-by-hop headers and Host overrides dropped.
   * @param {Object<string, string>} [headers]
   * @returns {Object<string, string>}
   */
  _sanitizeUpstreamHeaders(headers = {}) {
    const out = {};
    let chosenUa = '';
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      const lower = name.toLowerCase();
      if (lower === 'user-agent') {
        if (!chosenUa && !DALVIK_UA_RE.test(value)) chosenUa = value;
        continue;
      }
      if (DROPPED_REQUEST_HEADERS.has(lower)) continue;
      out[name] = value;
    }
    out['User-Agent'] = chosenUa || BROWSER_UA;
    out.Accept = out.Accept || '*/*';
    return out;
  }

  /**
   * Fetches and parses the MPD; concurrent callers share one fetch and the
   * result is reused for MPD_CACHE_TTL_MS.
   * @param {string} mpdUrl
   * @param {object} headers
   * @returns {Promise<object>} the parseMpd() result
   */
  _fetchParsedMpd(mpdUrl, headers) {
    const cached = this._mpdCache.get(mpdUrl);
    if (cached && Date.now() - cached.ts < MPD_CACHE_TTL_MS) return cached.promise;

    const promise = (async () => {
      const res = await fetchGuarded(mpdUrl, {
        fetcher: this._fetcher,
       
        headers: this._sanitizeUpstreamHeaders(headers),
        timeoutMs: 10000,
        attempts: 2
      });
      if (!res || !res.ok) throw new Error(`Upstream MPD fetch failed (HTTP ${res && res.status})`);
      return this.parseMpd(await res.text(), mpdUrl);
    })();

    this._mpdCache.set(mpdUrl, { ts: Date.now(), promise });
    promise.catch(() => {
      if (this._mpdCache.get(mpdUrl) && this._mpdCache.get(mpdUrl).promise === promise) this._mpdCache.delete(mpdUrl);
    });
    if (this._mpdCache.size > MPD_CACHE_MAX_ENTRIES) this._mpdCache.delete(this._mpdCache.keys().next().value);
    return promise;
  }

  /**
   * Parses an MPD into video and audio representations (highest bandwidth
   * first) of its live period, each with its current segment window.
   * @param {string} xml
   * @param {string} mpdUrl  base for relative URLs
   * @returns {{dynamic: boolean, videoReps: object[], audioReps: object[]}}
   * @throws {Error} when the document is not a usable, supported MPD
   */
  parseMpd(xml, mpdUrl) {
    let mpd;
    try {
      mpd = parseXml(xml);
    } catch (err) {
      throw new Error(`MPD XML parse error: ${err.message}`);
    }
    if (mpd.name !== 'MPD') throw new Error('Not an MPEG-DASH manifest (no <MPD> root)');

    const periods = childrenNamed(mpd, 'Period');
    if (periods.length === 0) throw new Error('MPD has no <Period>');

    const hasTemplate = (a) => firstChild(a, 'SegmentTemplate') ||
      childrenNamed(a, 'Representation').some((r) => firstChild(r, 'SegmentTemplate'));
    const period = [...periods].reverse().find((p) => childrenNamed(p, 'AdaptationSet').some(hasTemplate));
    if (!period) throw new Error('MPD has no period with SegmentTemplate');

    const mpdBase = this._resolveBase(childrenNamed(mpd, 'BaseURL'), mpdUrl);
    const periodBase = this._resolveBase(childrenNamed(period, 'BaseURL'), mpdBase);
    const ctx = {
      dynamic: String(mpd.attrs.type || 'static').toLowerCase() === 'dynamic',
      availabilityStartTime: Date.parse(mpd.attrs.availabilityStartTime || '') || 0,
      timeShiftBufferSec: parseIsoDuration(mpd.attrs.timeShiftBufferDepth || ''),
      periodStartSec: parseIsoDuration(period.attrs.start || '0')
    };

    const videoReps = [];
    const audioReps = [];
    let cbcsSkipped = false;

    for (const set of childrenNamed(period, 'AdaptationSet')) {
      const setTemplate = this._templateAttrs(firstChild(set, 'SegmentTemplate'));
      const setMime = String(set.attrs.mimeType || set.attrs.contentType || '');
      const setProtection = this._readProtection(childrenNamed(set, 'ContentProtection'));

      for (const node of childrenNamed(set, 'Representation')) {
        const template = this._templateAttrs(firstChild(node, 'SegmentTemplate'), setTemplate);
        const mime = String(node.attrs.mimeType || setMime);
        const kind = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : null;
        if (!kind || !template || !template.media) continue;

        const protection = this._readProtection(childrenNamed(node, 'ContentProtection')) || setProtection;
        if (protection === 'cbcs') {
          cbcsSkipped = true;
          continue;
        }

        const baseUrl = this._resolveBase(childrenNamed(node, 'BaseURL'), periodBase);
        const representationId = String(node.attrs.id !== undefined ? node.attrs.id : '');
        const bandwidth = Number(node.attrs.bandwidth || 0);
        const rep = {
          kind,
          id: representationId,
          bandwidth,
          codecs: String(node.attrs.codecs || set.attrs.codecs || ''),
          width: Number(node.attrs.width || set.attrs.width || 0),
          height: Number(node.attrs.height || set.attrs.height || 0),
          lang: String(node.attrs.lang || set.attrs.lang || ''),
          encryption: protection,
          timescale: Number(template.timescale || 1) || 1,
          baseUrl,
          mediaTemplate: absolutize(String(template.media), baseUrl),
          initUrl: template.initialization
            ? absolutize(fillSegmentTemplate(template.initialization, { representationId, bandwidth, number: 0, time: 0 }), baseUrl)
            : '',
          segments: this._computeSegments(template, { ...ctx, representationId, bandwidth, baseUrl })
        };
        if (rep.segments.length === 0) continue;
        rep.segmentShape = this._shapeOf(rep.segments, rep.timescale);
        (kind === 'video' ? videoReps : audioReps).push(rep);
      }
    }

    if (videoReps.length === 0) {
      throw new Error(cbcsSkipped ? 'MPD is cbcs-protected (unsupported)' : 'MPD exposes no video representations');
    }
    videoReps.sort((a, b) => b.bandwidth - a.bandwidth);
    audioReps.sort((a, b) => b.bandwidth - a.bandwidth);
    return { dynamic: ctx.dynamic, videoReps, audioReps };
  }

  /**
   * Flattens a SegmentTemplate element over inherited attributes.
   * @param {object|null} node
   * @param {object|null} [base]
   * @returns {object|null}
   */
  _templateAttrs(node, base = null) {
    if (!node) return base;
    const attrs = { ...(base || {}) };
    for (const key of ['media', 'initialization', 'timescale', 'duration', 'startNumber', 'presentationTimeOffset']) {
      if (node.attrs[key] !== undefined) attrs[key] = node.attrs[key];
    }
    const timeline = firstChild(node, 'SegmentTimeline');
    if (timeline) attrs.timeline = timeline;
    return attrs;
  }

  /**
   * Common-encryption scheme declared by `urn:mpeg:dash:mp4protection`.
   * @param {object[]} entries  ContentProtection elements
   * @returns {'cenc'|'cbcs'|'cens'|'cbc1'|null}
   */
  _readProtection(entries) {
    for (const cp of entries) {
      if (String(cp.attrs.schemeIdUri || '').toLowerCase().includes('mp4protection')) {
        return String(cp.attrs.value || 'cenc').toLowerCase();
      }
    }
    return null;
  }

  /**
   * Resolves the last non-empty BaseURL against `parent`.
   * @param {object[]} baseUrlNodes
   * @param {string} parent
   * @returns {string}
   */
  _resolveBase(baseUrlNodes, parent) {
    for (let i = baseUrlNodes.length - 1; i >= 0; i--) {
      const candidate = baseUrlNodes[i].text.trim();
      if (candidate) return absolutize(candidate, parent);
    }
    return parent;
  }

  /**
   * Enumerates the live window as [{number, time, durationSec, url}].
   * SegmentTimeline mode trusts the server's own window; fixed-duration mode
   * derives numbers from the wall clock and stays one segment behind the edge.
   * @param {object} template  flattened SegmentTemplate attributes
   * @param {object} ctx
   * @returns {{number:number, time:number, durationSec:number, url:string}[]}
   */
  _computeSegments(template, ctx) {
    const timescale = Number(template.timescale || 1) || 1;
    const startNumber = Number(template.startNumber || 1);
    const pto = Number(template.presentationTimeOffset || 0);
    const mediaTemplate = String(template.media || '');
    const segments = [];

    const push = (number, time, durationRaw) => {
      if (durationRaw <= 0) return;
      segments.push({
        number,
        time,
        durationSec: durationRaw / timescale,
        url: absolutize(fillSegmentTemplate(mediaTemplate, {
          representationId: ctx.representationId, bandwidth: ctx.bandwidth, number, time
        }), ctx.baseUrl)
      });
    };

    if (template.timeline) {
      const entries = [];
      let cursor = null;
      let totalIterations = 0;
      let totalValid = 0;

      // Only the final window is materialised: a huge repeat count must not
      // allocate thousands of segment objects that are discarded at once.
      for (const s of childrenNamed(template.timeline, 'S')) {
        const t = s.attrs.t !== undefined ? Number(s.attrs.t) : (cursor === null ? pto : cursor);
        const d = Number(s.attrs.d || 0);
        const r = s.attrs.r !== undefined ? Number(s.attrs.r) : 0;
        const count = Number.isFinite(r) && r >= 0 ? Math.floor(r) + 1 : 0;
        entries.push({ t, d, count, firstNumber: startNumber + totalIterations });
        totalIterations += count;
        if (d > 0) totalValid += count;
        cursor = t + d * (r + 1);
      }

      const firstKept = Math.max(0, totalValid - MAX_WINDOW_SEGMENTS);
      let validIndex = 0;
      for (const entry of entries) {
        if (entry.d <= 0) continue;
        for (let i = Math.max(0, firstKept - validIndex); i < entry.count; i++) {
          push(entry.firstNumber + i, entry.t + entry.d * i, entry.d);
        }
        validIndex += entry.count;
      }
      return segments;
    }

    const fixedDuration = Number(template.duration || 0);
    if (fixedDuration <= 0) return segments;

    const segDurSec = fixedDuration / timescale;
    if (ctx.dynamic && ctx.availabilityStartTime > 0) {
      const elapsedSec = (Date.now() - ctx.availabilityStartTime) / 1000 - ctx.periodStartSec;
      const totalPublished = Math.floor(elapsedSec / segDurSec);
      if (totalPublished <= LIVE_EDGE_TRIM_SEGMENTS) return segments;
      const newest = startNumber + totalPublished - LIVE_EDGE_TRIM_SEGMENTS;
      const windowSize = Math.min(
        MAX_WINDOW_SEGMENTS,
        ctx.timeShiftBufferSec > 0 ? Math.floor(ctx.timeShiftBufferSec / segDurSec) || MAX_WINDOW_SEGMENTS : MAX_WINDOW_SEGMENTS
      );
      for (let n = Math.max(startNumber, newest - windowSize + 1); n <= newest; n++) {
        push(n, pto + (n - startNumber) * fixedDuration, fixedDuration);
      }
    } else {
      for (let n = startNumber; n < startNumber + MAX_WINDOW_SEGMENTS; n++) {
        push(n, pto + (n - startNumber) * fixedDuration, fixedDuration);
      }
    }
    return segments;
  }

  /**
   * Linear number-to-time mapping of a window, used to synthesise URLs for
   * numbers that already slid out of it. `ticks` is the MEAN duration: audio
   * alternates 1.984 s / 2.016 s at 44.1 kHz, so the first segment's duration
   * would drift the map by ~1400 ticks per segment.
   * @param {object[]} segments
   * @param {number} timescale
   * @returns {{n0:number, t0:number, ticks:number, uniform:boolean}|null}
   */
  _shapeOf(segments, timescale) {
    if (!segments.length) return null;
    const first = segments[0];
    const ticksEach = segments.map((s) => s.durationSec * timescale);
    const mean = ticksEach.reduce((a, b) => a + b, 0) / ticksEach.length;
    return {
      n0: first.number,
      t0: first.time,
      ticks: Math.round(mean),
      uniform: ticksEach.every((t) => Math.abs(t - mean) <= 1) && segments.every((s, i) => s.number === first.number + i)
    };
  }

  /**
   * @param {string} reqBase
   * @param {'video'|'audio'} name
   * @param {string} token
   * @param {string} [repId]
   * @returns {string} absolute child playlist URL
   */
  _childPlaylistUrl(reqBase, name, token, repId) {
    return `${reqBase}/api/dash/${name}.m3u8?d=${token}${repId ? `&r=${encodeURIComponent(repId)}` : ''}`;
  }

  /**
   * HLS master playlist: the best audio as the default rendition, every video
   * rendition as a variant so ABR can step down on a slow relay.
   * @param {{videoReps: object[], audioReps: object[]}} parsed
   * @param {string} reqBase  public base URL
   * @param {string} token    signed `d` token
   * @returns {string}
   */
  renderMaster(parsed, reqBase, token) {
    const audio = parsed.audioReps[0];
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
    if (audio) {
      const attrs = ['TYPE=AUDIO', `GROUP-ID="${AUDIO_GROUP_ID}"`, `NAME="${audio.lang || 'Audio'}"`, 'DEFAULT=YES', 'AUTOSELECT=YES'];
      if (audio.lang) attrs.push(`LANGUAGE="${audio.lang}"`);
      attrs.push(`URI="${this._childPlaylistUrl(reqBase, 'audio', token)}"`);
      lines.push(`#EXT-X-MEDIA:${attrs.join(',')}`);
    }
    for (const video of parsed.videoReps) {
      const attrs = [`BANDWIDTH=${video.bandwidth + (audio ? audio.bandwidth : 0)}`];
      const codecs = [video.codecs, audio ? audio.codecs : ''].filter(Boolean).join(',');
      if (codecs) attrs.push(`CODECS="${codecs}"`);
      if (video.width && video.height) attrs.push(`RESOLUTION=${video.width}x${video.height}`);
      if (audio) attrs.push(`AUDIO="${AUDIO_GROUP_ID}"`);
      lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`);
      lines.push(this._childPlaylistUrl(reqBase, 'video', token, video.id));
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * HLS media playlist whose init and segments are served decrypted by this server.
   * @param {object} rep
   * @param {string} reqBase
   * @param {string} token
   * @returns {string}
   */
  renderMediaPlaylist(rep, reqBase, token) {
    const maxDuration = rep.segments.reduce((max, s) => Math.max(max, s.durationSec), 0);
    const repParam = rep.id ? `&r=${encodeURIComponent(rep.id)}` : '';
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(maxDuration))}`,
      `#EXT-X-MEDIA-SEQUENCE:${rep.segments[0].number}`,
      '#EXT-X-INDEPENDENT-SEGMENTS'
    ];
    if (rep.initUrl) lines.push(`#EXT-X-MAP:URI="${reqBase}/api/dash/init.mp4?d=${token}&k=${rep.kind}${repParam}"`);
    for (const seg of rep.segments) {
      lines.push(`#EXTINF:${seg.durationSec.toFixed(3)},`);
      lines.push(`${reqBase}/api/dash/segment.mp4?d=${token}&k=${rep.kind}${repParam}&n=${seg.number}`);
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * Parsed MPD plus the stream's host allowlist, cached longer than the raw MPD
   * so a segment request every 2 s is not an MPD fetch every 3 s.
   * @param {{mpdUrl: string, headers: object}} payload
   * @returns {Promise<{ts:number, parsed:object, policy:object}>}
   */
  async _streamContext(payload) {
    const cached = this._ctxCache.get(payload.mpdUrl);
    if (cached && Date.now() - cached.ts < CTX_CACHE_TTL_MS) return cached;

    const parsed = await this._fetchParsedMpd(payload.mpdUrl, payload.headers);
    const urls = [payload.mpdUrl];
    for (const rep of [...parsed.videoReps, ...parsed.audioReps]) {
      if (rep.initUrl) urls.push(rep.initUrl);
      if (rep.mediaTemplate) urls.push(rep.mediaTemplate.replace(/\$(Number|Time)[^$]*\$/g, '0'));
    }
    const entry = { ts: Date.now(), parsed, policy: buildPolicy(payload.mpdUrl, urls) };
    this._ctxCache.set(payload.mpdUrl, entry);
    if (this._ctxCache.size > CTX_CACHE_MAX_ENTRIES) this._ctxCache.delete(this._ctxCache.keys().next().value);
    return entry;
  }

  /**
   * Builds a segment URL from the representation's template alone.
   * @param {object} rep
   * @param {object} policy
   * @param {number} n
   * @returns {{url:string, durationSec:number, rep:object, policy:object}}
   */
  _synthesiseSegment(rep, policy, n) {
    const shape = rep.segmentShape;
    const time = shape ? Math.max(0, Math.round(shape.t0 + (n - shape.n0) * (shape.ticks || 0))) : 0;
    const url = absolutize(fillSegmentTemplate(rep.mediaTemplate, {
      representationId: rep.id, bandwidth: rep.bandwidth, number: n, time
    }), rep.baseUrl);
    return { url, durationSec: shape ? shape.ticks / rep.timescale : 2, rep, policy };
  }

  /**
   * Drops both MPD caches for the stream and re-reads it.
   * @param {{mpdUrl: string, headers: object}} payload
   * @returns {Promise<object>}
   */
  _refreshStreamContext(payload) {
    this._mpdCache.delete(payload.mpdUrl);
    this._ctxCache.delete(payload.mpdUrl);
    return this._streamContext(payload);
  }

  /**
   * @param {object} parsed
   * @param {'video'|'audio'} kind
   * @returns {object[]}
   */
  _repsFor(parsed, kind) {
    return kind === 'audio' ? parsed.audioReps : parsed.videoReps;
  }

  /**
   * @param {object} payload
   * @param {'video'|'audio'} kind
   * @param {string} [repId]  first representation when omitted
   * @param {{refresh?: boolean}} [options]
   * @returns {Promise<{rep: object, policy: object}>}
   * @throws {Error} when the representation does not exist
   */
  async resolveRepresentation(payload, kind, repId, options = {}) {
    const ctx = options.refresh ? await this._refreshStreamContext(payload) : await this._streamContext(payload);
    const reps = this._repsFor(ctx.parsed, kind);
    const rep = repId ? reps.find((r) => String(r.id) === String(repId)) : reps[0];
    if (!rep) throw new Error(`MPD exposes no ${kind} representation ${repId || ''}`.trim());
    return { rep, policy: ctx.policy };
  }

  /**
   * Maps a DASH `$Number$` from a playlist back to an upstream URL. A number
   * that slid out of the window is synthesised from the template, so a paused
   * player is not wedged. `$Number$` templates need neither window nor fresh
   * MPD; `$Time$` templates re-read the MPD once and fall back to the mean tick.
   * @param {object} payload
   * @param {'video'|'audio'} kind
   * @param {string} [repId]
   * @param {number} number
   * @returns {Promise<{url:string, durationSec:number, rep:object, policy:object}>}
   */
  async resolveSegment(payload, kind, repId, number) {
    const n = Number(number);
    if (!Number.isFinite(n)) throw new Error(`invalid segment number ${number}`);

    let { rep, policy } = await this.resolveRepresentation(payload, kind, repId);
    const exact = rep.segments.find((s) => s.number === n);
    if (exact) return { url: exact.url, durationSec: exact.durationSec, rep, policy };

    if (!rep.mediaTemplate) throw new Error(`segment ${n} is outside the current ${kind} window`);
    if (!/\$Time(\$|%)/.test(rep.mediaTemplate)) return this._synthesiseSegment(rep, policy, n);

    ({ rep, policy } = await this.resolveRepresentation(payload, kind, repId, { refresh: true }));
    const refreshed = rep.segments.find((s) => s.number === n);
    if (refreshed) return { url: refreshed.url, durationSec: refreshed.durationSec, rep, policy };
    return this._synthesiseSegment(rep, policy, n);
  }

  /**
   * @param {object} payload
   * @param {string} token
   * @param {string} reqBase
   * @returns {Promise<string>} master playlist
   */
  async buildMaster(payload, token, reqBase) {
    return this.renderMaster(await this._fetchParsedMpd(payload.mpdUrl, payload.headers), reqBase, token);
  }

  /**
   * @param {object} payload
   * @param {'video'|'audio'} kind
   * @param {string} token
   * @param {string} reqBase
   * @param {string} [repId]
   * @returns {Promise<string>} media playlist
   * @throws {Error} when the representation does not exist
   */
  async buildMediaPlaylist(payload, kind, token, reqBase, repId) {
    const parsed = await this._fetchParsedMpd(payload.mpdUrl, payload.headers);
    const reps = this._repsFor(parsed, kind);
    const rep = repId ? reps.find((r) => String(r.id) === String(repId)) : reps[0];
    if (!rep) throw new Error(`MPD exposes no ${kind} representation ${repId || ''}`.trim());
    return this.renderMediaPlaylist(rep, reqBase, token);
  }
}

module.exports = DashToHlsService;
module.exports.fillSegmentTemplate = fillSegmentTemplate;
module.exports.parseIsoDuration = parseIsoDuration;
