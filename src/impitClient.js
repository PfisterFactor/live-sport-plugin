/**
 * impitClient.js — Safe impit singleton with undici fallback
 *
 * impit is a native Rust/NAPI addon. On some architectures (ARM64 VPS,
 * Alpine/musl Linux, certain Windows Server builds) the native binary may fail
 * to load. This module wraps every call so a missing or broken impit
 * transparently falls back to undici — callers never need to worry about it.
 *
 * Usage:
 *   const { safeFetch } = require('./impitClient');
 *   const { ok, status, text } = await safeFetch(url, { headers, method });
 */

'use strict';

const { request: undiciRequest, Agent } = require('undici');

// -- Singleton -----------------------------------------------------------------
// One long-lived instance: every new Impit spawns its own tokio runtime, and
// recycling them accumulates worker threads faster than it frees TLS caches.
// undefined  = not yet probed
// null       = probed and unavailable (native binary missing / bad arch)
// Impit obj  = ready to use
let _impitInstance;

function getImpit() {
  if (_impitInstance !== undefined) return _impitInstance;
  try {
    const { Impit } = require('impit');
    _impitInstance = new Impit({ browser: 'chrome142' });
    console.log('[impitClient] impit native client loaded successfully.');
  } catch (e) {
    _impitInstance = null;
    console.warn(`[impitClient] impit unavailable (${e.message}). All requests will use undici fallback - streams will still work.`);
  }
  return _impitInstance;
}

// -- Shared undici keep-alive agent -------------------------------------------
const _undiciAgent = new Agent({
  connect: { timeout: 20000, rejectUnauthorized: false },
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 30000,
});

// Enough for the mirror 301s observed in production, small enough that a rogue
// redirect loop costs about what a single timed-out request costs.
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Share of the deadline the impit path may spend across its retries. The rest
// is reserved for the undici fallback, so a hung impit cannot starve it.
const IMPIT_BUDGET_RATIO = 0.6;

const CERTIFICATE_ERROR_RE = /InvalidCertificate|UnknownIssuer|certificate has expired/;

/**
 * Normalizes a Headers instance, entries iterable, or plain object into a
 * lowercase-keyed plain object so callers see one shape from both paths.
 */
