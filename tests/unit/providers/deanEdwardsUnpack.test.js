const { describe, test, expect } = require('bun:test');

const fs = require('fs');
const path = require('path');
const { unpack } = require('../../../src/providers/deanEdwardsUnpack');

const fixtureDir = path.join(__dirname, 'fixtures');
const packedPath = path.join(fixtureDir, 'hgcloud-packed.txt');

/**
 * Minimal, independent packer used as a round-trip oracle. It is written from
 * the packer's own description (replace each word by its base-`radix` index)
 * rather than by reusing `unpack`, so agreement is meaningful evidence.
 */
function packText(text, words, radix = 36) {
  let out = text;
  words.forEach((word, index) => {
    const token = index.toString(radix);
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('\\b' + escaped + '\\b', 'g'), token);
  });
  return out;
}

/** Wraps a payload in a well-formed packer body. */
function wrapPacker(payload, radix, count, words) {
  const dict = words.map((w) => w.replace(/'/g, "\\'")).join('|');
  return `(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('${payload}',${radix},${count},'${dict}'.split('|')))`;
}

describe('deanEdwardsUnpack.unpack', () => {
  test('decodes a real captured packer payload into a usable player script', () => {
    const packed = fs.readFileSync(packedPath, 'utf8');
    const decoded = unpack(packed);

    // Structural invariants of a successful decode.
    expect(typeof decoded).toBe('string');
    expect(decoded.length).toBeGreaterThan(5000);

    // The real payload embeds a JW Player setup whose source is a links.* chain.
    expect(decoded).toContain('jwplayer');
    expect(decoded).toContain('sources:');
    expect(decoded).toContain('type:"hls"');
    expect(decoded).toContain('links.hls3');
    expect(decoded).toContain('links.hls2');

    // The decode must not hand back an `eval(` execution site.
    expect(decoded.includes('eval(function')).toBe(false);
  });

  test('a real decode exposes an extractable playlist URL (production path)', () => {
    const packed = fs.readFileSync(packedPath, 'utf8');
    const decoded = unpack(packed);

    // Mirrors ReplayZoneProvider.extractSoccerfull(): the `file:` key holds a
    // links.* chain, so the playlist URL is taken from the payload itself.
    const embedded = decoded.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
    expect(embedded).not.toBeNull();
    expect(embedded[0]).toContain('master.m3u8');
    expect(embedded[0]).toMatch(/^https?:\/\//);
  });

  test('round-trips against an independently written packer', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta'];
    const source = 'alpha bravo charlie delta alpha bravo';
    const payload = packText(source, words, 36);
    const packed = wrapPacker(payload, 36, words.length, words);

    expect(unpack(packed)).toBe(source);
  });

  test('round-trips a larger dictionary sharing base-36 indices', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const source = words.join(' ');
    const payload = packText(source, words, 36);
    const packed = wrapPacker(payload, 36, words.length, words);

    expect(unpack(packed)).toBe(source);
  });

  test('accepts an eval( ... ) wrapper', () => {
    const packed = fs.readFileSync(packedPath, 'utf8');
    const bare = unpack(packed);
    expect(unpack(`eval(${packed})`)).toBe(bare);
  });

  test('handles a minimal well-formed packer body', () => {
    const packed = "(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0 1 2',10,3,'alpha|bravo|charlie'.split('|')))";
    expect(unpack(packed)).toBe('alpha bravo charlie');
  });

  test('returns null rather than throwing on malformed input', () => {
    const cases = [
      null,
      undefined,
      42,
      '',
      'not a packer',
      'function(p,a,c,k,e,d){while(c--)return p}',
      "(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(/x/g,k[c]);return p}('0 1'))", // missing args
      "(function(p,a,c,k,e,d){return p}('payload',99,2,'a|b'.split('|')))", // invalid radix
      '(function(){return 1})(',
    ];

    for (const input of cases) {
      expect(() => unpack(input)).not.toThrow();
      expect(unpack(input)).toBeNull();
    }
  });

  test('treats the payload as inert data, never executing it', () => {
    // If the payload were executed, the assignment would run and flip the flag.
    globalThis.__packerSideEffect = false;
    const packed = "(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0',10,1,'globalThis.__packerSideEffect=true'.split('|')))";

    const result = unpack(packed);

    expect(globalThis.__packerSideEffect).toBe(false);
    expect(result).toBe('globalThis.__packerSideEffect=true');
    delete globalThis.__packerSideEffect;
  });
});
