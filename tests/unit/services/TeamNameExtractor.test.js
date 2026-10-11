const { describe, it, expect } = require('bun:test');
const { extractTeamsFromTitle } = require('../../../src/services/TeamNameExtractor');
const { parseReplayFilter, filterReplayMatches, isReplayFilterDisabled } = require('../../../src/services/ReplayFilterService');

describe('extractTeamsFromTitle', () => {
  it('splits unambiguous head-to-head separators', () => {
    expect(extractTeamsFromTitle('Arsenal vs Chelsea')).toEqual(['Arsenal', 'Chelsea']);
    expect(extractTeamsFromTitle('Arsenal v Chelsea')).toEqual(['Arsenal', 'Chelsea']);
    expect(extractTeamsFromTitle('Red Sox @ Yankees')).toEqual(['Red Sox', 'Yankees']);
  });

  it('drops a competition prefix before the final colon', () => {
    expect(extractTeamsFromTitle('WTA - Singles: Iga Swiatek vs Coco Gauff')).toEqual(['Iga Swiatek', 'Coco Gauff']);
  });

  it('strips cricket tournament and match-number prefixes', () => {
    expect(extractTeamsFromTitle('IPL 2026 Mumbai Indians vs Chennai Super Kings')).toEqual(['Mumbai Indians', 'Chennai Super Kings']);
    expect(extractTeamsFromTitle('Match 45 India vs Australia')).toEqual(['India', 'Australia']);
  });

  it('does not fabricate competitors from dash titles or motorsport events', () => {
    expect(extractTeamsFromTitle('Nascar Cup Series 2026 - Hollywood Casino 400')).toBeNull();
    expect(extractTeamsFromTitle('Formula 1 Monza at Autodromo')).toBeNull();
  });

  it('returns null for missing or implausible input', () => {
    expect(extractTeamsFromTitle('')).toBeNull();
    expect(extractTeamsFromTitle(null)).toBeNull();
    expect(extractTeamsFromTitle('Sky Sports Main Event')).toBeNull();
    expect(extractTeamsFromTitle('A vs B vs C')).toBeNull();
  });
});

describe('ReplayFilterService', () => {
  const mainstream = { title: 'Real Madrid vs Barcelona', league: 'La Liga', category: 'football' };
  const minor = { title: 'Zaragoza vs Gijon', league: 'La Liga 2', category: 'football' };

  it('defaults to all and tolerates junk', () => {
    expect(parseReplayFilter(undefined)).toBe('all');
    expect(parseReplayFilter({})).toBe('all');
    expect(parseReplayFilter({ replayFilter: 42 })).toBe('all');
    expect(parseReplayFilter({ replayFilter: 'whatever' })).toBe('all');
  });

  it('parses mainstream and disabled spellings', () => {
    expect(parseReplayFilter({ replayFilter: ' Mainstream ' })).toBe('mainstream');
    expect(parseReplayFilter({ replayFilter: 'mainstream-only' })).toBe('mainstream');
    expect(parseReplayFilter({ replayFilter: 'DISABLED' })).toBe('disabled');
    expect(isReplayFilterDisabled({ replayFilter: 'disabled' })).toBe(true);
    expect(isReplayFilterDisabled({})).toBe(false);
  });

  it('returns the identical array for all, narrows for mainstream, empties for disabled', () => {
    const list = [mainstream, minor];
    expect(filterReplayMatches(list, {})).toBe(list);
    expect(filterReplayMatches(list, { replayFilter: 'mainstream' })).toEqual([mainstream]);
    expect(filterReplayMatches(list, { replayFilter: 'disabled' })).toEqual([]);
    expect(filterReplayMatches(null, {})).toEqual([]);
  });
});
