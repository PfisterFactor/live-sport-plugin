const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { manifestProxyUrl } = require('../proxyUrl');

const SITE = 'https://scorezonetv.live';
const API_BASE = 'https://testscore.pxxl.pro';
const IPTV_URL = 'https://scorezone-live.scorezone.workers.dev/api/iptv/channels';
const HEADERS = { Origin: SITE, Referer: `${SITE}/` };

/** Cap on channels minted per fixture; each one costs a playback request. */
const MAX_CHANNELS = 6;
const CHANNELS_TTL_MS = 60 * 1000;
const IPTV_TTL_MS = 20 * 60 * 1000;
/** A cached IPTV URL this close to its expiry is refreshed before use. */
const IPTV_EXPIRY_MARGIN_MS = 60 * 1000;

/** Fork category -> livescore API sport slug. */
const SPORT_API_MAP = {
  football: 'soccer',
  basketball: 'basketball',
  hockey: 'hockey',
  tennis: 'tennis',
  cricket: 'cricket',
  baseball: 'baseball',
  motorsport: 'motorsport',
  mma: 'boxing',
  rugby: 'rugby-union',
  golf: 'golf',
};

/** Event status words (Eps) that mean the fixture is over or will not be played. */
const FINISHED_STATUS = new Set(['FT', 'AET', 'AP', 'Postp.', 'Canc.', 'Aband.', 'Awd.', 'Int.', 'WO', 'Ret.']);

/**
 * Leagues worth listing per sport, as [country rule, league rule] pairs where
 * each rule is a `|` list of normalized names. Football keys on country.
 */
const LEAGUES = {
  football: [
    ['England', 'Premier League'], ['Spain', 'LaLiga|La Liga'], ['France', 'Ligue 1'], ['Italy', 'Serie A'],
    ['England', 'Championship|EFL Championship'], ['Scotland', 'Premiership'], ['Spain', 'LaLiga 2|Segunda Division'],
    ['Brazil', 'Serie A'], ['Romania', 'Liga 1|Liga I|Superliga'], ['Greece', 'Super League'], ['Denmark', 'Superliga'],
    ['Portugal', 'Primeira Liga|Liga Portugal'], ['Argentina', 'Primera Division|Liga Profesional'],
    ['Netherlands', 'Eredivisie'], ['Austria', 'Bundesliga|Cup|OFB Cup'], ['Scotland', 'FA Cup|Scottish Cup'],
    ['England', 'League One'], ['France', 'Ligue 2'], ['Germany', '2 Bundesliga|Bundesliga 2'],
    ['', 'Copa Sudamericana|Copa Libertadores'], ['Australia', 'A League|A League Men'], ['Poland', 'Ekstraklasa'],
    ['Germany', 'Bundesliga|DFB Pokal'], ['', 'Champions League|Europa League|Conference League'],
    ['Saudi Arabia', 'Pro League|Saudi Pro League'], ['Turkiye|Turkey', 'Super Lig'],
    ['Belgium', 'Pro League|First Division A'], ['Switzerland', 'Super League'], ['USA|United States', 'MLS'],
    ['Spain', 'Copa del Rey'], ['England', 'EFL Cup|EFL Trophy'], ['Portugal', 'Taca da Liga|League Cup'],
    ['Denmark', 'DBU Pokalen|Cup'], ['Greece', 'Cup|Greek Cup'], ['Netherlands', 'KNVB Cup|Cup'],
  ],
  basketball: [['', 'Euroleague|NBA|WNBA|NCAA|NCAA Basketball|NCAA Men|NCAA Women']],
  hockey: [['', 'NHL']],
  baseball: [['', 'MLB']],
  motorsport: [['', 'Formula 1|Formula One|MotoGP']],
  mma: [['', 'UFC|Boxing|WWE|AEW|TNA Wrestling|NJPW|PFL|ONE Championship|BKFC|Oktagon MMA']],
  tennis: [['', 'ATP|ATP World Tour']],
  rugby: [['', 'English Prem Rugby|Premiership|United Rugby Championship|Top 14|Super Rugby|Rugby World Cup|Six Nations|Rugby Championship|Autumn Nations Cup|Currie Cup|National Provincial Championship|Internationals|Rugby Union Internationals|Rugby League World Cup|NRL|Super League|State of Origin']],
  golf: [['', 'PGA Tour']],
  cricket: [['', 'International Test Match|Test Series|Test Matches|ODI Series|One Day Internationals|T20I Series|Twenty20 Internationals|ICC World Test Championship|Big Bash League|The Hundred|SA20|Caribbean Premier League']],
};

