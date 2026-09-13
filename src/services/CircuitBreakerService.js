const TIMEOUT_MS = 20000;
const RESET_TIMEOUT_MS = 5 * 60 * 1000;
const ROLLING_WINDOW_MS = 10000;
const ERROR_THRESHOLD_PCT = 50;
const VOLUME_THRESHOLD = 3;

/**
 * Closed/open/half-open circuit breaker around an async function.
 * `fire()` resolves `null` instead of rejecting when the call fails or the circuit is open,
 * so callers can treat a tripped upstream like an empty response.
 */
class CircuitBreaker {
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
    this.state = 'closed';
    this.openedAt = 0;
    this.results = [];
  }

  async fire(...args) {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < RESET_TIMEOUT_MS) {
        return this._fallback(new Error('Breaker is open'));
      }
      this.state = 'halfOpen';
      console.info(`[CircuitBreaker] ${this.name} HALF-OPEN. Testing recovery.`);
    }

    try {
      const result = await this._withTimeout(this.fn(...args));
      this._record(true);
      if (this.state === 'halfOpen') {
        this.state = 'closed';
        this.results = [];
        console.info(`[CircuitBreaker] ${this.name} CLOSED. Fully recovered.`);
      }
      return result;
    } catch (err) {
      this._record(false);
      if (this.state === 'halfOpen' || this._shouldTrip()) this._open();
      return this._fallback(err);
    }
  }

  _withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  _record(ok) {
    const now = Date.now();
    this.results.push({ t: now, ok });
    const cutoff = now - ROLLING_WINDOW_MS;
    while (this.results.length && this.results[0].t < cutoff) this.results.shift();
  }

  _shouldTrip() {
    const total = this.results.length;
    if (total < VOLUME_THRESHOLD) return false;
    const failures = this.results.reduce((n, r) => n + (r.ok ? 0 : 1), 0);
    return (failures / total) * 100 >= ERROR_THRESHOLD_PCT;
  }

  _open() {
    this.state = 'open';
    this.openedAt = Date.now();
    console.warn(`[CircuitBreaker] ${this.name} TRIPPED OPEN.`);
  }

  _fallback(err) {
    console.warn(`[CircuitBreaker] ${this.name} Fallback triggered. Reason: ${err ? err.message : 'Unknown'}`);
    return null;
  }
}

class CircuitBreakerService {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Wraps an async function in a named circuit breaker. Repeated calls with the
   * same name return the same breaker instance.
   */
  wrap(name, asyncFunction) {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, asyncFunction);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }
}

module.exports = CircuitBreakerService;
