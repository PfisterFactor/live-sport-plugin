const { describe, it, expect } = require('bun:test');
const { manifest, renderManifest } = require('../../../src/manifest');

const ids = manifest.catalogs.map(c => c.id);

describe('manifest', () => {
  it('exposes unique catalog ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('namespaces every catalog id under nuvio_sports_', () => {
    for (const id of ids) expect(id.startsWith('nuvio_sports_')).toBe(true);
  });

  it('lists Your Teams first, then live, replays, every sport, and upcoming', () => {
    expect(ids).toEqual([
      'nuvio_sports_teams',
      'nuvio_sports_live',
      'nuvio_sports_replays',
      'nuvio_sports_replays_football',
      'nuvio_sports_replays_motorsport',
      'nuvio_sports_replays_baseball',
      'nuvio_sports_replays_rugby',
      'nuvio_sports_replays_basketball',
      'nuvio_sports_replays_tennis',
      'nuvio_sports_replays_hockey',
      'nuvio_sports_replays_american_football',
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
      'nuvio_sports_upcoming'
    ]);
  });

  it('declares every catalog as a searchable, pageable tv catalog', () => {
    for (const c of manifest.catalogs) {
      expect(c.type).toBe('tv');
      const names = c.extra.map(e => e.name);
      expect(names).toContain('search');
      expect(names).toContain('skip');
      for (const e of c.extra) expect(e.isRequired).toBe(false);
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it('offers a Replays genre only on Live Now', () => {
    const genreOptions = (id) => manifest.catalogs.find(c => c.id === id).extra.find(e => e.name === 'genre').options;
    expect(genreOptions('nuvio_sports_live')).toContain('Replays');
    expect(genreOptions('nuvio_sports_upcoming')).not.toContain('Replays');
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

  it('exposes the config keys with usable defaults', () => {
    const byKey = Object.fromEntries(manifest.config.map(c => [c.key, c]));
    expect(Object.keys(byKey).sort()).toEqual(['languages', 'replayFilter', 'sports', 'teams', 'timezone', 'webStreams']);
    expect(byKey.sports.default).toBe('all');
    expect(byKey.timezone.default).toBe('UTC');
    expect(byKey.replayFilter.default).toBe('all');
    expect(byKey.webStreams.default).toBe('enabled');
    expect(byKey.teams.default).toBeUndefined();
    for (const c of manifest.config) expect(c.type).toBe('text');
  });

  it('stays installable without any user config (no required config keys)', () => {
    for (const c of manifest.config) expect(c.required).toBeFalsy();
  });

  describe('renderManifest', () => {
    const renderedIds = (config) => renderManifest(config).catalogs.map(c => c.id);

    it('hides Your Teams until teams are configured', () => {
      expect(renderedIds({})).not.toContain('nuvio_sports_teams');
      expect(renderedIds({ teams: 'Arsenal' })).toContain('nuvio_sports_teams');
    });

    it('keeps every replay catalog for replayFilter all and mainstream', () => {
      for (const replayFilter of [undefined, 'all', 'mainstream']) {
        const out = renderedIds({ replayFilter });
        expect(out).toContain('nuvio_sports_replays');
        expect(out).toContain('nuvio_sports_replays_football');
      }
    });

    it('removes every replay catalog and the Replays genre for replayFilter disabled', () => {
      const rendered = renderManifest({ replayFilter: 'disabled', teams: 'x' });
      expect(rendered.catalogs.some(c => c.id.startsWith('nuvio_sports_replays'))).toBe(false);
      const live = rendered.catalogs.find(c => c.id === 'nuvio_sports_live');
      expect(live.extra.find(e => e.name === 'genre').options).not.toContain('Replays');
    });

    it('narrows to the enabled sports, including college and matching replay rows', () => {
      const out = renderedIds({ sports: 'football,college' });
      expect(out).toContain('nuvio_sports_football');
      expect(out).toContain('nuvio_sports_college');
      expect(out).toContain('nuvio_sports_replays_football');
      expect(out).not.toContain('nuvio_sports_cricket');
      expect(out).not.toContain('nuvio_sports_replays_tennis');
      expect(out).toContain('nuvio_sports_live');
    });

    it('never mutates the shared manifest', () => {
      const before = manifest.catalogs.length;
      renderManifest({ replayFilter: 'disabled', sports: 'football' });
      expect(manifest.catalogs).toHaveLength(before);
    });
  });
});
