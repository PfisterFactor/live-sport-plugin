const { describe, it, expect, afterEach } = require('bun:test');
const { resolve, registrations, cradle } = require('../../../src/container');

let probeSeq = 0;
const probes = [];
const probeName = () => {
  const name = `__probe${probeSeq++}`;
  probes.push(name);
  return name;
};

describe('container', () => {
  afterEach(() => {
    while (probes.length) delete registrations[probes.pop()];
  });

  it('returns the same instance on repeated resolves (lazy singleton)', () => {
    const a = resolve('streamResolveCache');
    const b = resolve('streamResolveCache');
    expect(a).toBe(b);
  });

  it('resolves the same singleton through the cradle as through resolve()', () => {
    expect(cradle.streamResolveCache).toBe(resolve('streamResolveCache'));
  });

  it('throws a named error for an unknown registration', () => {
    expect(() => resolve('nopeService')).toThrow("Could not resolve 'nopeService'.");
    expect(() => cradle.nopeService).toThrow("Could not resolve 'nopeService'.");
  });

  it('does not build anything until first resolve', () => {
    const name = probeName();
    let built = 0;
    registrations[name] = () => { built += 1; return { id: 1 }; };
    expect(built).toBe(0);
    resolve(name);
    resolve(name);
    expect(built).toBe(1);
  });

  it('passes the cradle to factories so dependencies resolve on access', () => {
    const dep = probeName();
    const owner = probeName();
    registrations[dep] = () => ({ tag: 'dep' });
    registrations[owner] = (c) => ({ dep: c[dep] });
    expect(resolve(owner).dep).toBe(resolve(dep));
  });

  it("reports registration membership through the cradle's `in` trap", () => {
    expect('cacheService' in cradle).toBe(true);
    expect('nopeService' in cradle).toBe(false);
  });

  it('enumerates every registration name as cradle keys', () => {
    expect(Object.keys(cradle).sort()).toEqual(Object.keys(registrations).sort());
  });

  it('registers both CdnLive variants as distinct instances', () => {
    expect(resolve('cdnLiveProvider')).not.toBe(resolve('streamSports99Provider'));
  });
});
