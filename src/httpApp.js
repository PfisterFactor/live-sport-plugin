/**
 * httpApp.js — minimal Express-shaped HTTP app on node:http.
 *
 * Supports exactly what this codebase uses: app.use/get/listen, Express 4
 * route patterns (`:name`, `:name?`, `:name(re)`), req.query/params/path/
 * protocol/get, res.status/send/json/sendFile/redirect, and static files.
 * The app is a plain (req, res) listener, so http.createServer(app) works.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.txt':  'text/plain; charset=utf-8',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles an Express 4 style path into a regex. Segment params are
 * `/:name`, optional `/:name?`, or constrained `/:name(a|b)`; everything else
 * is literal. Matching is case-insensitive and tolerates a trailing slash.
 */
function compilePath(pattern) {
  const keys = [];
  const tokenRe = /\/:(\w+)(?:\(([^)]+)\))?(\?)?/g;
  let source = '';
  let last = 0;
  let m;
  while ((m = tokenRe.exec(pattern))) {
    source += escapeRegex(pattern.slice(last, m.index));
    const [, name, constraint, optional] = m;
    keys.push(name);
    const segment = `\\/(${constraint ? `(?:${constraint})` : '[^\\/]+?'})`;
    source += optional ? `(?:${segment})?` : segment;
    last = m.index + m[0].length;
  }
  source += escapeRegex(pattern.slice(last));
  return { re: new RegExp(`^${source}\\/?$`, 'i'), keys };
}

function matchRoute(route, pathname) {
  const m = route.re.exec(pathname);
  if (!m) return null;
  const params = {};
  for (let i = 0; i < route.keys.length; i++) {
    const raw = m[i + 1];
    if (raw === undefined) continue;
    params[route.keys[i]] = decodeURIComponent(raw);
  }
  return params;
}

function decorateRequest(req) {
  const url = new URL(req.url, 'http://localhost');
  req.path = url.pathname;
  req.query = Object.fromEntries(url.searchParams);
  req.params = {};
  req.get = (name) => req.headers[name.toLowerCase()];
  const forwarded = req.headers['x-forwarded-proto'];
  req.protocol = forwarded
    ? forwarded.split(',')[0].trim()
    : (req.socket.encrypted ? 'https' : 'http');
}

function decorateResponse(res) {
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };

  res.send = function (body) {
    if (body === undefined || body === null) return this.end();
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return this.json(body);
    let type = this.getHeader('Content-Type');
    if (!type) {
      type = Buffer.isBuffer(body) ? 'application/octet-stream' : 'text/html; charset=utf-8';
    } else if (typeof type === 'string' && !/charset/i.test(type) && /^(text\/|application\/json)/i.test(type)) {
      type = `${type}; charset=utf-8`;
    }
    this.setHeader('Content-Type', type);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    this.setHeader('Content-Length', buf.length);
    return this.end(buf);
  };

  res.json = function (obj) {
    if (!this.getHeader('Content-Type')) this.setHeader('Content-Type', 'application/json; charset=utf-8');
    return this.send(JSON.stringify(obj));
  };

  res.sendFile = function (file) {
    let data;
    try {
      data = fs.readFileSync(file);
    } catch (e) {
      this.statusCode = 404;
      return this.end('Not Found');
    }
    this.setHeader('Content-Type', mimeFor(file));
    return this.send(data);
  };

  res.redirect = function (code, location) {
    if (typeof code !== 'number') { location = code; code = 302; }
    this.statusCode = code;
    this.setHeader('Location', location);
    return this.end();
  };
}

/**
 * Static file middleware rooted at `root`; falls through when nothing matches.
 * normalize() collapses any `..` against the root, so the path cannot escape.
 *
 * Responses are revalidated rather than cached blind: the configure page and
 * artwork change on deploy, and a 304 costs one round trip instead of the body.
 */
function serveStatic(root) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try {
      pathname = decodeURIComponent(req.path);
    } catch (e) {
      return next();
    }
    const file = root + path.normalize(`/${pathname}`);
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return next();
      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      const lastModified = stat.mtime.toUTCString();
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', lastModified);

      const noneMatch = req.headers['if-none-match'];
      const modifiedSince = req.headers['if-modified-since'];
      const fresh = noneMatch
        ? noneMatch.split(',').some((t) => t.trim() === etag)
        : modifiedSince && Date.parse(modifiedSince) >= Math.floor(stat.mtimeMs / 1000) * 1000;
      if (fresh) {
        res.statusCode = 304;
        return res.end();
      }

      res.setHeader('Content-Type', mimeFor(file));
      res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => next()).pipe(res);
    });
  };
}

function createApp() {
  const layers = [];

  const app = (req, res) => {
    decorateRequest(req);
    decorateResponse(res);
    let i = 0;
    const next = () => {
      const layer = layers[i++];
      if (!layer) {
        res.statusCode = 404;
        return res.end(`Cannot ${req.method} ${req.path}`);
      }
      let params = null;
      if (layer.route) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        try {
          params = matchRoute(layer.route, req.path);
        } catch (e) {
          res.statusCode = 400;
          return res.end('Bad Request');
        }
        if (!params) return next();
        req.params = params;
      }
      try {
        const out = layer.handler(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(fail);
      } catch (e) {
        fail(e);
      }
    };
    const fail = (err) => {
      console.error(err);
      if (res.headersSent) return res.end();
      res.statusCode = 500;
      res.end('Internal Server Error');
    };
    next();
  };

  app.use = (handler) => {
    layers.push({ handler });
    return app;
  };

  app.get = (patterns, handler) => {
    for (const p of [].concat(patterns)) layers.push({ route: compilePath(p), handler });
    return app;
  };

  app.listen = (...args) => http.createServer(app).listen(...args);

  return app;
}

module.exports = { createApp, serveStatic, compilePath };
