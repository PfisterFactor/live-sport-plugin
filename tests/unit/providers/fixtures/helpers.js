/**
 * Minimal cradle stubs for provider unit tests.
 */
function makeCradle(extra = {}) {
  return {
    circuitBreaker: {
      wrap: (name, fn) => ({ fire: (...args) => fn(...args) }),
    },
    ...extra,
  };
}

/**
 * Build a fake proxyFetch response matching the impitClient shape.
 */
function res({ status = 200, body = '', json }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (json !== undefined ? json : JSON.parse(typeof body === 'string' ? body : JSON.stringify(body))),
  };
}

module.exports = { makeCradle, res };
