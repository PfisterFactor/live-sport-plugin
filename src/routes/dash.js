/**
 * dash.js — ClearKey DASH to plain HLS endpoints.
 *
 *   GET /api/dash/index.m3u8?d=<signed>            master playlist
 *   GET /api/dash/video.m3u8?d=<signed>[&r=]       video media playlist
 *   GET /api/dash/audio.m3u8?d=<signed>            audio media playlist
 *   GET /api/dash/init.mp4?d=<signed>&k=&r=        uncloaked init segment
 *   GET /api/dash/segment.mp4?d=<signed>&k=&r=&n=  decrypted media segment
 *
 * `d` is HMAC-signed and expires (services/DashPayload.js). The client never
 * supplies a URL: segment URLs are synthesised from the MPD's own template by
 * `service.resolveSegment()` and fetched through DashUpstream's allowlist and
 * the outbound guard. Every segment is downloaded, decrypted and re-served by
 * this server, so each viewer costs the stream's full bitrate in egress.
 */

'use strict';

const crypto = require('crypto');
const { getRequestBaseUrl } = require('../config');
const { safeFetch } = require('../impitClient');
const DashToHlsService = require('../services/DashToHlsService');
const cenc = require('../services/cenc');
const { signPayload, verifyPayload, TOKEN_TTL_SEC } = require('../services/DashPayload');
const { fetchGuarded, toBuffer, UpstreamError } = require('../services/DashUpstream');

const SEGMENT_CACHE_MAX = Number(process.env.DASH_SEGMENT_CACHE_MAX) || 96;
const SEGMENT_CACHE_TTL_MS = 60 * 1000;
const INIT_CACHE_MAX = 200;
const INIT_CACHE_TTL_MS = 6 * 3600 * 1000;
const MAX_CONCURRENT = Number(process.env.DASH_MAX_CONCURRENT) || 24;
const SEGMENT_MAX_BYTES = 64 * 1024 * 1024;
const INIT_MAX_BYTES = 4 * 1024 * 1024;

/** Size-bounded map with a time-to-live that evicts the least recently used entry. */
class LruCache {
  /**
   * @param {{max: number, ttlMs: number}} opts
   */
  constructor({ max, ttlMs }) {
    this.max = Math.max(1, max);
    this.ttlMs = ttlMs;
    this._map = new Map();
  }

  /**
   * @param {string} key
   * @returns {*} the stored value, or null when missing or expired
   */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this._map.delete(key);
      return null;
    }
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this._map.delete(key);
    this._map.set(key, { at: Date.now(), value });
    while (this._map.size > this.max) this._map.delete(this._map.keys().next().value);
  }

  /** @returns {number} stored entries, expired ones included */
  get size() {
    return this._map.size;
  }
}

/**
 * Bounds concurrent fetch+decrypt jobs so a burst of joins cannot allocate gigabytes.
 * @param {number} max
 * @returns {function(function(): Promise<*>): Promise<*>} runs a job when a slot is free
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    const job = queue.shift();
    active += 1;
    job.fn().then(job.resolve, job.reject).finally(() => {
      active -= 1;
      pump();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

/**
 * One in-flight run per key; every concurrent caller shares its promise.
 * @param {Map<string, Promise>} map
 * @param {string} key
 * @param {function(): Promise<*>} fn
 * @returns {Promise<*>}
 */
function singleFlight(map, key, fn) {
  const existing = map.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(fn).finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
}

/**
 * @param {{mpdUrl: string, key: string}} payload
 * @returns {string} short identifier of one stream and its key, for cache keys
 */
function streamHash(payload) {
  return crypto.createHash('sha1').update(`${payload.mpdUrl}\n${payload.key}`).digest('hex').slice(0, 16);
}

/**
 * @param {object} req
 * @returns {'video'|'audio'|'master'} the playlist/track kind a request addresses
 */
