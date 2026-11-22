/**
 * proxyUrl.js — builds /api/manifest and /api/dash URLs for providers.
 *
 * `renew` + `embed` make the stream self-healing: when the signed upstream
 * token dies, the proxy re-mints it from the embed page instead of handing the
 * player a dead link it can never replace. See services/StreamRenewal.js.
 */

const { signPayload, normalizePayload, TOKEN_TTL_SEC } = require('./services/DashPayload');
const { BASE_URL } = require('./config');

/**
 * @param {object} opts
 * @param {string} opts.url      signed upstream manifest URL
 * @param {string} opts.referer  referer the upstream CDN expects
 * @param {string} [opts.origin] origin header; defaults to the referer's origin
 * @param {string} [opts.renew]  renewal source name registered in StreamRenewal
 * @param {string} [opts.embed]  embed page the renewal source re-extracts from
 * @param {boolean} [opts.proxySegments] relay every segment through /api/segment, for image-wrapped segments or CDNs that refuse clients without the Referer
 */
function manifestProxyUrl({ url, referer, origin, renew, embed, proxySegments }) {
  let resolvedOrigin = origin;
  if (!resolvedOrigin) {
    try { resolvedOrigin = new URL(referer).origin; } catch (_) { resolvedOrigin = referer; }
  }
  let out = `${BASE_URL}/api/manifest?url=${encodeURIComponent(url)}`
    + `&referer=${encodeURIComponent(referer)}`
    + `&origin=${encodeURIComponent(resolvedOrigin)}`;
  if (renew && embed) {
    out += `&renew=${encodeURIComponent(renew)}&embed=${encodeURIComponent(embed)}`;
  }
  if (proxySegments) out += '&seg=1';
  return out;
}

/**
 * Builds the /api/dash/index.m3u8 URL that plays a ClearKey DASH stream as plain
 * HLS. Every segment is relayed and decrypted by this server (see routes/dash.js).
 * @param {object} opts
 * @param {string} opts.mpdUrl   the .mpd URL
 * @param {string} opts.key      16-byte content key, 32 hex chars
 * @param {string} [opts.kid]    key ID, 32 hex chars, dashes allowed
 * @param {object} [opts.headers] upstream request headers (User-Agent, Referer, Origin)
 * @returns {string|null} the URL, or null when the URL or key is unusable
 */
function dashHlsUrl({ mpdUrl, key, kid, headers }) {
  const payload = { mpdUrl, key, kid, headers };
  if (!normalizePayload(payload)) return null;
  return `${BASE_URL}/api/dash/index.m3u8?d=${signPayload(payload, { ttlSec: TOKEN_TTL_SEC })}`;
}

module.exports = { manifestProxyUrl, dashHlsUrl };