/** Lowercase, accent-free, alphanumeric-only form used to compare league names. */
function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True when a livescore stage (country + league) is on the curated list for the sport. */
function isListedStage(sport, stage) {
  const rules = LEAGUES[sport];
  if (!rules) return false;
  const names = [stage.Snm, stage.CompN].map(normalizeName);
  const country = normalizeName(stage.Cnm);
  return rules.some(([countryRule, leagueRule]) =>
    (!countryRule || countryRule.split('|').some((c) => normalizeName(c) === country)) &&
    leagueRule.split('|').some((l) => {
      const league = normalizeName(l);
      return names.some((n) => n === league || n.startsWith(`${league} `));
    })
  );
}

/** Today's and tomorrow's UTC dates as YYYYMMDD, the livescore API's day keys. */
function utcDateKeys(now = new Date()) {
  return [0, 1].map((offset) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  });
}

/** Parses the feed's YYYYMMDDHHmmss UTC kickoff into epoch ms, or 0. */
function parseKickoff(esd) {
  const s = String(esd || '');
  if (!/^\d{14}$/.test(s)) return 0;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
}

/** First team name of a livescore team list or object. */
function teamName(team) {
  if (Array.isArray(team)) return (team[0] && team[0].Nm) || '';
  return (team && typeof team.Nm === 'string' && team.Nm) || '';
}

/**
 * ScoreZone (scorezonetv.live). A livescore API supplies the fixtures; its
 * channels endpoint lists broadcasters for a fixture and its playback endpoint
 * mints a signed HLS URL per channel. A separate IPTV feed carries 24/7 sports
 * channels as direct MPEG-TS URLs.
 */
