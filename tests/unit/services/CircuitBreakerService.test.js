const { describe, it, expect, beforeEach, afterEach, spyOn, setSystemTime } = require('bun:test');
const CircuitBreakerService = require('../../../src/services/CircuitBreakerService');

const T0 = new Date('2026-01-01T00:00:00Z');
const at = (ms) => setSystemTime(new Date(T0.getTime() + ms));
const RESET_MS = 5 * 60 * 1000;

let quiet;

beforeEach(() => {
  quiet = [spyOn(console, 'warn'), spyOn(console, 'info')].map((s) => s.mockImplementation(() => {}));
  at(0);
});
afterEach(() => {
  quiet.forEach((s) => s.mockRestore());
  setSystemTime();
});

function failingFn() {
  const fn = async () => { fn.calls++; throw new Error('upstream'); };
  fn.calls = 0;
  return fn;
}

describe('CircuitBreakerService', () => {
  it('returns the same breaker instance for a name and a distinct one per name', () => {
    const svc = new CircuitBreakerService();
    const a = svc.wrap('prov', async () => 1);
    const b = svc.wrap('prov', async () => 2);
    const c = svc.wrap('other', async () => 3);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('passes arguments through and returns the wrapped result when closed', async () => {
    const svc = new CircuitBreakerService();
    const breaker = svc.wrap('prov', async (a, b) => a + b);
    expect(await breaker.fire(2, 3)).toBe(5);
  });

  it('resolves null instead of rejecting when the wrapped call throws', async () => {
    const svc = new CircuitBreakerService();
    const breaker = svc.wrap('prov', async () => { throw new Error('boom'); });
    expect(await breaker.fire()).toBeNull();
    expect(breaker.state).toBe('closed');
  });

  it('stays closed below the volume threshold even at 100% failure', async () => {
    const fn = failingFn();
    const breaker = new CircuitBreakerService().wrap('prov', fn);
    await breaker.fire();
    await breaker.fire();
    expect(breaker.state).toBe('closed');
    expect(fn.calls).toBe(2);
  });

  it('trips open on the third failure inside the window and stops calling upstream', async () => {
    const fn = failingFn();
    const breaker = new CircuitBreakerService().wrap('prov', fn);
    await breaker.fire();
    await breaker.fire();
    await breaker.fire();
    expect(breaker.state).toBe('open');

    expect(await breaker.fire()).toBeNull();
    expect(fn.calls).toBe(3);
  });

  it('stays closed at volume when the failure rate is below 50%', async () => {
    let mode = 'fail';
    const fn = async () => { if (mode === 'fail') throw new Error('x'); return 'ok'; };
    const breaker = new CircuitBreakerService().wrap('prov', fn);
    await breaker.fire();
    mode = 'ok';
    await breaker.fire();
    await breaker.fire();
    await breaker.fire();
    expect(breaker.state).toBe('closed');
  });

  it('drops results older than the rolling window so slow-drip failures never trip', async () => {
    const fn = failingFn();
    const breaker = new CircuitBreakerService().wrap('prov', fn);
    await breaker.fire();
    at(6000);
    await breaker.fire();
    at(20000);
    await breaker.fire();
    expect(breaker.state).toBe('closed');
    expect(fn.calls).toBe(3);
  });

  it('short-circuits for the full reset window, then half-opens and probes upstream', async () => {
    const fn = failingFn();
    const breaker = new CircuitBreakerService().wrap('prov', fn);
    for (let i = 0; i < 3; i++) await breaker.fire();
    expect(fn.calls).toBe(3);

    at(RESET_MS - 1);
    await breaker.fire();
    expect(fn.calls).toBe(3);
    expect(breaker.state).toBe('open');

    at(RESET_MS);
    await breaker.fire();
    expect(fn.calls).toBe(4);
  });

  it('one success in half-open closes the circuit and clears the failure history', async () => {
    let mode = 'fail';
    const fn = async () => { if (mode === 'fail') throw new Error('x'); return 'ok'; };
    const breaker = new CircuitBreakerService().wrap('prov', fn);
    for (let i = 0; i < 3; i++) await breaker.fire();
    expect(breaker.state).toBe('open');

    at(RESET_MS);
    mode = 'ok';
    expect(await breaker.fire()).toBe('ok');
    expect(breaker.state).toBe('closed');

    mode = 'fail';
    await breaker.fire();
    await breaker.fire();
    expect(breaker.state).toBe('closed');
  });

  it('a single failure in half-open re-opens the circuit and restarts the reset window', async () => {
    const fn = failingFn();
    const breaker = new CircuitBreakerService().wrap('prov', fn);
    for (let i = 0; i < 3; i++) await breaker.fire();

    at(RESET_MS);
    expect(await breaker.fire()).toBeNull();
    expect(breaker.state).toBe('open');
    expect(fn.calls).toBe(4);

    at(RESET_MS + 1000);
    await breaker.fire();
    expect(fn.calls).toBe(4);

    at(RESET_MS * 2);
    await breaker.fire();
    expect(fn.calls).toBe(5);
  });
});
