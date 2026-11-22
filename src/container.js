const CacheService = require('./services/CacheService');
const CircuitBreakerService = require('./services/CircuitBreakerService');
const CronService = require('./services/CronService');
const M3U8ParserService = require('./services/M3U8ParserService');
const MatchAggregator = require('./services/MatchAggregator');
const StreamScoringService = require('./services/StreamScoringService');
const StreamResolveCache = require('./services/StreamResolveCache');
const StreamFreeProvider = require('./providers/StreamFreeProvider');
const SportyHunterProvider = require('./providers/SportyHunterProvider');
const CdnLiveProvider = require('./providers/CdnLiveProvider');
const StreamicProvider = require('./providers/StreamicProvider');
const EmbedIndiaProvider = require('./providers/EmbedIndiaProvider');
const PpvProvider = require('./providers/PpvProvider');
const TimStreamsProvider = require('./providers/TimStreamsProvider');
const PitSportProvider = require('./providers/PitSportProvider');
const ScoreZoneProvider = require('./providers/ScoreZoneProvider');
const SkTechProvider = require('./providers/SkTechProvider');
const VavooProvider = require('./providers/VavooProvider');
const MlbLiveProvider = require('./providers/MlbLiveProvider');
const StreamCornerProvider = require('./providers/StreamCornerProvider');
const ZliveProvider = require('./providers/ZliveProvider');
const DliveProvider = require('./providers/DliveProvider');
const DamiTvProvider = require('./providers/DamiTvProvider');
const StreamEastProvider = require('./providers/StreamEastProvider');
const Ak47LiveProvider = require('./providers/Ak47LiveProvider');
const LiveTVProvider = require('./providers/LiveTVProvider');
const IframeDomainRegistry = require('./services/IframeDomainRegistry');

const registrations = {
  cacheService: (c) => new CacheService(c),
  circuitBreaker: (c) => new CircuitBreakerService(c),
  m3u8Parser: (c) => new M3U8ParserService(c),
  cronService: (c) => new CronService(c),
  matchAggregator: (c) => new MatchAggregator(c),
  streamScorer: (c) => new StreamScoringService(c),
  streamResolveCache: () => new StreamResolveCache(),
  streamFreeProvider: (c) => new StreamFreeProvider(c),
  sportyHunterProvider: (c) => new SportyHunterProvider(c),
  cdnLiveProvider: (c) => new CdnLiveProvider(c, CdnLiveProvider.VARIANTS.cdnlive),
  streamSports99Provider: (c) => new CdnLiveProvider(c, CdnLiveProvider.VARIANTS.streamsports99),
  streamicProvider: (c) => new StreamicProvider(c),
  embedIndiaProvider: (c) => new EmbedIndiaProvider(c),
  ppvProvider: (c) => new PpvProvider(c),
  streamCornerProvider: (c) => new StreamCornerProvider(c),
  zliveProvider: (c) => new ZliveProvider(c),
  iframeDomainRegistry: () => new IframeDomainRegistry(),
  dliveProvider: (c) => new DliveProvider(c),
  damiTvProvider: (c) => new DamiTvProvider(c),
  streamEastProvider: (c) => new StreamEastProvider(c),
  ak47LiveProvider: (c) => new Ak47LiveProvider(c),
  timStreamsProvider: (c) => new TimStreamsProvider(c),
  pitSportProvider: (c) => new PitSportProvider(c),
  scoreZoneProvider: (c) => new ScoreZoneProvider(c),
  skTechProvider: (c) => new SkTechProvider(c),
  vavooProvider: (c) => new VavooProvider(c),
  mlbLiveProvider: (c) => new MlbLiveProvider(c),
  liveTvProvider: (c) => new LiveTVProvider(c),
};

const instances = new Map();

/**
 * Lazy singleton registry. Each factory receives the cradle, whose properties
 * resolve other registrations on access, so constructors can destructure
 * their dependencies by name.
 */
const cradle = new Proxy({}, {
  get: (_, name) => resolve(name),
  has: (_, name) => name in registrations,
  ownKeys: () => Object.keys(registrations),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

function resolve(name) {
  if (instances.has(name)) return instances.get(name);
  const factory = registrations[name];
  if (!factory) throw new Error(`Could not resolve '${String(name)}'.`);
  const instance = factory(cradle);
  instances.set(name, instance);
  return instance;
}

module.exports = { resolve, registrations, cradle };