function normalizeHeaders(raw) {
  if (!raw) return {};
  const out = {};
  const entries = typeof raw.entries === 'function' ? raw.entries() : Object.entries(raw);
  for (const [key, value] of entries) {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** Collapses a multi-line native (Rust) error into one log-safe line. */
function squashError(err) {
  const msg = err && err.message ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Wraps a finished hop result in the response shape callers consume. */
function toResponse({ status, headers, textData }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => textData,
    json: async () => JSON.parse(textData),
  };
}

/** Absolute URL a redirect response points at, or null when it cannot be followed. */
function redirectTarget(status, headers, currentUrl) {
  if (!REDIRECT_STATUSES.has(status)) return null;
  const raw = headers.location;
  if (!raw) return null;
  try {
    const next = new URL(raw, currentUrl);
    return next.protocol === 'http:' || next.protocol === 'https:' ? next.toString() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Runs `send` for the request and every redirect it answers with, up to
 * MAX_REDIRECT_HOPS. 301/302/303 become a bodyless GET (HEAD stays HEAD);
 * 307/308 keep method and body. The deadline covers the whole chain, and
 * `validateUrl` — when given — vets the first URL and every hop before it is
 * requested, so a public host cannot bounce the call into an internal one.
 */
async function followHops(url, init, deadlineAt, label, send) {
  let { method, headers, body } = init;
  const { validateUrl } = init;
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    if (validateUrl) await validateUrl(currentUrl);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error(`${label} timeout (redirect chain)`);
    const res = await send({ url: currentUrl, method, headers, body, remainingMs });
    const next = hop < MAX_REDIRECT_HOPS ? redirectTarget(res.status, res.headers, currentUrl) : null;
    if (!next) return res;

    if (method !== 'HEAD' && res.status !== 307 && res.status !== 308) {
      method = 'GET';
      body = undefined;
      if (headers && headers.constructor === Object && 'content-length' in headers) {
        headers = Object.assign({}, headers);
        delete headers['content-length'];
      }
    }
    currentUrl = next;
  }
}

/** One request through the impit client, bounded by `remainingMs` for headers and body. */
async function impitSend(impit, hop, manualRedirect) {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const res = await impit.fetch(hop.url, {
          method: hop.method,
          headers: hop.headers,
          body: hop.body,
          ...(manualRedirect ? { redirect: 'manual' } : {}),
        });
        const textData = await res.text();
        return { status: res.status, headers: normalizeHeaders(res.headers), textData };
      })(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`impit timeout ${Math.round(hop.remainingMs)}ms`)), hop.remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One request through undici, bounded by `remainingMs` for headers and body. */
async function undiciSend(hop, signal) {
  const deadlineSignal = AbortSignal.timeout(hop.remainingMs);
  const res = await undiciRequest(hop.url, {
    method: hop.method,
    headers: hop.headers,
    body: hop.body,
    signal: signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal,
    headersTimeout: hop.remainingMs,
    bodyTimeout: hop.remainingMs,
    dispatcher: _undiciAgent,
  });
  return { status: res.statusCode, headers: normalizeHeaders(res.headers), textData: await res.body.text() };
}

// -- Core helper --------------------------------------------------------------

/**
 * safeFetch - fetches a URL using impit when available, falls back to undici.
 *
 * `timeoutMs` is the budget for the whole call: impit retries, backoff, redirect
 * hops and the undici fallback all draw from it. `attempts` bounds the impit
 * retry loop; callers that run their own retry policy should pass 1 so the two
 * layers do not multiply.
 *
 * Redirects are followed on both paths. impit answers 403 to some CDNs that
 * accept undici on the same token, so a 403 from impit is retried once on undici
 * and the impit 403 is returned only if undici cannot answer.
 *
 * `validateUrl(url)` is awaited for the initial URL and every redirect hop and
 * must throw to refuse it; the throw propagates untouched (no fallback).
 *
 * @param {string} url
 * @param {object} opts   - { method, headers, body, signal, timeoutMs, attempts, validateUrl }
 * @returns {{ ok, status, headers, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 15000, attempts = 3, validateUrl } = opts;
  const impit = getImpit();
  const maxAttempts = Math.max(1, attempts);
  const deadline = Date.now() + timeoutMs;
  const init = { method, headers, body, validateUrl };

  const viaUndici = async () => {
    if (deadline - Date.now() <= 0) throw new Error(`safeFetch timeout ${timeoutMs}ms`);
    return toResponse(await followHops(url, init, deadline, 'undici', (hop) => undiciSend(hop, signal)));
  };

  // -- Path A: impit ---------------------------------------------------------
  if (impit) {
    const impitDeadline = Date.now() + timeoutMs * IMPIT_BUDGET_RATIO;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (impitDeadline - Date.now() <= 0) break;
      if (signal && signal.aborted) throw Object.assign(new Error('aborted before impit attempt'), { name: 'AbortError' });
      try {
        const res = await followHops(url, init, impitDeadline, 'impit', (hop) => impitSend(impit, hop, !!validateUrl));
        if (res.status === 403) {
          console.warn(`[impitClient] impit got 403, trying undici once for: ${url.slice(0, 90)}`);
          try {
            return await viaUndici();
          } catch (undiciErr) {
            if (undiciErr && undiciErr.blocked) throw undiciErr;
            return toResponse(res);
          }
        }
        return toResponse(res);
      } catch (impitErr) {
        if (impitErr && impitErr.blocked) throw impitErr;
        lastErr = impitErr;
        if (CERTIFICATE_ERROR_RE.test(String(impitErr))) break;
        const backoff = Math.min(800 * attempt, impitDeadline - Date.now());
        if (attempt < maxAttempts && backoff > 0) await new Promise(r => setTimeout(r, backoff));
      }
    }
    console.warn(`[impitClient] impit fetch failed (${lastErr ? squashError(lastErr) : 'budget exhausted'}), falling back to undici for: ${url.slice(0, 90)}`);
  }

  // -- Path B: undici --------------------------------------------------------
  return viaUndici();
}

/**
 * isImpitAvailable - quick runtime check, useful for startup logs.
 */
function isImpitAvailable() {
  return getImpit() !== null;
}

module.exports = { safeFetch, isImpitAvailable, getImpit, MAX_REDIRECT_HOPS };
