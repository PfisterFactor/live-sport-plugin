const { describe, it, expect } = require('bun:test');
const StreamicProvider = require('../../../src/providers/StreamicProvider');
const { makeCradle, res } = require('./fixtures/helpers');

function makeProvider(responses) {
  const p = new StreamicProvider(makeCradle());
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  p._attempts = 0;
  p.proxyFetch = async () => {
    p._attempts += 1;
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return p;
}

describe('StreamicProvider.getMatches', () => {
  const payload = [
    { id: 51, title: 'Arsenal - Chelsea', category: 'Soccer', league: 'EPL', startTime: 1772366400, _embeds: [{ language: 'EN', embeds: [{ embed: 'https://streami.fit/live/?channel_id=' }] }] },
    { id: '52', title: 'Lakers vs Celtics', category: 'Basketball', startTime: 1772370000 },
    { title: 'no id' },
  ];

  it('prefixes ids, splits team names on both separators and converts seconds to millis', async () => {
    const matches = await makeProvider(res({ json: payload })).getMatches();
    expect(matches.map((m) => m.id)).toEqual(['streamic_51', 'streamic_52']);
    expect(matches[0].team1).toBe('Arsenal');
    expect(matches[0].team2).toBe('Chelsea');
    expect(matches[0].date).toBe('1772366400000');
    expect(matches[0].category).toBe('football');
    expect(matches[0].league).toBe('EPL');
    expect(matches[1].team1).toBe('Lakers');
    expect(matches[1].team2).toBe('Celtics');
    expect(matches[1].league).toBe('basketball');
  });

  it('carries the embed payload through to the source descriptor', async () => {
    const [m] = await makeProvider(res({ json: payload })).getMatches();
    expect(m.sources[0]).toEqual({ source: 'streamic', id: '51', _embeds: payload[0]._embeds });
  });

  it('leaves teams null for single-name titles', async () => {
    const [m] = await makeProvider(res({ json: [{ id: 1, title: 'Sky Sports Main Event' }] })).getMatches();
    expect(m.team1).toBeNull();
    expect(m.team2).toBeNull();
  });

  it('returns [] when the API answers 200 with a non-array payload', async () => {
    expect(await makeProvider(res({ json: { error: 'nope' } })).getMatches()).toEqual([]);
  });

  it('retries once on a transient 5xx and succeeds', async () => {
    const p = makeProvider([res({ status: 503, body: '' }), res({ json: payload })]);
    const matches = await p.getMatches();
    expect(p._attempts).toBe(2);
    expect(matches).toHaveLength(2);
  });

  it('does not retry a 4xx', async () => {
    const p = makeProvider(res({ status: 404, body: '' }));
    expect(await p.getMatches()).toEqual([]);
    expect(p._attempts).toBe(1);
  });
});

describe('StreamicProvider.resolveStream', () => {
  const p = new StreamicProvider(makeCradle());

  it('flattens every language group into external player links', async () => {
    const extra = { _embeds: [
      { language: 'English', embeds: [{ embed: 'https://a.tv/1', label: 'HD' }, { embed: 'https://a.tv/2' }] },
      { embeds: [{ embed: 'https://b.tv/3', label: 'SD' }] },
    ] };
    const out = await p.resolveStream('51', 'football', 'A vs B', extra);
    expect(out.map((s) => s.externalUrl)).toEqual(['https://a.tv/1', 'https://a.tv/2', 'https://b.tv/3']);
    expect(out[0].title).toBe('English (HD)');
    expect(out[2].title).toBe('Unknown (SD)');
  });

  it('completes truncated channel_id urls with the source id', async () => {
    const extra = { _embeds: [{ language: 'EN', embeds: [{ embed: 'https://streami.fit/live/?channel_id=' }] }] };
    const [s] = await p.resolveStream('51', 'football', 'A vs B', extra);
    expect(s.externalUrl).toBe('https://streami.fit/live/?channel_id=51');
  });

  it('returns [] without embed data and skips entries with no embed url', async () => {
    expect(await p.resolveStream('51', 'football', 'A vs B')).toEqual([]);
    expect(await p.resolveStream('51', 'football', 'A vs B', {})).toEqual([]);
    expect(await p.resolveStream('51', 'football', 'A vs B', { _embeds: [{ embeds: [{ label: 'x' }] }] })).toEqual([]);
  });
});
