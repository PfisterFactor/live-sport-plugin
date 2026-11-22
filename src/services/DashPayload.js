/**
 * DashPayload.js — signs and verifies the opaque `d` parameter of /api/dash/*,
 * which describes a stream as {mpdUrl, key, kid, headers}.
 *
 *   d = base64url(json) "." base64url(HMAC-SHA256(secret, base64url(json)))
 *
 * The payload names an upstream URL the server will fetch; unsigned it would be
 * an open SSRF primitive. The signing secret is DASH_SIGN_SECRET (16+ chars).
 * Without it a random per-process key is used: tokens then die on restart.
 */

'use strict';

const crypto = require('crypto');

const MAX_TOKEN_LENGTH = 8192;
const TOKEN_TTL_SEC = Number(process.env.DASH_TOKEN_TTL) || 6 * 3600;
const MAX_URL_LENGTH = 2048;
const HEADER_ALLOWLIST = new Set(['user-agent', 'referer', 'origin', 'accept', 'accept-language']);
const HEX32_RE = /^[0-9a-fA-F]{32}$/;

let ephemeralSecret = null;

/**
 * Resolves the HMAC secret: explicit argument, DASH_SIGN_SECRET, or a random
 * per-process key.
 * @param {string|Buffer} [explicit]
 * @returns {Buffer}
 */
function getSecret(explicit) {
  if (explicit) return Buffer.isBuffer(explicit) ? explicit : Buffer.from(String(explicit), 'utf8');
  const fromEnv = process.env.DASH_SIGN_SECRET;
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, 'utf8');
  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(32);
    console.warn('[DashPayload] DASH_SIGN_SECRET is not set; signing with a per-process random key, so /api/dash links die on restart');
  }
  return ephemeralSecret;
}

/**
 * @param {string} b64
 * @param {Buffer} secret
 * @returns {string} base64url HMAC-SHA256
 */
function sign(b64, secret) {
  return crypto.createHmac('sha256', secret).update(b64).digest('base64url');
}

/**
 * Keeps only allowlisted upstream request headers without CR/LF injection.
 * @param {object} headers
 * @returns {Object<string, string>}
 */
function sanitizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !value) continue;
    const lower = name.toLowerCase();
    if (!HEADER_ALLOWLIST.has(lower)) continue;
    if (value.length > 512 || /[\r\n]/.test(value)) continue;
    out[lower === 'user-agent' ? 'User-Agent' : name] = value;
  }
  return out;
}

/**
 * Normalises a payload to its canonical shape, or null when it is unusable.
 * @param {object} input  {mpdUrl, key, kid?, headers?, e?}
 * @returns {{mpdUrl:string, key:string, kid:string, headers:object, e?:number}|null}
 */
function normalizePayload(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.mpdUrl !== 'string' || !/^https?:\/\//i.test(input.mpdUrl) || input.mpdUrl.length > MAX_URL_LENGTH) return null;
  if (typeof input.key !== 'string' || !HEX32_RE.test(input.key)) return null;

  const kid = typeof input.kid === 'string' ? input.kid.toLowerCase().replace(/-/g, '') : '';
  const payload = {
    mpdUrl: input.mpdUrl,
    key: input.key.toLowerCase(),
    kid: HEX32_RE.test(kid) ? kid : '',
    headers: sanitizeHeaders(input.headers)
  };
  if (Number.isFinite(input.e)) payload.e = Math.floor(input.e);
  return payload;
}

/**
 * @param {object} payload  {mpdUrl, key, kid, headers}
 * @param {{ttlSec?: number, expiresAt?: number, secret?: string|Buffer, now?: number}} [opts]
 * @returns {string} signed token
 * @throws {Error} when the payload is invalid
 */
function signPayload(payload, opts = {}) {
  const normalized = normalizePayload(payload);
  if (!normalized) throw new Error('DashPayload: refusing to sign an invalid payload');
  const nowSec = Math.floor((opts.now || Date.now()) / 1000);
  if (Number.isFinite(opts.ttlSec) && opts.ttlSec !== 0) normalized.e = nowSec + Math.floor(opts.ttlSec);
  else if (Number.isFinite(opts.expiresAt)) normalized.e = Math.floor(opts.expiresAt);

  const b64 = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  return `${b64}.${sign(b64, getSecret(opts.secret))}`;
}

/**
 * @param {string} token
 * @param {{secret?: string|Buffer, now?: number}} [opts]
 * @returns {{ok:true, payload:object}|{ok:false, code:string, status:number}}
 */
function verifyPayload(token, opts = {}) {
  if (typeof token !== 'string' || !token) return { ok: false, code: 'MISSING', status: 400 };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, code: 'TOKEN_TOO_LARGE', status: 403 };

  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, code: 'MALFORMED', status: 403 };
  const b64 = token.slice(0, dot);

  const provided = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(sign(b64, getSecret(opts.secret)), 'utf8');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, code: 'BAD_SIGNATURE', status: 403 };
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, code: 'MALFORMED_PAYLOAD', status: 403 };
  }

  const payload = normalizePayload(decoded);
  if (!payload) return { ok: false, code: 'INVALID_PAYLOAD', status: 403 };
  if (Number.isFinite(payload.e) && Math.floor((opts.now || Date.now()) / 1000) > payload.e) {
    return { ok: false, code: 'EXPIRED', status: 403 };
  }
  return { ok: true, payload };
}

module.exports = { signPayload, verifyPayload, normalizePayload, sanitizeHeaders, MAX_TOKEN_LENGTH, TOKEN_TTL_SEC };