class ScoreZoneProvider extends BaseProvider {
  /**
   * @param {object} opts  provider cradle ({ circuitBreaker })
   */
  constructor(opts) {
    super(opts);
    this.name = 'ScoreZone';
    this.sourceName = 'scorezone';
    this._channelsCache = new Map();
    this._iptv = { channels: [], fetchedAt: 0 };

    this.fetchDay = this.circuitBreaker.wrap(`${this.name}_fetchDay`, async (apiSport, dateKey) => {
      const res = await this.proxyFetch(`${API_BASE}/api/livescore/${apiSport}/${dateKey}`, { headers: HEADERS, timeoutMs: 8000 });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${apiSport}/${dateKey}`);
      return await res.json();
    });
  }

  /** Sports-genre IPTV channels, cached for IPTV_TTL_MS unless `force` is set. */
  async _iptvChannels(force = false) {
    if (!force && this._iptv.channels.length && Date.now() - this._iptv.fetchedAt < IPTV_TTL_MS) {
      return this._iptv.channels;
    }
    try {
      const res = await this.proxyFetch(IPTV_URL, { headers: HEADERS, timeoutMs: 8000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const channels = (Array.isArray(data && data.channels) ? data.channels : [])
        .filter((ch) => ch && ch.id && ch.name && ch.url && Array.isArray(ch.genres) && ch.genres.some((g) => /sports/i.test(g)));
      if (channels.length) this._iptv = { channels, fetchedAt: Date.now() };
    } catch (err) {
      console.warn(`[${this.name}] IPTV channel fetch failed:`, err.message);
    }
    return this._iptv.channels;
  }

  /** Fixture matches for one livescore day payload of one sport. */
  _fixtureMatches(category, data, seen) {
    const out = [];
    for (const stage of Array.isArray(data && data.Stages) ? data.Stages : []) {
      if (!isListedStage(category, stage)) continue;
      for (const event of Array.isArray(stage.Events) ? stage.Events : []) {
        const eid = event && event.Eid ? String(event.Eid) : '';
        if (!eid || seen.has(eid) || FINISHED_STATUS.has(event.Eps)) continue;
        const startMs = parseKickoff(event.Esd);
        const home = teamName(event.T1);
        const away = teamName(event.T2);
        if (!startMs || (!home && !away)) continue;
        seen.add(eid);

        const competition = stage.CompN || stage.Cnm || '';
        out.push(new MatchEntity({
          id: `scorezone_${eid}`,
          title: away ? `${home} vs ${away}` : home,
          category,
          date: String(startMs),
          status: event.Eps && event.Eps !== 'NS' ? 'live' : (startMs <= Date.now() ? 'live' : 'upcoming'),
          league: stage.CompN || stage.Snm || stage.Cnm || '',
          team1: { name: home },
          team2: { name: away },
          sources: [{ source: this.sourceName, id: eid, home, away, sport: category, competition, start: startMs }],
        }));
      }
    }
    return out;
  }

  /**
   * Curated-league fixtures for today and tomorrow plus the sports IPTV channels.
   * @returns {Promise<MatchEntity[]>}
   */
  async getMatches() {
    const matches = [];
    const seen = new Set();
    const jobs = [];
    for (const [category, apiSport] of Object.entries(SPORT_API_MAP)) {
      for (const dateKey of utcDateKeys()) {
        jobs.push(this.fetchDay.fire(apiSport, dateKey).then((data) => ({ category, data })));
      }
    }

    const [days, iptv] = await Promise.all([Promise.allSettled(jobs), this._iptvChannels()]);
    for (const day of days) {
      if (day.status === 'fulfilled') matches.push(...this._fixtureMatches(day.value.category, day.value.data, seen));
    }
    if (days.every((d) => d.status === 'rejected')) console.error(`[${this.name}] Livescore sync failed across all sports`);

    for (const ch of iptv) {
      matches.push(new MatchEntity({
        id: `scorezone_ch_${ch.id}`,
        title: ch.name,
        category: 'networks',
        date: '0',
        popular: '1',
        league: ch.country || 'Live TV',
        sources: [{ source: this.sourceName, id: `iptv_${ch.id}`, name: ch.name, streamUrl: ch.url }],
      }));
    }
    return matches;
  }

  /** Channel list (with the match key playback needs) for a fixture, cached briefly. */
  async _channelsFor(meta) {
    const cached = this._channelsCache.get(meta.eventId);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    const qs = new URLSearchParams({
      home: meta.home || '',
      away: meta.away || '',
      sport: meta.sport || 'football',
      eventId: meta.eventId,
      ...(meta.start ? { start: String(meta.start) } : {}),
      ...(meta.competition ? { competition: meta.competition } : {}),
    });
    const res = await this.proxyFetch(`${API_BASE}/api/matches/channels?${qs}`, { headers: HEADERS, timeoutMs: 8000 });
    if (!res.ok) throw new Error(`channels HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.key || !Array.isArray(data.channels)) throw new Error('malformed channels payload');
    if (this._channelsCache.size >= 200) this._channelsCache.delete(this._channelsCache.keys().next().value);
    this._channelsCache.set(meta.eventId, { data, expiresAt: Date.now() + CHANNELS_TTL_MS });
    return data;
  }

  /** Mints the signed playback URL for one channel of a fixture, or null. */
  async _playback(matchKey, channelId) {
    const res = await this.proxyFetch(`${API_BASE}/api/matches/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ matchKey, channelId }),
      timeoutMs: 8000,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.url === 'string' ? data.url : null;
  }

  /** Pseudo embed URL carrying everything a renewal needs to re-mint one channel. */
  _renewalEmbed(meta, channelId) {
    const qs = new URLSearchParams({
      home: meta.home || '', away: meta.away || '', sport: meta.sport || 'football', eventId: meta.eventId,
      start: String(meta.start || ''), competition: meta.competition || '', channel: channelId,
    });
    return `${SITE}/match?${qs}`;
  }

  /** Re-mints a channel's manifest from a renewal embed URL; returns { m3u8, referer } or null. */
  async extractM3u8(embedUrl) {
    const q = new URL(embedUrl).searchParams;
    const meta = {
      eventId: q.get('eventId'), home: q.get('home'), away: q.get('away'), sport: q.get('sport'),
      start: Number(q.get('start')) || 0, competition: q.get('competition'),
    };
    const channelId = q.get('channel');
    if (!meta.eventId || !channelId) return null;
    this._channelsCache.delete(meta.eventId);
    const url = await this._playback((await this._channelsFor(meta)).key, channelId);
    return url ? { m3u8: url, referer: `${SITE}/` } : null;
  }

  /** Mints a proxied manifest for up to MAX_CHANNELS unlocked broadcasters of a fixture. */
  async _resolveFixture(src, matchTitle) {
    const meta = { eventId: String(src.id), home: src.home, away: src.away, sport: src.sport, start: src.start, competition: src.competition };
    const data = await this._channelsFor(meta);
    const channels = data.channels.filter((c) => c && !c.locked).slice(0, MAX_CHANNELS);

    const minted = await Promise.all(channels.map(async (ch) => {
      try {
        const url = await this._playback(data.key, ch.id);
        return url ? { ch, url } : null;
      } catch (_) {
        return null;
      }
    }));

    return minted.filter(Boolean).map(({ ch, url }) => new StreamEntity({
      name: this.name,
      title: `${matchTitle} (${ch.name})`,
      url: manifestProxyUrl({ url, referer: `${SITE}/`, origin: SITE, renew: this.sourceName, embed: this._renewalEmbed(meta, ch.id), proxySegments: true }),
      behaviorHints: { notWebReady: true },
      resolution: ch.quality === 'HD' ? '1080p' : (ch.quality || null),
    }));
  }

  /** Direct MPEG-TS stream of one IPTV channel, refreshing its URL when near expiry. */
  async _resolveChannel(src, matchTitle) {
    const channelId = String(src.id).replace(/^iptv_/, '');
    let channel = this._iptv.channels.find((c) => c.id === channelId);
    if (!channel || !channel.expiresAt || channel.expiresAt <= Date.now() + IPTV_EXPIRY_MARGIN_MS) {
      const fresh = (await this._iptvChannels(true)).find((c) => c.id === channelId);
      if (fresh) channel = fresh;
    }
    const url = (channel && channel.url) || src.streamUrl;
    if (!url) return [];
    return [new StreamEntity({
      name: this.name,
      title: `ScoreZone | ${(channel && channel.name) || src.name || matchTitle}`,
      url,
      resolution: 'HD',
      behaviorHints: {
        notWebReady: false,
        proxyHeaders: { request: { Origin: SITE, Referer: `${SITE}/`, 'User-Agent': BaseProvider.DEFAULT_UA } },
      },
    })];
  }

  /**
   * Streams for a fixture source or an `iptv_` channel source.
   * @returns {Promise<StreamEntity[]>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    try {
      const id = String(src.id || sourceId || '');
      if (!id) return [];
      return id.startsWith('iptv_')
        ? await this._resolveChannel({ ...src, id }, matchTitle)
        : await this._resolveFixture({ ...src, id }, matchTitle);
    } catch (err) {
      console.warn(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
      return [];
    }
  }
}

module.exports = ScoreZoneProvider;
module.exports.isListedStage = isListedStage;
module.exports.utcDateKeys = utcDateKeys;
