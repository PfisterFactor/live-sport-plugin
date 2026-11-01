/**
 * Child-process launcher for the vendored StreamCorner provider-data worker.
 *
 * streamcorner.st fetches its catalog through an obfuscated ES-module worker
 * (streamcorner/Boq5hifj.js and its imported chunks). The worker signs each
 * request, posts it to a Cloudflare Worker host, and decodes the reply. Its
 * chunks refuse to run unless they believe they are the site's own scripts
 * inside a dedicated worker, so this launcher recreates that environment:
 *
 *  - ES module imports are rewired to a tiny synchronous loader;
 *  - `import.meta` is replaced by a placeholder that Function.prototype.toString
 *    maps back to the original text (the chunks hash their own source);
 *  - every chunk gets a `sourceURL` on https://streamcorner.st/assets/ so stack
 *    frames carry the origin and file names the chunks allow-list;
 *  - the worker-scope globals and `location` the chunks probe are provided.
 *
 * It is executed out-of-process so a hostile update to the vendored chunks
 * cannot touch the addon process. Requires Bun (JavaScriptCore stack format).
 *
 * argv: [operation ('provider-list' | 'provider-detail'), providerId, JSON array of endpoint URLs]
 * stdout: SCDATA:<json>:SCEND; exit 1 when the worker reports an error.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASSET_BASE = 'https://streamcorner.st/assets/';
const CHUNK_DIR = path.join(__dirname, 'streamcorner');
const WORKER_ENTRY = 'Boq5hifj';
const NONCE_KEY = '_7ac9e30576c825e5209e1fb1';
const TIMEOUT_MS = 12000;

const nativeText = new WeakMap();
const nativeToString = Function.prototype.toString;
const patchedToString = new Proxy(nativeToString, {
  apply(target, thisArg, args) {
    if (thisArg === patchedToString) return 'function toString() { [native code] }';
    if (nativeText.has(thisArg)) return nativeText.get(thisArg);
    const text = Reflect.apply(target, thisArg, args);
    return typeof text === 'string' ? text.split('__IMETA__').join('import.meta') : text;
  },
});

/** Registers `fn` so integrity probes see it as an untouched native function. */
function maskAsNative(fn, name) {
  nativeText.set(fn, `function ${name}() { [native code] }`);
  return fn;
}

const modules = {};

/**
 * Evaluates a vendored ES module as a function body and returns its exports.
 * @param {string} name chunk file name without extension
 */
function loadChunk(name) {
  if (modules[name]) return modules[name];
  let source = fs.readFileSync(path.join(CHUNK_DIR, `${name}.js`), 'utf8');
  let prelude = '';
  source = source.replace(/import\{([^}]*)\}from"\.\/([^"]+)\.js";?/g, (_, specifiers, dep) => {
    const bindings = specifiers.split(',').map((spec) => {
      const [imported, local] = spec.split(' as ');
      return local ? `${imported.trim()}:${local.trim()}` : imported.trim();
    });
    prelude += `const {${bindings.join(',')}}=__load(${JSON.stringify(dep)});`;
    return '';
  });
  source = source.replace(/import"\.\/([^"]+)\.js";?/g, (_, dep) => {
    prelude += `__load(${JSON.stringify(dep)});`;
    return '';
  });
  let epilogue = '';
  source = source.replace(/export\{([^}]*)\};?/, (_, specifiers) => {
    const pairs = specifiers.split(',').map((spec) => {
      const [local, exported] = spec.split(' as ');
      return `${(exported || local).trim()}:${local.trim()}`;
    });
    epilogue = `return {${pairs.join(',')}};`;
    return '';
  });
  source = source.split('import.meta').join('__IMETA__');
  const url = `${ASSET_BASE}${name}.js`;
  const body = `${prelude}${source}\n${epilogue}\n//# sourceURL=${url}`;
  modules[name] = new Function('__load', '__IMETA__', body)(loadChunk, { url, href: url });
  return modules[name];
}

/** Provides the worker-scope globals and strips engine-specific stack hooks the chunks probe. */
function prepareWorkerEnvironment(nonce) {
  delete Error.prepareStackTrace;
  Function.prototype.toString = patchedToString;
  globalThis.self = globalThis;
  for (const scope of ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']) {
    const ctor = function () {};
    Object.defineProperty(ctor, Symbol.hasInstance, { value: (o) => o === globalThis });
    globalThis[scope] = ctor;
  }
  globalThis.location = new URL(`${ASSET_BASE}${WORKER_ENTRY}.js#${nonce}`);
}

let onReply = () => {};

/** Installs the worker's outbound channel; the worker captures it at load time. */
function installPostMessage() {
  globalThis.postMessage = maskAsNative(function postMessage(reply) { onReply(reply); }, 'postMessage');
}

/** Resolves with the worker's reply to a single request message. */
function request(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timed out')), TIMEOUT_MS);
    onReply = (reply) => {
      if (!reply || reply.requestId !== message.requestId) return;
      clearTimeout(timer);
      if (reply.error) reject(new Error(String(reply.error)));
      else resolve(reply.data);
    };
    globalThis.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

(async () => {
  const operation = process.argv[2] || 'provider-list';
  const providerId = process.argv[3] || 'alpha';
  let urls = [];
  try { urls = JSON.parse(process.argv[4] || '[]'); } catch (_) {}

  const nonce = crypto.randomBytes(16).toString('hex');
  prepareWorkerEnvironment(nonce);
  installPostMessage();
  loadChunk(WORKER_ENTRY);
  if (typeof globalThis.dispatchEvent !== 'function' || typeof MessageEvent !== 'function') {
    console.error('[streamcorner-worker] runtime has no EventTarget global; Bun is required');
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    const data = await request({
      requestId: 1,
      operation,
      requestUrls: urls,
      providerId,
      providerName: providerId,
      [NONCE_KEY]: nonce,
      [`${NONCE_KEY}r`]: crypto.randomBytes(16).toString('hex'),
    });
    process.stdout.write('SCDATA:' + JSON.stringify(data) + ':SCEND');
    process.exit(0);
  } catch (e) {
    console.error(`[streamcorner-worker] ${providerId} failed: ${e.message}`);
    process.exit(1);
  }
})();
