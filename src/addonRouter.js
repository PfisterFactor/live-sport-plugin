/**
 * addonRouter.js — Stremio v1 addon protocol resource routes.
 *
 * Serves /:config?/(catalog|meta|stream)/:type/:id/:extra?.json by
 * dispatching to the catalog/meta/stream handlers. The manifest route lives
 * in app.js because it filters catalogs per config.
 */

const querystring = require('querystring');

const { handleCatalog, handleMeta } = require('./catalog');
const { handleStream } = require('./streams');

const HANDLERS = {
  catalog: (type, id, extra, config) => handleCatalog(type, id, extra, config),
  meta:    (type, id, _extra, config) => handleMeta(type, id, config),
  stream:  (type, id, _extra, config) => handleStream(type, id, config),
};

const CACHE_DIRECTIVES = [
  ['cacheMaxAge', 'max-age'],
  ['staleRevalidate', 'stale-while-revalidate'],
  ['staleError', 'stale-if-error'],
];

/**
 * Decodes a config URL segment. Accepts URL-encoded JSON or base64url JSON.
 * Returns null when the segment is not a JSON object.
 */
function decodeConfigSegment(configStr) {
  try {
    let parsed;
    if (configStr.startsWith('%7B') || configStr.startsWith('{')) {
      parsed = JSON.parse(decodeURIComponent(configStr));
    } else {
      let base64 = configStr.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

/** Builds a Cache-Control header from the handler response, or null. */
function cacheControl(resp) {
  const parts = [];
  for (const [prop, directive] of CACHE_DIRECTIVES) {
    if (Number.isInteger(resp[prop])) parts.push(`${directive}=${resp[prop]}`);
  }
  return parts.length ? `${parts.join(', ')}, public` : null;
}

/** Mounts the addon resource routes on an Express app. */
function mount(app) {
  app.get('/:config?/:resource(catalog|meta|stream)/:type/:id/:extra?.json', async (req, res) => {
    const { resource, type, id } = req.params;
    const config = req.params.config ? decodeConfigSegment(req.params.config) || {} : {};
    // Parse extra from the raw URL: req.params.extra is already decoded, which
    // would corrupt values containing an encoded '&'.
    const extra = req.params.extra
      ? querystring.parse(req.url.split('/').pop().slice(0, -5))
      : {};

    let resp;
    try {
      resp = await HANDLERS[resource](type, id, extra, config);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ err: 'handler error' }));
    }

    const cc = cacheControl(resp);
    if (cc) res.setHeader('Cache-Control', cc);
    if (resp.redirect) return res.redirect(307, resp.redirect);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(resp));
  });
}

module.exports = { mount, decodeConfigSegment };
