const { describe, it, expect, beforeEach, afterEach, setSystemTime } = require('bun:test');

const { isReplayMatch, isMatchLive, mapMatchToMetaPreview, getKickoff } = require('../../../src/catalog');

const HOUR = 3600 * 1000;
const NOW = new Date('2026-09-15T18:00:00Z').getTime();

beforeEach(() => setSystemTime(new Date(NOW)));
afterEach(() => setSystemTime());

const finishedMatch = (overrides = {}) => ({
  id: 'rz_test-fixture-1',
  title: 'Miami Marlins @ Arizona Diamondbacks - MLB Full Game Replay - September 14, 2026',
  category: 'baseball',
  league: 'MLB',
  date: String(NOW - 5 * HOUR),
  status: 'finished',
  sources: [{ source: 'livetv', id: 'https://ok.ru/videoembed/1', url: 'https://ok.ru/videoembed/1' }],
  ...overrides
});

const upcomingMatch = (overrides = {}) => ({
  id: 'test-upcoming-1',
  title: 'Arsenal vs Chelsea',
  category: 'football',
  league: 'Premier League',
  date: String(NOW + 6 * HOUR),
  status: 'upcoming',
  sources: [{ source: 'watchfooty', id: 'x', url: 'https://example.com/x' }],
  ...overrides
});

describe('isReplayMatch', () => {
  it('classifies a finished replay-source event as a replay', () => {
    expect(isReplayMatch(finishedMatch())).toBe(true);
  });

  it('accepts both replay-capable sources', () => {
    expect(isReplayMatch(finishedMatch({ sources: [{ source: 'livetv', id: '1' }] }))).toBe(true);
  });

  it('does not classify an upcoming fixture as a replay', () => {
    expect(isReplayMatch(upcomingMatch())).toBe(false);
  });

  it('does not classify a currently live event as a replay', () => {
    const live = { id: 'l', title: 'A vs B', category: 'football', date: String(NOW - 10 * 60 * 1000), status: 'live', sources: [] };
    expect(isMatchLive(live)).toBe(true);
    expect(isReplayMatch(live)).toBe(false);
  });

  it('never treats 24/7 networks as replays', () => {
    const network = { id: 'n', title: 'Sky Sports F1', category: 'networks', sources: [], status: 'finished', date: String(NOW - HOUR) };
    expect(isReplayMatch(network)).toBe(false);
  });

  it('excludes postponed and cancelled events', () => {
    expect(isReplayMatch(finishedMatch({ status: 'postponed' }))).toBe(false);
    expect(isReplayMatch(finishedMatch({ status: 'cancelled' }))).toBe(false);
  });

  it('handles missing input safely', () => {
    expect(isReplayMatch(null)).toBe(false);
    expect(isReplayMatch(undefined)).toBe(false);
    expect(isReplayMatch({})).toBe(false);
  });

  it('only counts replay-capable providers; live providers never produce replays', () => {
    for (const source of ['streamedpk', 'dlive', 'streamsports99', 'watchfooty']) {
      expect(isReplayMatch(finishedMatch({ sources: [{ source, id: '1' }] }))).toBe(false);
    }
  });

  it('becomes a replay only after the sport live window has elapsed', () => {
    const base = { id: 'b', title: 'A vs B', category: 'baseball', sources: [{ source: 'livetv', id: '1' }] };
    const inWindow = { ...base, date: String(NOW - 1 * HOUR) };
    const elapsed = { ...base, date: String(NOW - 6 * HOUR) };
    expect(isMatchLive(inWindow)).toBe(true);
    expect(isReplayMatch(inWindow)).toBe(false);
    expect(isMatchLive(elapsed)).toBe(false);
    expect(isReplayMatch(elapsed)).toBe(true);
  });

  it('uses a sport-aware window: 3h after kickoff is live baseball but a football replay', () => {
    const sources = [{ source: 'livetv', id: '1' }];
    const baseball = { id: 'b3', title: 'A vs B', category: 'baseball', date: String(NOW - 3 * HOUR), sources };
    const football = { id: 'f3', title: 'A vs B', category: 'football', date: String(NOW - 3 * HOUR), sources };
    expect(isReplayMatch(baseball)).toBe(false);
    expect(isReplayMatch(football)).toBe(true);
  });

  it('lets an explicit terminal status win immediately', () => {
    expect(isReplayMatch(finishedMatch({ date: String(NOW - 30 * 60 * 1000) }))).toBe(true);
  });

  it('needs a terminal status when there is no usable kickoff', () => {
    expect(isReplayMatch(finishedMatch({ date: '', status: 'live' }))).toBe(false);
    expect(isReplayMatch(finishedMatch({ date: '', status: 'finished' }))).toBe(true);
    expect(isReplayMatch(finishedMatch({ date: '0', status: 'live' }))).toBe(false);
  });
});

