/**
 * app.js — Nuvio Live Sports Plugin HTTP application
 *
 * Builds (but never starts) the HTTP app that serves:
 *   - /manifest.json          → addon manifest, filtered per config segment
 *   - /catalog|meta|stream/*  → match lists, detail, stream URLs
 *   - /watch                  → HTML proxy page for embed streams
 *   - /api/matches, /api/manifest, /api/proxy-embed
 *   - /img, /img/placeholder  → self-hosted image pipeline
 *   - /configure, /health
 *
 * CORS headers are explicitly set so Nuvio can reach the manifest
 * from any origin without a networkError_manifestLoadError.
 */

const { createApp, serveStatic } = require('./httpApp');
const path = require('path');
const fs = require('fs');

const { renderManifest } = require('./manifest');
const addonRouter = require('./addonRouter');
const { getRequestBaseUrl, BASE_URL } = require('./config');
const container = require('./container');
const { isLocalDirectRequest } = require('./services/localRequest');
const guard = require('./services/OutboundUrlGuard');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WATCH_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'watch.html'), 'utf8');
const WATCH_EXTRACT_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'watch-extract.html'), 'utf8');
const BASE_HOST = new URL(BASE_URL).host;
const LOCAL_HOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?$/;

/** Substitutes {{NAME}} placeholders in a template with literal string values. */
function render(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

/** Escapes a user-supplied value for interpolation into HTML text/attributes. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Build HTTP App ───────────────────────────────────────────────────────────

const app = createApp();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
  if (req.method === 'OPTIONS') {
    const requested = req.headers['access-control-request-headers'];
    if (requested) res.setHeader('Access-Control-Allow-Headers', requested);
    res.setHeader('Content-Length', '0');
    return res.status(204).end();
  }
  next();
});

// Serve the web debugger UI and Configuration Page
app.use(serveStatic(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get(['/configure', '/:config/configure'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'));
});

// Internal/debug surface for local helper scripts: direct local callers only.
// A socket-peer check alone would admit the whole internet behind a same-host
// reverse proxy, so see services/localRequest.js.
app.get('/api/matches', (req, res) => {
  if (!isLocalDirectRequest(req)) {
    return res.status(403).json({ error: 'Forbidden', reason: 'loopback_only' });
  }
  const matches = container.resolve('cacheService').getMatches();
  res.json(matches);
});

// Commentary languages the channel detector can tag. English is always ranked
// first by the add-on, so it is not offered as a selectable priority.
app.get('/api/options', (req, res) => {
  const seen = new Set();
  for (const rule of require('./services/ChannelCountryService').getRules()) {
    const language = rule && typeof rule.language === 'string' ? rule.language.trim() : '';
    if (language && language.toLowerCase() !== 'english') seen.add(language);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ languages: [...seen].sort() });
});

// /img?url=... serves a cached upstream image, falling back to a generated
// placeholder on any failure so the client never sees a broken image.
const imageService = require('./services/ImageService');

app.get('/img/placeholder', (req, res) => {
  const svg = imageService.svgPlaceholder(req.query.text || 'Live Sports', req.query.color || '333333');
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.send(svg);
});

app.get('/img', async (req, res) => {
  const text = req.query.text || 'Live Sports';
  const color = req.query.color || '333333';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const entry = await imageService.getImage(req.query.url);
  if (entry) {
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.send(entry.buffer);
  }
  const svg = imageService.svgPlaceholder(text, color);
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(svg);
});

require('./routes/manifestProxy').mount(app);

// /api/proxy-embed — CORS-safe embed HTML fetcher. The browser cannot fetch
// embed hosts directly (CORS); SSRF is mitigated by a strict domain allowlist.
const ALLOWED_EMBED_DOMAINS = new Set([
  'embedindia.st',
  'embedindia.com',
  'embedsport.xyz',
  'embed.st',
  'embedme.top',
  'embedstream.me',
  'embedstream.top',
  'streamtape.com',
  'sportsurge.net',
  'vecloud.net',
  'viprow.me',
  'vipbox.lc',
]);

const PROXY_EMBED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

app.get('/api/proxy-embed', async (req, res) => {
  const rawUrl = req.query.url;
  const referer = req.query.referer || '';

  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  let parsed;
  try {
    parsed = new URL(decodeURIComponent(rawUrl));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Invalid URL protocol' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // SSRF protection: reject any domain not in the allowlist
  if (!ALLOWED_EMBED_DOMAINS.has(parsed.hostname)) {
    console.warn(`[proxy-embed] Blocked SSRF attempt for domain: ${parsed.hostname}`);
    return res.status(403).json({ error: `Domain ${parsed.hostname} is not in the allowed embed domain list.` });
  }

  const verdict = await guard.checkOutboundUrl(parsed.toString());
  if (!verdict.ok) return guard.rejectBlockedUrl(res, verdict, 'proxy-embed');

  try {
    const headers = {
      'User-Agent': PROXY_EMBED_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };
    if (referer) headers['Referer'] = referer;

    // Redirects are followed by hand so every hop passes the SSRF guard too.
    let target = verdict.url;
    let upstream;
    for (let hop = 0; ; hop++) {
      upstream = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(12000),
        redirect: 'manual'
      });
      const location = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get('location') : null;
      if (!location || hop >= 5) break;
      const next = await guard.checkOutboundUrl(new URL(location, target).toString());
      if (!next.ok) return guard.rejectBlockedUrl(res, next, 'proxy-embed');
      target = next.url;
    }

    const html = await upstream.text();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(html);
  } catch (err) {
    console.error(`[proxy-embed] Fetch failed for ${parsed.hostname}: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch embed page', detail: err.message });
  }
});

// ─── Universal Dynamic Base URL Response Rewriter ─────────────────────────────
// Intercepts /manifest.json, /catalog/*, /meta/*, and /stream/* responses to
// dynamically rewrite all internal proxy URLs (/img, /watch, /api/manifest)
// to match the client's incoming Host and Protocol.
app.use((req, res, next) => {
  const isAddonRoute = req.path === '/manifest.json' || 
                       req.path.endsWith('/manifest.json') ||
                       req.path.includes('/catalog/') || 
                       req.path.includes('/meta/') || 
                       req.path.includes('/stream/');
  
  if (!isAddonRoute) return next();

  const currentBaseUrl = getRequestBaseUrl(req);
  const originalWrite = res.write;
  const originalEnd = res.end;
  const chunks = [];

  res.write = function (chunk) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };

  res.end = function (chunk, encoding, callback) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

    if (chunks.length > 0) {
      const bodyBuffer = Buffer.concat(chunks);
      const bodyString = bodyBuffer.toString('utf8');

      try {
        const body = JSON.parse(bodyString);
        let modified = false;

        const rewriteUrl = (url) => {
          if (!url || typeof url !== 'string') return url;
          // Relative URLs
          if (url.startsWith('/img') || url.startsWith('/watch') || url.startsWith('/api/manifest') || url.startsWith('/logo')) {
            modified = true;
            return `${currentBaseUrl}${url}`;
          }
          // Absolute URLs with legacy/static base or localhost/LAN IP
          const match = url.match(/^https?:\/\/([^\/]+)(\/(?:img|watch|api\/manifest|logo)(?:[?\/].*|\.[A-Za-z0-9]+)?)$/);
          if (match && (match[1] === BASE_HOST || LOCAL_HOST_RE.test(match[1]))) {
            modified = true;
            return `${currentBaseUrl}${match[2]}`;
          }
          return url;
        };

        // 1. Streams payload (/stream/tv/*.json)
        if (body && Array.isArray(body.streams)) {
          body.streams.forEach(s => {
            if (s.url) s.url = rewriteUrl(s.url);
            if (s.externalUrl) s.externalUrl = rewriteUrl(s.externalUrl);
          });
        }

        // 2. Catalog payload (/catalog/tv/*.json)
        if (body && Array.isArray(body.metas)) {
          body.metas.forEach(meta => {
            if (meta.poster) meta.poster = rewriteUrl(meta.poster);
            if (meta.background) meta.background = rewriteUrl(meta.background);
            if (meta.logo) meta.logo = rewriteUrl(meta.logo);
          });
        }

        // 3. Meta detail payload (/meta/tv/*.json)
        if (body && body.meta) {
          if (body.meta.poster) body.meta.poster = rewriteUrl(body.meta.poster);
          if (body.meta.background) body.meta.background = rewriteUrl(body.meta.background);
          if (body.meta.logo) body.meta.logo = rewriteUrl(body.meta.logo);
        }

        // 4. Manifest payload (/manifest.json)
        if (body && (body.logo || body.background)) {
          if (body.logo) body.logo = rewriteUrl(body.logo);
          if (body.background) body.background = rewriteUrl(body.background);
        }

        if (modified) {
          const newBodyString = JSON.stringify(body);
          const newBuffer = Buffer.from(newBodyString, 'utf8');
          res.setHeader('Content-Length', newBuffer.length);
          return originalEnd.call(res, newBuffer, 'utf8', callback);
        }
      } catch (_) {
        // Not JSON or parse failure; fall through
      }
    }

    const finalBuffer = Buffer.concat(chunks);
    originalEnd.call(res, finalBuffer, encoding, callback);
  };

  next();
});

// A segment that is not a config object serves the unconfigured manifest.
app.get('/:config?/manifest.json', (req, res) => {
  const parsedConfig = (req.params.config && addonRouter.decodeConfigSegment(req.params.config)) || {};
  const newManifest = renderManifest(parsedConfig);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(newManifest);
});

addonRouter.mount(app);

app.get('/watch', (req, res) => {
  const mode     = req.query.mode;
  const title    = req.query.title || 'Live Sports';

  // ─── mode=extract — Client-side HLS extraction for IP-locked embed providers ─
  // Architecture: browser fetches /api/proxy-embed → runs extractor → plays via hls.js
  // This ensures all CDN requests originate from the user's own IP (IP consistency).
  if (mode === 'extract') {
    const embedUrl  = req.query.embed;
    const referer   = req.query.referer || '';

    if (!embedUrl) return res.status(400).send('Missing ?embed parameter');

    let safeEmbed, safeReferer;
    try {
      let rawEmbed = embedUrl;
      try { if (typeof rawEmbed === 'string' && rawEmbed.includes('%')) rawEmbed = decodeURIComponent(rawEmbed); } catch (_) {}
      const parsedEmbed = new URL(rawEmbed);
      if (!['http:', 'https:'].includes(parsedEmbed.protocol)) {
        return res.status(400).send('Invalid embed URL protocol');
      }
      safeEmbed = parsedEmbed.toString();
      let rawReferer = referer || safeEmbed;
      try { if (typeof rawReferer === 'string' && rawReferer.includes('%')) rawReferer = decodeURIComponent(rawReferer); } catch (_) {}
      safeReferer = new URL(rawReferer).toString();
    } catch {
      return res.status(400).send('Invalid embed URL');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(render(WATCH_EXTRACT_HTML, {
      TITLE: escapeHtml(title),
      EMBED_URL: safeEmbed,
      EMBED_URL_JSON: JSON.stringify(safeEmbed),
      REFERER_JSON: JSON.stringify(safeReferer),
    }));
  }

  // ─── Default mode — iframe embed proxy ────
  const embedUrl = req.query.url;
  if (!embedUrl) {
    return res.status(400).send('Missing ?url parameter');
  }

  // Validate — only allow http/https URLs
  let safeUrl;
  try {
    let rawUrl = embedUrl;
    try { if (typeof rawUrl === 'string' && rawUrl.includes('%')) rawUrl = decodeURIComponent(rawUrl); } catch (_) {}
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send('Invalid URL protocol');
    }
    safeUrl = parsed.toString();
  } catch {
    return res.status(400).send('Invalid URL');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(render(WATCH_HTML, { TITLE: escapeHtml(title), URL: safeUrl }));
});

// ─── Health Check ─────────────────────────────────────────────────────────────
// Render pings this to confirm the service is alive

app.get('/health', (_, res) => {
  let cache = null;
  try { cache = container.resolve('streamResolveCache').stats(); } catch (_) {}
  res.json({ status: 'ok', service: 'nuvio-live-sports', streamResolveCache: cache });
});

module.exports = app;
