const CacheService = require('./services/CacheService');
const CircuitBreakerService = require('./services/CircuitBreakerService');
const CronService = require('./services/CronService');
const M3U8ParserService = require('./services/M3U8ParserService');
const MatchAggregator = require('./services/MatchAggregator');
const StreamScoringService = require('./services/StreamScoringService');
const StreamResolveCache = require('./services/StreamResolveCache');
const StreamFreeProvider = require('./providers/StreamFreeProvider');
const TimStreamsProvider = require('./providers/TimStreamsProvider');
const SportyHunterProvider = require('./providers/SportyHunterProvider');
const WatchFootyProvider = require('./providers/WatchFootyProvider');
const CdnLiveProvider = require('./providers/CdnLiveProvider');
const StreamicProvider = require('./providers/StreamicProvider');
const EmbedIndiaProvider = require('./providers/EmbedIndiaProvider');
const EmbedStProvider = require('./providers/EmbedStProvider');
const PpvProvider = require('./providers/PpvProvider');
const StreamCornerProvider = require('./providers/StreamCornerProvider');
const ZliveProvider = require('./providers/ZliveProvider');
const DliveProvider = require('./providers/DliveProvider');
const StreamedPkProvider = require('./providers/StreamedPkProvider');

const registrations = {
  cacheService: (c) => new CacheService(c),
  circuitBreaker: (c) => new CircuitBreakerService(c),
  m3u8Parser: (c) => new M3U8ParserService(c),
  cronService: (c) => new CronService(c),
  matchAggregator: (c) => new MatchAggregator(c),
  streamScorer: (c) => new StreamScoringService(c),
  streamResolveCache: () => new StreamResolveCache(),
  streamFreeProvider: (c) => new StreamFreeProvider(c),
  timStreamsProvider: (c) => new TimStreamsProvider(c),
  sportyHunterProvider: (c) => new SportyHunterProvider(c),
  watchFootyProvider: (c) => new WatchFootyProvider(c),
  cdnLiveProvider: (c) => new CdnLiveProvider(c, CdnLiveProvider.VARIANTS.cdnlive),
  streamSports99Provider: (c) => new CdnLiveProvider(c, CdnLiveProvider.VARIANTS.streamsports99),
  streamicProvider: (c) => new StreamicProvider(c),
  embedIndiaProvider: (c) => new EmbedIndiaProvider(c),
  embedStProvider: (c) => new EmbedStProvider(c),
  streamedPkProvider: (c) => new StreamedPkProvider(c),
  ppvProvider: (c) => new PpvProvider(c),
  streamCornerProvider: (c) => new StreamCornerProvider(c),
  zliveProvider: (c) => new ZliveProvider(c),
  dliveProvider: (c) => new DliveProvider(c),
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
