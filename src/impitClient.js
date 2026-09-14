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
/**
 * safeFetch - fetches a URL using impit when available, falls back to undici.
 *
 * @param {string} url
 * @param {object} opts   - { method, headers, body, signal, timeoutMs }
 * @returns {{ ok, status, headers, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 15000 } = opts;
  const impit = getImpit();

  // -- Path A: impit ---------------------------------------------------------
    // -- Path A: impit ---------------------------------------------------------
  if (impit) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await Promise.race([
          impit.fetch(url, { method, headers, body }),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`impit timeout ${timeoutMs}ms`)), timeoutMs)
          ),
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
        if (attempt < 3) {
           await new Promise(r => setTimeout(r, 800 * attempt));
        }
      }
    }
    console.warn(`[impitClient] impit fetch failed after 3 retries (${lastErr.message}), falling back to undici for: ${url}`);
  }

  // -- Path B: undici --------------------------------------------------------
  const res = await undiciRequest(url, {
    method,
    headers,
    body,
    signal,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
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
