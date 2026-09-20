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
// undefined  = not yet probed
// null       = probed and unavailable (native binary missing / bad arch)
// Impit obj  = ready to use
let _impitInstance;

function getImpit() {
  if (_impitInstance !== undefined) return _impitInstance;
  try {
    const { Impit } = require('impit');
    _impitInstance = new Impit();
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

// -- Core helper --------------------------------------------------------------

// Share of the deadline the impit path may spend across its retries. The rest
// is reserved for the undici fallback, so a hung impit cannot starve it.
const IMPIT_BUDGET_RATIO = 0.6;

/**
 * safeFetch - fetches a URL using impit when available, falls back to undici.
 *
 * `timeoutMs` is the budget for the whole call: impit retries, backoff, and the
 * undici fallback all draw from it. `attempts` bounds the impit retry loop.
 *
 * @param {string} url
 * @param {object} opts   - { method, headers, body, signal, timeoutMs, attempts }
 * @returns {{ ok, status, headers, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 15000, attempts = 3 } = opts;
  const impit = getImpit();
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  // -- Path A: impit ---------------------------------------------------------
  if (impit) {
    const impitDeadline = Date.now() + timeoutMs * IMPIT_BUDGET_RATIO;
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const budget = impitDeadline - Date.now();
      if (budget <= 0) break;
      let timer;
      try {
        const res = await Promise.race([
          impit.fetch(url, { method, headers, body }),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`impit timeout ${Math.round(budget)}ms`)), budget);
          }),
        ]);
        const textData = await res.text();
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          headers: normalizeHeaders(res.headers),
          text: async () => textData,
          json: async () => JSON.parse(textData),
        };
      } catch (impitErr) {
        lastErr = impitErr;
        const backoff = Math.min(800 * attempt, impitDeadline - Date.now());
        if (attempt < attempts && backoff > 0) await new Promise(r => setTimeout(r, backoff));
      } finally {
        clearTimeout(timer);
      }
    }
    console.warn(`[impitClient] impit fetch failed (${lastErr ? lastErr.message : 'budget exhausted'}), falling back to undici for: ${url}`);
  }

  // -- Path B: undici --------------------------------------------------------
  const budget = remaining();
  if (budget <= 0) throw new Error(`safeFetch timeout ${timeoutMs}ms`);
  const deadlineSignal = AbortSignal.timeout(budget);
  const res = await undiciRequest(url, {
    method,
    headers,
    body,
    signal: signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal,
    headersTimeout: budget,
    bodyTimeout: budget,
    dispatcher: _undiciAgent,
  });
  const textData = await res.body.text();
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers: normalizeHeaders(res.headers),
    text: async () => textData,
    json: async () => JSON.parse(textData),
  };
}

/**
 * isImpitAvailable - quick runtime check, useful for startup logs.
 */
function isImpitAvailable() {
  return getImpit() !== null;
}

module.exports = { safeFetch, isImpitAvailable, getImpit };
