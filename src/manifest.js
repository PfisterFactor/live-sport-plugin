const { isReplayFilterDisabled } = require('./services/ReplayFilterService');

const PAGED = [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }];

const GENRE_OPTIONS = ['Football', 'Cricket', 'Basketball', 'Motorsport', 'Tennis', 'Baseball', 'Hockey', 'Rugby', 'American Football', 'MMA', 'Golf', 'Darts', 'College', 'Other'];

/** Genre filter extra; `withReplays` adds the "Replays" mode that lists archive fixtures instead of live ones. */
function genreExtra(withReplays) {
  return { name: 'genre', options: withReplays ? [...GENRE_OPTIONS, 'Replays'] : GENRE_OPTIONS, isRequired: false };
}

const REPLAY_SPORTS = [
  ['football', '⚽ Football Replays'],
  ['motorsport', '🏎️ Motorsport Replays'],
  ['baseball', '⚾ Baseball Replays'],
  ['rugby', '🏉 Rugby Replays'],
  ['basketball', '🏀 Basketball Replays'],
  ['tennis', '🎾 Tennis Replays'],
  ['hockey', '🏒 Hockey Replays'],
  ['american_football', '🏈 American Football Replays']
];

const REPLAY_SPORT_CATALOGS = REPLAY_SPORTS.map(([sport, name]) => ({
  type: 'tv', id: `nuvio_sports_replays_${sport}`, name, extra: PAGED
}));

const manifest = {
  id: 'community.nuvio.live-sports',
  version: '3.0.0',
  name: '🏆 Nuvio Live Sports',
  description:
    'The ultimate live sports aggregator. Stream live Football, NBA, NFL, NHL, F1, and more. ' +
    'Scrapes high-speed streams from multiple providers including StreamFree, TimStreams, and IPTV. Zero-lag proxy included.',
  logo: '/logo.png',

  types: ['tv'],
  resources: ['catalog', 'meta', 'stream'],

  catalogs: [
    { type: 'tv', id: 'nuvio_sports_teams', name: '⭐ Your Teams', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_live', name: '🔴 Live Now', extra: [genreExtra(true), ...PAGED] },
    { type: 'tv', id: 'nuvio_sports_replays', name: '⏪ Sports Replays', extra: [genreExtra(false), ...PAGED] },
    ...REPLAY_SPORT_CATALOGS,
    { type: 'tv', id: 'nuvio_sports_football', name: '⚽ Soccer', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_cricket', name: '🏏 Cricket', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_basketball', name: '🏀 Basketball', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_motorsport', name: '🏎️ F1 & Motor', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_hockey', name: '🏒 Hockey', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_baseball', name: '⚾ Baseball', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_mma', name: '🥊 MMA', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_golf', name: '⛳ Golf', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_tennis', name: '🎾 Tennis', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_rugby', name: '🏉 Rugby', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_american_football', name: '🏈 American Football', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_darts', name: '🎯 Darts', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_college', name: '🎓 College Sports', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_other', name: '🏅 Other Sports', extra: PAGED },
    { type: 'tv', id: 'nuvio_sports_upcoming', name: '⏱️ Upcoming', extra: [genreExtra(false), ...PAGED] }
  ],

  config: [
    { key: 'teams', title: 'Favorite Teams (comma separated)', type: 'text' },
    { key: 'sports', title: 'Enabled Sports (comma separated)', type: 'text', default: 'all' },
    {
      key: 'timezone',
      title: 'Timezone',
      type: 'text',
      default: 'UTC'
    },
    { key: 'languages', title: 'Preferred Languages (comma separated, English always first)', type: 'text' },
    { key: 'replayFilter', title: 'Replay Catalog (all, mainstream or disabled)', type: 'text', default: 'all' },
    { key: 'webStreams', title: 'Web Streams (enabled or disabled)', type: 'text', default: 'enabled' }
  ],

  idPrefixes: ['nuvio_sport_'],

  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true
  },

  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..F6aEbE6t6R_hibs0MWTXdw.T0iVZbTb3-Cn9MUDoIic5yovMLCxjssPZHs2meJgSbTBXVegWV0j27ZCkIi60pNbuxEy2tQXHxbVytxthyD4GozD5DCzDnpdUcWQOmhd4IQs37WQxp7-neyrt9aeLP_N.XRyLWSFHcEupa3FTtsh_eA'
  },
};

const SPORT_CATALOG_IDS = ['football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball', 'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts', 'college'];
const ALWAYS_KEPT_CATALOG_IDS = ['nuvio_sports_live', 'nuvio_sports_upcoming', 'nuvio_sports_teams', 'nuvio_sports_replays'];
const REPLAY_CATALOG_PREFIX = 'nuvio_sports_replays';

/**
 * Renders the manifest for one user's config: narrows the catalogs to the
 * enabled sports, drops "Your Teams" when no teams are set, and removes every
 * replay catalog (and the "Replays" genre) when `replayFilter` is 'disabled'.
 *
 * @param {object} [config] - Decoded config segment.
 * @returns {object} A fresh manifest copy; the shared one is never mutated.
 */
function renderManifest(config) {
  const conf = config || {};
  const rendered = JSON.parse(JSON.stringify(manifest));

  if (typeof conf.sports === 'string' && conf.sports !== 'all') {
    const enabled = conf.sports.split(',').map(s => s.trim());
    const keep = new Set(ALWAYS_KEPT_CATALOG_IDS);
    for (const sport of SPORT_CATALOG_IDS) {
      if (enabled.includes(sport)) keep.add(`nuvio_sports_${sport}`);
    }
    if (enabled.includes('other')) keep.add('nuvio_sports_other');
    rendered.catalogs = rendered.catalogs.filter(c =>
      keep.has(c.id) || (c.id.startsWith(`${REPLAY_CATALOG_PREFIX}_`) && enabled.includes(c.id.slice(REPLAY_CATALOG_PREFIX.length + 1))));
  }

  if (typeof conf.teams !== 'string' || conf.teams.trim() === '') {
    rendered.catalogs = rendered.catalogs.filter(c => c.id !== 'nuvio_sports_teams');
  }

  if (isReplayFilterDisabled(conf)) {
    rendered.catalogs = rendered.catalogs.filter(c => !c.id.startsWith(REPLAY_CATALOG_PREFIX));
    for (const c of rendered.catalogs) {
      for (const extra of c.extra) {
        if (extra.name === 'genre') extra.options = extra.options.filter(o => o !== 'Replays');
      }
    }
  }

  return rendered;
}

module.exports = { manifest, renderManifest };