function kindFromRequest(req) {
  const queryKind = typeof req.query.k === 'string' ? req.query.k.toLowerCase() : '';
  if (queryKind === 'video' || queryKind === 'audio') return queryKind;
  return req.path.includes('video') ? 'video' : req.path.includes('audio') ? 'audio' : 'master';
}

/**
 * @param {object} res
 */
function setStreamHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

/**
 * Builds the /api/dash handlers around one conversion service.
 * @param {DashToHlsService} service
 * @param {{fetcher?: Function, secret?: string|Buffer}} [options]
 *   test seams: `fetcher` replaces safeFetch, `secret` replaces the signing key
 * @returns {{mount: function(object): void, caches: object}}
 */
function createDashRoutes(service, options = {}) {
  const fetcher = options.fetcher || safeFetch;
  const initCache = new LruCache({ max: INIT_CACHE_MAX, ttlMs: INIT_CACHE_TTL_MS });
  const segmentCache = new LruCache({ max: SEGMENT_CACHE_MAX, ttlMs: SEGMENT_CACHE_TTL_MS });
  const tracksByRep = new Map();
  const inflight = new Map();
  const limit = createLimiter(MAX_CONCURRENT);

  const repKey = (payload, kind, rep) => `${streamHash(payload)}|${kind}|${rep.id}`;
  const upstreamHeaders = (payload) => service._sanitizeUpstreamHeaders(payload.headers);

  /**
   * Fetches an init segment once and remembers its track table.
   * @returns {Promise<{buf: Buffer, tracks: Map}>}
   */
  function loadInit(payload, kind, rep, policy) {
    const cacheKey = `${streamHash(payload)}|${rep.initUrl}`;
    const remember = (entry) => {
      tracksByRep.set(repKey(payload, kind, rep), entry.tracks);
      return entry;
    };
    const cached = initCache.get(cacheKey);
    if (cached) return Promise.resolve(remember(cached));

    return singleFlight(inflight, `init:${cacheKey}`, () => limit(async () => {
      const res = await fetchGuarded(rep.initUrl, {
        policy, fetcher, headers: upstreamHeaders(payload), timeoutMs: 10000, attempts: 2
      });
      if (!res || !res.ok) throw new UpstreamError('UPSTREAM_STATUS', `init segment HTTP ${res && res.status}`);
      const uncloaked = cenc.uncloakInit(await toBuffer(res, INIT_MAX_BYTES), { expectedKid: payload.kid });
      const entry = { buf: uncloaked.buf, tracks: uncloaked.tracks };
      initCache.set(cacheKey, entry);
      return entry;
    })).then(remember);
  }

  /**
   * With a declared KID only that KID is accepted, so a mismatch fails loudly;
   * without one the single key we hold is the fallback.
   * @param {{key: string, kid: string}} payload
   * @returns {Object<string, Buffer>}
   */
  function keysFor(payload) {
    const key = Buffer.from(payload.key, 'hex');
    return payload.kid ? { [payload.kid]: key } : { __fallback: key };
  }

  /** @returns {Promise<Buffer>} one decrypted segment */
  async function fetchDecryptedSegment(payload, kind, rep, policy, url) {
    const tracks = tracksByRep.get(repKey(payload, kind, rep)) || (await loadInit(payload, kind, rep, policy)).tracks;
    const res = await fetchGuarded(url, {
      policy, fetcher, headers: upstreamHeaders(payload), timeoutMs: 20000, attempts: 2
    });
    if (!res || !res.ok) throw new UpstreamError('UPSTREAM_STATUS', `segment HTTP ${res && res.status}`);
    return cenc.decryptSegment(await toBuffer(res, SEGMENT_MAX_BYTES), { tracks, keysByKid: keysFor(payload) }).buf;
  }

  /**
   * Verifies `d` for every dash endpoint and stores the payload on the request.
   * @param {function(object, object): Promise<*>|*} handler
   * @returns {function(object, object): Promise<*>|*}
   */
  const withToken = (handler) => (req, res) => {
    const result = verifyPayload(typeof req.query.d === 'string' ? req.query.d : '', { secret: options.secret });
    if (!result.ok) {
      return res.status(result.status).send(result.code === 'MISSING' ? 'Missing d parameter' : `Invalid d parameter (${result.code})`);
    }
    req.dashPayload = result.payload;
    return handler(req, res);
  };

  /**
   * 502 for anything that means the bytes are not what was promised; a segment
   * is never partially written, since half-decrypted bytes decode into a smear.
   */
  function respondError(res, err, req, what) {
    const code = err && err.code ? err.code : 'INTERNAL';
    console.warn(`[DashToHls] ${what} failed (${code}) mpd=${req.dashPayload.mpdUrl} rep=${req.query.r || ''} n=${req.query.n || ''}: ${err && err.message}`);
    if (res.headersSent) return res.end();
    const status = /^SSRF_/.test(code) || (err && err.blocked) ? 403 : 502;
    return res.status(status).send(`DASH ${what} failed (${code})`);
  }

  const playlist = async (req, res) => {
    const kind = kindFromRequest(req);
    try {
      // Re-signed with a TTL so a URL leaked from a player log stops working.
      const signed = signPayload(req.dashPayload, { secret: options.secret, ttlSec: TOKEN_TTL_SEC });
      const reqBase = getRequestBaseUrl(req);
      const body = kind === 'master'
        ? await service.buildMaster(req.dashPayload, signed, reqBase)
        : await service.buildMediaPlaylist(req.dashPayload, kind, signed, reqBase, req.query.r);
      setStreamHeaders(res);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(body);
    } catch (err) {
      return respondError(res, err, req, `${kind} playlist`);
    }
  };

  const initSegment = async (req, res) => {
    const kind = kindFromRequest(req) === 'audio' ? 'audio' : 'video';
    try {
      const { rep, policy } = await service.resolveRepresentation(req.dashPayload, kind, req.query.r);
      if (!rep.initUrl) return res.status(404).send('Representation has no initialization segment');
      const entry = await loadInit(req.dashPayload, kind, rep, policy);
      setStreamHeaders(res);
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(entry.buf.length));
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(entry.buf);
    } catch (err) {
      return respondError(res, err, req, 'init');
    }
  };

  const mediaSegment = async (req, res) => {
    const kind = kindFromRequest(req) === 'audio' ? 'audio' : 'video';
    const number = Number(req.query.n);
    if (!Number.isInteger(number)) return res.status(400).send('Invalid n parameter');
    try {
      const target = await service.resolveSegment(req.dashPayload, kind, req.query.r, number);
      const cacheKey = `${repKey(req.dashPayload, kind, target.rep)}|${number}`;
      let buf = segmentCache.get(cacheKey);
      if (!buf) {
        buf = await singleFlight(inflight, cacheKey, () => limit(() =>
          fetchDecryptedSegment(req.dashPayload, kind, target.rep, target.policy, target.url)));
        segmentCache.set(cacheKey, buf);
      }
      setStreamHeaders(res);
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'public, max-age=4');
      return res.end(buf);
    } catch (err) {
      return respondError(res, err, req, `segment ${number}`);
    }
  };

  return {
    /**
     * Registers the five endpoints on the in-house app.
     * @param {object} app
     */
    mount(app) {
      app.get(['/api/dash/index.m3u8', '/api/dash/video.m3u8', '/api/dash/audio.m3u8'], withToken(playlist));
      app.get('/api/dash/init.mp4', withToken(initSegment));
      app.get('/api/dash/segment.mp4', withToken(mediaSegment));
    },
    caches: { initCache, segmentCache, tracksByRep, inflight }
  };
}

/**
 * Mounts the endpoints with the production service.
 * @param {object} app
 */
function mount(app) {
  createDashRoutes(new DashToHlsService()).mount(app);
}

module.exports = { mount, createDashRoutes, LruCache, createLimiter, singleFlight };
