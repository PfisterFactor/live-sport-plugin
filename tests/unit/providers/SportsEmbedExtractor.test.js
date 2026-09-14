const { describe, it, expect } = require('bun:test');
const { buildProtoHex } = require('../../../src/providers/SportsEmbedExtractor');

/** Decode the length-delimited protobuf produced by buildProtoHex. */
function decodeProto(hex) {
  const buf = Buffer.from(hex, 'hex');
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const field = buf[i] >> 3;
    const wire = buf[i] & 0x07;
    i += 1;
    expect(wire).toBe(2);
    const len = buf[i];
    i += 1;
    out[field] = buf.slice(i, i + len).toString('utf8');
    i += len;
  }
  return out;
}

describe('buildProtoHex', () => {
  it('maps the embed url path segments onto the protobuf fields', () => {
    const hex = buildProtoHex('https://sportsembed.su/embed/6028327/club-america-columbus-crew/platinum/1');
    expect(decodeProto(hex)).toEqual({
      1: 'platinum',
      2: 'club-america-columbus-crew',
      3: '1',
      4: '6028327',
    });
  });

  it('reads the last four segments, ignoring any deeper prefix path', () => {
    const hex = buildProtoHex('https://sportsembed.su/x/y/embed/999/slug-here/vip/3');
    expect(decodeProto(hex)).toEqual({ 1: 'vip', 2: 'slug-here', 3: '3', 4: '999' });
  });

  it('produces lowercase hex with no separators', () => {
    const hex = buildProtoHex('https://sportsembed.su/embed/1/a/b/c');
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });
});
