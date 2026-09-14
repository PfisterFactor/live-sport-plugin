const { describe, it, expect } = require('bun:test');
const { manifest } = require('../../../src/manifest');

const ids = manifest.catalogs.map(c => c.id);

describe('manifest', () => {
  it('exposes unique catalog ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('namespaces every catalog id under nuvio_sports_', () => {
    for (const id of ids) expect(id.startsWith('nuvio_sports_')).toBe(true);
  });

  it('gives every sport its own catalog plus the live/upcoming/teams/other buckets', () => {
    expect(ids).toEqual([
      'nuvio_sports_live',
      'nuvio_sports_football',
      'nuvio_sports_cricket',
      'nuvio_sports_basketball',
      'nuvio_sports_motorsport',
      'nuvio_sports_hockey',
      'nuvio_sports_baseball',
      'nuvio_sports_mma',
      'nuvio_sports_golf',
      'nuvio_sports_tennis',
      'nuvio_sports_rugby',
      'nuvio_sports_american_football',
      'nuvio_sports_darts',
      'nuvio_sports_college',
      'nuvio_sports_other',
      'nuvio_sports_upcoming',
      'nuvio_sports_teams'
    ]);
  });

  it('declares every catalog as a searchable, pageable tv catalog', () => {
    for (const c of manifest.catalogs) {
      expect(c.type).toBe('tv');
      expect(c.extra).toEqual([
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ]);
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it('advertises the meta id prefix the catalog actually emits', () => {
    expect(manifest.idPrefixes).toEqual(['nuvio_sport_']);
  });

  it('marks the addon configurable and family/legal safe', () => {
    expect(manifest.behaviorHints).toEqual({ adult: false, p2p: false, configurable: true });
  });

  it('serves catalog, meta and stream for the tv type only', () => {
    expect(manifest.types).toEqual(['tv']);
    expect(manifest.resources.sort()).toEqual(['catalog', 'meta', 'stream']);
  });

  it('exposes teams, sports and timezone config keys with usable defaults', () => {
    const byKey = Object.fromEntries(manifest.config.map(c => [c.key, c]));
    expect(Object.keys(byKey).sort()).toEqual(['sports', 'teams', 'timezone']);
    expect(byKey.sports.default).toBe('all');
    expect(byKey.timezone.default).toBe('UTC');
    expect(byKey.teams.default).toBeUndefined();
    for (const c of manifest.config) expect(c.type).toBe('text');
  });

  it('stays installable without any user config (no required config keys)', () => {
    for (const c of manifest.config) expect(c.required).toBeFalsy();
  });
});
