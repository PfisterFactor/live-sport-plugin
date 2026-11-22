const { describe, test, expect } = require('bun:test');
const { parseXml, childrenNamed, firstChild } = require('../../../src/services/MpdXml');

describe('parseXml', () => {
  test('reads attributes, nested elements, text and strips namespace prefixes from element names', () => {
    const root = parseXml(`<?xml version="1.0"?>
      <!-- a comment <with> markup -->
      <MPD xmlns:cenc="urn:mpeg:cenc:2013" type='dynamic'>
        <Period id="1"><BaseURL> https://cdn.example/x/ </BaseURL>
          <ContentProtection cenc:default_KID="AB-CD"><cenc:pssh>AAAA</cenc:pssh></ContentProtection>
        </Period>
      </MPD>`);

    expect(root.name).toBe('MPD');
    expect(root.attrs.type).toBe('dynamic');
    const period = firstChild(root, 'Period');
    expect(firstChild(period, 'BaseURL').text.trim()).toBe('https://cdn.example/x/');
    const cp = firstChild(period, 'ContentProtection');
    expect(cp.attrs['cenc:default_KID']).toBe('AB-CD');
    expect(firstChild(cp, 'pssh').text).toBe('AAAA');
  });

  test('decodes predefined and numeric entities, CDATA, and self-closing tags', () => {
    const root = parseXml('<a q="x&amp;y&#65;&#x42;"><b/><c><![CDATA[<raw> & text]]></c><b/></a>');
    expect(root.attrs.q).toBe('x&yAB');
    expect(childrenNamed(root, 'b')).toHaveLength(2);
    expect(firstChild(root, 'c').text).toBe('<raw> & text');
  });

  test('keeps > inside a quoted attribute value', () => {
    expect(parseXml('<a v="1>2"/>').attrs.v).toBe('1>2');
  });

  test('refuses DOCTYPE, mismatched tags, truncation and multiple roots', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(/DOCTYPE/);
    expect(() => parseXml('<a><b></a></b>')).toThrow();
    expect(() => parseXml('<a><b>')).toThrow();
    expect(() => parseXml('<a/><b/>')).toThrow();
    expect(() => parseXml('')).toThrow();
  });

  test('bounds nesting depth', () => {
    expect(() => parseXml('<a>'.repeat(200) + '</a>'.repeat(200))).toThrow(/deep/);
  });
});