describe('mapMatchToMetaPreview replay labelling', () => {
  it('labels a replay with a past-tense status and its date, not a kickoff countdown', () => {
    const meta = mapMatchToMetaPreview(finishedMatch());
    expect(meta.name.startsWith('⏪')).toBe(true);
    expect(meta.releaseInfo).toBe('Sep 15, 2026');
    expect(meta.description).toContain('Replay (Sep 15, 2026)');
    expect(meta.description).not.toContain('Kickoff at');
  });

  it('renders the replay date in the configured timezone', () => {
    const lateEvening = finishedMatch({ date: String(Date.parse('2026-09-15T02:30:00Z') - 0) });
    expect(mapMatchToMetaPreview(lateEvening, { timezone: 'America/Los_Angeles' }).releaseInfo).toBe('Sep 14, 2026');
    expect(mapMatchToMetaPreview(lateEvening, { timezone: 'UTC' }).releaseInfo).toBe('Sep 15, 2026');
  });

  it('keeps the kickoff status for an upcoming fixture', () => {
    const meta = mapMatchToMetaPreview(upcomingMatch());
    expect(meta.name.startsWith('⏱️')).toBe(true);
    expect(meta.description).toContain('Kickoff at');
  });

  it('keeps the LIVE prefix for a live match', () => {
    const live = { id: 'l', title: 'A vs B', category: 'football', date: String(NOW - 10 * 60 * 1000), status: 'live', sources: [] };
    const meta = mapMatchToMetaPreview(live);
    expect(meta.name.startsWith('🔴 LIVE:')).toBe(true);
    expect(meta.description).toContain('LIVE NOW');
  });

  it('shows a provider score on a live match', () => {
    const live = { id: 'l', title: 'A vs B', category: 'football', date: String(NOW - 10 * 60 * 1000), status: 'live', score: '2:1', sources: [] };
    expect(mapMatchToMetaPreview(live).description).toContain('LIVE NOW (2:1)');
  });

  it('derives competitors from a head-to-head title when the provider omitted them', () => {
    const meta = mapMatchToMetaPreview({ id: 't', title: 'WTA - Singles: Iga Swiatek vs Coco Gauff', category: 'tennis', date: String(NOW - 10 * 60 * 1000), status: 'live', sources: [] });
    expect(meta.cast).toEqual(['Iga Swiatek', 'Coco Gauff']);
  });
});

describe('getKickoff', () => {
  it('parses "YYYY-MM-DD HH:mm" as UTC', () => {
    expect(new Date(getKickoff('2026-09-18 22:40')).toISOString()).toBe('2026-09-18T22:40:00.000Z');
  });

  it('treats the "0" sentinel as no kickoff', () => {
    expect(getKickoff('0')).toBe(0);
    expect(getKickoff('00')).toBe(0);
    expect(getKickoff('')).toBe(0);
    expect(getKickoff(undefined)).toBe(0);
  });
});
