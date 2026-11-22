/**
 * DashUpstream.js — the only place /api/dash/* fetches a URL from.
 *
 * Segment URLs are synthesised by the server from a signed payload, so a
 * client never names a host. Two gates remain on every request AND every
 * redirect hop (safeFetch's validateUrl):
 *
 *   1. the per-stream allowlist: the MPD host plus every host the parsed MPD
 *      itself points at, same protocol and port;
 *   2. the fork-wide OutboundUrlGuard: private/reserved addresses, resolved DNS,
 *      STREAM_PROXY_ALLOWED_HOSTS.
 */

'use strict';

const net = require('net');
const guard = require('./OutboundUrlGuard');

/** Upstream fetch refused or failed; `code` names the cause. */
class UpstreamError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'UpstreamError';
    this.code = code;
  }
}

/**
 * @param {string} hostname
 * @returns {string} lowercase host without trailing dot or IPv6 brackets
 */
function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * True for a reserved hostname or an IP literal in a blocked range.
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (net.isIP(host)) return Boolean(guard.classifyAddress(host));
  return guard.isReservedHostname(host);
}

/**
 * Allowlist for one stream: the MPD host plus the hosts of `extraUrls` that
 * share its protocol and port.
 * @param {string} mpdUrl
 * @param {string[]} [extraUrls]  init/media URLs from the parsed MPD
 * @returns {{protocol:string, port:string, hosts:Set<string>}}
 * @throws {UpstreamError} INVALID_MPD_URL
 */
function buildPolicy(mpdUrl, extraUrls = []) {
  let base;
  try {
    base = new URL(mpdUrl);
  } catch (_) {
    throw new UpstreamError('INVALID_MPD_URL', `not a URL: ${mpdUrl}`);
  }
  const policy = { protocol: base.protocol, port: base.port || '', hosts: new Set([normalizeHost(base.hostname)]) };
  for (const candidate of extraUrls) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== policy.protocol || (url.port || '') !== policy.port) continue;
      const host = normalizeHost(url.hostname);
      if (!isBlockedHost(host)) policy.hosts.add(host);
    } catch (_) { /* a malformed URL in the MPD is simply not allowlisted */ }
  }
  return policy;
}

/**
 * Synchronous URL check against `policy` (when given) and the reserved-host list.
 * @param {string} rawUrl
 * @param {{protocol:string, port:string, hosts:Set<string>}} [policy]
 * @returns {URL}
 * @throws {UpstreamError} SSRF_INVALID_URL | SSRF_PROTOCOL | SSRF_CREDENTIALS | SSRF_PRIVATE_HOST | SSRF_PORT | SSRF_HOST_NOT_ALLOWED
 */
function assertAllowed(rawUrl, policy) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    throw new UpstreamError('SSRF_INVALID_URL', `not a URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamError('SSRF_PROTOCOL', `protocol ${url.protocol} not allowed`);
  }
  if (url.username || url.password) throw new UpstreamError('SSRF_CREDENTIALS', 'credentials in URL are not allowed');

  const host = normalizeHost(url.hostname);
  if (isBlockedHost(host)) throw new UpstreamError('SSRF_PRIVATE_HOST', `host ${host} is private/reserved`);
  if (policy) {
    if (url.protocol !== policy.protocol) throw new UpstreamError('SSRF_PROTOCOL', `protocol ${url.protocol} not allowed`);
    if ((url.port || '') !== policy.port) throw new UpstreamError('SSRF_PORT', `port ${url.port || '(default)'} not allowed`);
    if (!policy.hosts.has(host)) throw new UpstreamError('SSRF_HOST_NOT_ALLOWED', `host ${host} is not part of this stream`);
  }
  return url;
}

/**
 * Fetches `url` with the allowlist and the outbound guard applied to the first
 * URL and every redirect hop.
 * @param {string} url
 * @param {{policy?: object, fetcher: Function, headers?: object, timeoutMs?: number, attempts?: number, validateUrl?: Function}} opts
 *   `validateUrl` defaults to the fork's DNS-aware OutboundUrlGuard
 * @returns {Promise<object>} the fetcher's response
 * @throws {UpstreamError|Error} SSRF_* codes, or a guard error with `blocked: true`
 */
async function fetchGuarded(url, opts) {
  assertAllowed(url, opts.policy);
  const vet = opts.validateUrl || ((hop) => guard.assertOutboundUrl(hop));
  return opts.fetcher(url, {
    headers: opts.headers || {},
    timeoutMs: opts.timeoutMs || 15000,
    attempts: opts.attempts || 2,
    validateUrl: async (hop) => {
      assertAllowed(hop, opts.policy);
      await vet(hop);
    }
  });
}

/**
 * Reads a response body into a Buffer, refusing bodies over `maxBytes`.
 * @param {object} res  fetcher response with arrayBuffer()
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 * @throws {UpstreamError} BODY_TOO_LARGE
 */
async function toBuffer(res, maxBytes = Infinity) {
  const ab = await res.arrayBuffer();
  const buf = Buffer.isBuffer(ab) ? ab : Buffer.from(ab);
  if (buf.length > maxBytes) throw new UpstreamError('BODY_TOO_LARGE', `upstream body exceeded ${maxBytes} bytes`);
  return buf;
}

module.exports = { UpstreamError, buildPolicy, assertAllowed, fetchGuarded, toBuffer, isBlockedHost, normalizeHost };
