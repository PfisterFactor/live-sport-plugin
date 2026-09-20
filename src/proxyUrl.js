/**
 * proxyUrl.js — builds /api/manifest URLs for providers.
 *
 * `renew` + `embed` make the stream self-healing: when the signed upstream
 * token dies, the proxy re-mints it from the embed page instead of handing the
 * player a dead link it can never replace. See services/StreamRenewal.js.
 */

const { BASE_URL } = require('./config');

/**
 * @param {object} opts
 * @param {string} opts.url      signed upstream manifest URL
 * @param {string} opts.referer  referer the upstream CDN expects
 * @param {string} [opts.origin] origin header; defaults to the referer's origin
 * @param {string} [opts.renew]  renewal source name registered in StreamRenewal
 * @param {string} [opts.embed]  embed page the renewal source re-extracts from
 */
function manifestProxyUrl({ url, referer, origin, renew, embed }) {
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
  return out;
}

module.exports = { manifestProxyUrl };
