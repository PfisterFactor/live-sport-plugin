const { parseTimezone } = require('../timezone');
const { extractTeamsFromTitle } = require('./TeamNameExtractor');

// ─── Fuzzy Match Helpers ────────────────────────────────────────────────────

/**
 * Normalizes team/event names by collapsing well-known multi-word clubs and
 * popular abbreviations into single collision-safe compound tokens so that
 * Jaccard / subset matching cannot accidentally merge different teams that share
 * a single word (e.g. "Inter Milan" vs "AC Milan" both contain "milan").
 *
 * ORDER MATTERS: more specific aliases (inter miami, inter turku) must come
 * before the bare-"inter" rule, otherwise "Inter Miami" would compound to
 * "intermilan" and collide with Inter Milan.
 */
function _compoundify(t) {
  const aliases = [
    // Formula 1 must come first so its "1" never survives as a stray digit.
    [/\bformula\s*(?:one|1)\b|\bf[- ]?1\b/g, 'formulaone'],
    [/\bgrand\s*prix\b|\bgp\b/g, 'grandprix'],
    // Football (Soccer)
    [/\bman(chester)?\s*utd\b|\bmanchester\s*united\b/g, 'manchesterunited'],
    [/\bman\.?\s+united\b/g, 'manchesterunited'], // "Man United" / "Man. United" (gap found by A/B testing)
    [/\bman(chester)?\s*city\b/g, 'manchestercity'],
    [/\bspurs\b|\btottenham(\s*hotspur)?\b/g, 'tottenham'],
    [/\bwolves\b|\bwolverhampton(\s*wanderers)?\b/g, 'wolverhampton'],
    [/\bpsg\b|\bparis\s*(saint|st)\s*germain\b/g, 'psg'],
    [/\bbayern(\s*m[uü]nchen)?\b|\bbayern\s*munich\b/g, 'bayernmunich'],
    [/\batl(etico)?\s*madrid\b/g, 'atleticomadrid'],
    [/\breal\s*madrid\b|\br\s*madrid\b/g, 'realmadrid'],
    // inter variants must precede the bare-inter rule below
    [/\binter\s*miami\b/g, 'intermiami'],
    [/\binter\s*turku\b/g, 'interturku'],
    [/\binter(\s*milan)?\b|\binternazionale\b/g, 'intermilan'],
    [/\bac\s*milan\b/g, 'acmilan'],
    [/\bborussia\s*dortmund\b|\bbvb\b|\bdortmund\b/g, 'borussiadortmund'],
    [/\brb\s*leipzig\b/g, 'rbleipzig'],
    [/\baston\s*villa\b/g, 'astonvilla'],
    [/\bwest\s*ham(\s*united)?\b/g, 'westham'],
    [/\bcrystal\s*palace\b/g, 'crystalpalace'],
    [/\bnewcastle(\s*united)?\b/g, 'newcastle'],
    [/\bnottingham\s*forest\b|\bnott(?:s|m)\s+forest\b/g, 'nottinghamforest'],
    [/\bleicester(\s*city)?\b/g, 'leicestercity'],
    [/\bsheff(?:ield)?\s*(?:utd|united)\b/g, 'sheffieldunited'],
    [/\bbe(?:in\s*sport|\s*in)\b/g, 'beinsport'],
    [/\bal[\s\-]nassr\b/g, 'alnassr'],
    [/\bal[\s\-]hilal\b/g, 'alhilal'],
    [/\bal[\s\-]ahly\b/g, 'alahly'],
    [/\bboca\s*juniors\b|\bca\s*boca\b/g, 'bocajuniors'],
    // American Football
    [/\bkansas\s*city\s*chiefs\b|\bkc\s*chiefs\b|\bchiefs\b/g, 'kansascitychiefs'],
    [/\bseattle\s*seahawks\b|\bseahawks\b/g, 'seattleseahawks'],
    [/\bsan\s*francisco\s*49ers\b|\bniners\b|\b49ers\b/g, 'sf49ers'],
    [/\bdallas\s*cowboys\b|\bcowboys\b/g, 'dallascowboys'],
    [/\bphiladelphia\s*eagles\b|\beagles\b/g, 'philadelphiaeagles'],
    [/\bgreen\s*bay\s*packers\b|\bpackers\b/g, 'greenbaypacker'],
    [/\bcincinatti\s*bengals\b|\bbengals\b/g, 'cincinnatibengals'],
    [/\bpittsburgh\s*steelers\b|\bsteelers\b/g, 'pittsburghsteelers'],
    // Basketball
    [/\bny\s*knicks\b|\bnew\s*york\s*knicks\b|\bknicks\b/g, 'nyknicks'],
    [/\bboston\s*celtics\b|\bceltics\b/g, 'bostonceltics'],
    [/\bla\s*lakers\b|\blakers\b|\blos\s*angeles\s*lakers\b/g, 'lalakers'],
    [/\bgolden\s*state\s*warriors\b|\bwarriors\b/g, 'gswarriors'],
    [/\bchicago\s*bulls\b|\bbulls\b/g, 'chicagobulls'],
    [/\bmiami\s*heat\b|\bheat\b/g, 'miamiheat'],
    [/\bdenver\s*nuggets\b|\bnuggets\b/g, 'denvernuggets'],
    [/\bmilwaukee\s*bucks\b|\bbucks\b/g, 'milwaukeebucks'],
  ];
  let r = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [regex, rep] of aliases) r = r.replace(regex, rep);
  return r;
}

function _stripNoise(t) {
  return t
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(live|stream|streaming|free|hd|fhd|4k|hq|web|online|tv|match|fixture|round|week|day|game|league|cup|tournament|season|fc|cf|sc|cd|ca|afc|fk|sk|bk|rsc|vfb|tsv)\b/gi, ' ');
}

function _tokenize(t) {
  return t.replace(/[^a-z0-9]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w); // naive singular: newells->newell, sports->sport
}

/**
 * Determine if two team-name strings refer to the same club.
 * Single compound tokens (e.g. "manchestercity") require exact equality so
 * different compounds cannot accidentally match via substring.
 */
function _teamsSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const at = a.split(' ').filter(w => w.length > 2);
  const bt = b.split(' ').filter(w => w.length > 2);
  if (at.length === 0 || bt.length === 0) return false;
  if (at.length === 1 && bt.length === 1) return at[0] === bt[0];
  const sa = new Set(at), sb = new Set(bt);
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  const minLen = Math.min(sa.size, sb.size);
  return minLen > 0 && (common / minLen) >= 0.7;
}

/**
 * Try to split a match title into [team1, team2] using common separators.
 * Returns null if the title doesn't look like a "team1 vs team2" fixture.
 */
function _tryExtractTeams(title) {
  const clean = _compoundify(_stripNoise(title));
  const parts = clean.split(/\s(?:vs?\.?|@|[-–—])\s/i);
  if (parts.length === 2) {
    return [_tokenize(parts[0]).join(' '), _tokenize(parts[1]).join(' ')];
  }
  return null;
}

const REPLAY_SOURCE_IDS = new Set(['replayzone', 'livetv']);
const REPLAY_RETENTION_DAYS = 21;
const REPLAY_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const CARRY_FORWARD_PROVIDERS = ['dlive'];
const CARRY_FORWARD_MAX = Number(process.env.CARRY_FORWARD_MAX || 400);
const CARRY_FORWARD_RETENTION_MS = 24 * 3600 * 1000;
const MOTORSPORT_GENERIC_TOKENS = new Set(['grandprix', 'gp', 'formulaone', 'f1', 'motogp', 'nascar', 'rally', 'race', 'sunday', 'saturday', 'friday', 'practice', 'qualifying', 'sprint', 'championship', 'world', 'cup']);

/**
 * Parses a provider match date into epoch milliseconds, 0 when unusable.
 * ISO strings (ReplayZone sends "2026-09-14") go through the shared timezone
 * parser so they read as UTC regardless of the host zone; a plain Number() cast
 * would yield NaN and silently disable the 24h merge guard, merging the same
 * fixture on different days. The "0" sentinel (24/7 channels) is never a date.
 */
function _parseEventDate(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return n > 0 ? n : 0;
  const parsed = parseTimezone(String(raw).trim(), 'UTC');
  if (parsed && parsed > 0) return parsed;
  const fallback = Date.parse(String(raw));
  return Number.isNaN(fallback) ? 0 : fallback;
}

/**
 * Collapses league slugs (nba, epl, nhl...) to their parent sport so the same
 * fixture from two providers is not blocked by the category guard.
 */
function _normalizeCategory(category) {
  if (!category) return category;
  const lc = category.toLowerCase();
  if (['nbl', 'nba', 'wnba', 'euroleague', 'ncaa_basketball'].includes(lc)) return 'basketball';
  if (['nfl', 'ncaa', 'cfl', 'college'].includes(lc)) return 'american_football';
  if (['nrl', 'super_league', 'afl', 'rugby_league', 'rugby_union', 'rugby15'].includes(lc)) return 'rugby';
  if (['mls', 'epl', 'la_liga', 'bundesliga', 'serie_a', 'ligue_1', 'ucl', 'uel'].includes(lc)) return 'football';
  if (['formula_1', 'formulaone', 'motogp', 'indycar', 'nascar'].includes(lc)) return 'motorsport';
  if (['mlb', 'npb'].includes(lc)) return 'baseball';
  if (['nhl', 'khl', 'ice hockey', 'ice_hockey', 'icehockey'].includes(lc)) return 'hockey';
  if (['sports', 'sport', 'networks'].includes(lc)) return 'other';
  return lc;
}

/** True for titles naming a motorsport race weekend. */
function _isGrandPrix(tokens) {
  return tokens.has('grandprix') || tokens.has('gp') || tokens.has('formulaone') || tokens.has('motogp') || tokens.has('nascar') || tokens.has('rally');
}


// Wall budget for one provider's getMatches() during a sync. Providers swallow
// their own errors, so a dead upstream shows up as a hang, not a rejection:
// without this the whole sync waits for the slowest failing origin.
const PROVIDER_SYNC_TIMEOUT_MS = parseInt(process.env.PROVIDER_SYNC_TIMEOUT_MS, 10) || 8000;

/**
 * Resolves the provider's matches, or `[]` once the budget elapses. The
 * provider promise is left running; it only loses the race.
 */
function withSyncDeadline(provider) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[MatchAggregator] ${provider.name || 'provider'} exceeded ${PROVIDER_SYNC_TIMEOUT_MS}ms, skipping this sync.`);
      resolve([]);
    }, PROVIDER_SYNC_TIMEOUT_MS);
  });
  return Promise.race([provider.getMatches(), deadline]).finally(() => clearTimeout(timer));
}

class MatchAggregator {
  constructor({ streamFreeProvider, timStreamsProvider, sportyHunterProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamicProvider, streamedPkProvider, ppvProvider, streamCornerProvider, zliveProvider, dliveProvider, replayZoneProvider, liveTvProvider, damiTvProvider, cacheService }) {
    this.providers = [streamFreeProvider, timStreamsProvider, sportyHunterProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamicProvider, streamedPkProvider, ppvProvider, streamCornerProvider, zliveProvider, dliveProvider, replayZoneProvider, liveTvProvider, damiTvProvider]
      .filter(p => p && typeof p.getMatches === 'function');
    this.cacheService = cacheService;
  }

  /**
   * Precompute everything isSameEvent needs ONCE per match. The merge loop is
   * O(N^2) in pair comparisons; doing the regex-heavy normalization here instead
   * of inside every comparison removes ~50x of repeated work on large catalogs.
   */
  _precompute(e) {
    const title = e && e.title ? String(e.title) : '';
    const id = e && e.id != null ? String(e.id) : '';
    const normalized = _compoundify(_stripNoise(title));
    const isCalendarYear = (w) => { const n = Number(w); return n >= 2000 && n <= 2100; };
    return {
      id,
      category: e && e.category ? String(e.category) : '',
      date: _parseEventDate(e && e.date),
      teams: _tryExtractTeams(title),
      tokens: new Set(_tokenize(normalized).filter(w => !isCalendarYear(w))),
      norm: normalized.replace(/\s+/g, ' ').trim(),
      // Digits come from the normalized form so compound tokens like
      // "formulaone" leave no stray "1", and season years never block a merge.
      digits: (normalized.match(/\d+/g) || []).filter(d => !isCalendarYear(d)).sort().join(',')
    };
  }

  /**
   * Merge decision on precomputed matches. Same decision tree as before, with
   * two fixes found by A/B testing against the real catalog:
   *   - "Man United" style alias gap (same match, two catalog names)
   *   - channel-like titles (no team-vs-team parse) collapsing under a loose
   *     Jaccard rule ("Sky Sports F1" + "Sky Sports Main Event" merged;
   *     "US Open Court 13" + "Court 7" merged)
   */
  _sameEventPre(p1, p2) {
    // 1. Category mismatch guard (league slugs and parent sports compare equal)
    const c1 = _normalizeCategory(p1.category);
    const c2 = _normalizeCategory(p2.category);
    const isCollegeFootball = (p1.category === 'college' && (c2 === 'american_football' || c2 === 'football')) ||
                              (p2.category === 'college' && (c1 === 'american_football' || c1 === 'football'));
    if (c1 && c2 && c1 !== 'other' && c2 !== 'other' && c1 !== c2 && !isCollegeFootball) {
      return false;
    }
    // 2. Exact ID match
    if (p1.id && p2.id && p1.id === p2.id) return true;
    // 3. Date window guard — events more than 24h apart are definitely different
    if (p1.date && p2.date && Math.abs(p1.date - p2.date) > 86400000) return false;

    const isMoto = c1 === 'motorsport' || c2 === 'motorsport';

    // 5. Dual-team extraction — if both titles parse as "team1 vs team2", require
    //    BOTH teams to independently fuzzy-match. Motorsport has no teams.
    if (p1.teams && p2.teams && !isMoto) {
      const fwd = _teamsSimilar(p1.teams[0], p2.teams[0]) && _teamsSimilar(p1.teams[1], p2.teams[1]);
      const rev = _teamsSimilar(p1.teams[0], p2.teams[1]) && _teamsSimilar(p1.teams[1], p2.teams[0]);
      return fwd || rev;
    }

    // 6. Channel-identity path — at least one title is not a team-vs-team fixture
    //    (24/7 channels, court/track numbered events, "Team Live" listings).
    if (p1.tokens.size === 0 || p2.tokens.size === 0) return false;

    // Digit signatures must agree: "beIN 1" vs "beIN 2", "Court 13" vs "Court 7"
    // are different channels/events even when the words are identical. Grand
    // Prix titles are exempt: round numbers vary by provider.
    const bothGrandPrix = isMoto && _isGrandPrix(p1.tokens) && _isGrandPrix(p2.tokens);
    if (!bothGrandPrix && p1.digits !== p2.digits) return false;

    // 6a. One fixture + one channel-like listing: the channel-like tokens must be
    //     a subset of the fixture tokens ("Real Madrid live" ⊂ "Real Madrid vs
    //     Barcelona"). This keeps single-team listings merging with the fixture.
    if ((p1.teams || p2.teams) && !isMoto) {
      const channel = p1.teams ? p2 : p1;
      const fixture = p1.teams ? p1 : p2;
      for (const w of channel.tokens) if (!fixture.tokens.has(w)) return false;
      return true;
    }

    // 6b. Both channel-like: strict identity only. Distinct channels with shared
    //     branding must never merge.
    if (p1.norm === p2.norm) return true;

    // 6c. Motorsport: two Grand Prix titles sharing a venue-specific token merge
    //     ("Bahrain Grand Prix - Race" vs "Formula 1 Bahrain Grand Prix").
    if (bothGrandPrix) {
      const specificShared = [...p1.tokens].filter(x => p2.tokens.has(x) && !MOTORSPORT_GENERIC_TOKENS.has(x) && isNaN(x));
      if (specificShared.length >= 1) return true;
    }

    // 6d. A title whose tokens (min 2) are all contained in the other refines it
    //     ("Azerbaijan Grand Prix" within "Formula 1 Azerbaijan Grand Prix").
    const smaller = p1.tokens.size <= p2.tokens.size ? p1 : p2;
    const larger = p1.tokens.size <= p2.tokens.size ? p2 : p1;
    if (smaller.tokens.size >= 2 && [...smaller.tokens].every(w => larger.tokens.has(w))) return true;

    let common = 0;
    for (const w of p1.tokens) if (p2.tokens.has(w)) common++;
    const union = p1.tokens.size + p2.tokens.size - common;
    if (union > 0 && common / union >= 0.75) return true;
    return false;
  }

  /** Public API preserved: decision on raw matches (computes pre on the fly). */
  isSameEvent(e1, e2) {
    return this._sameEventPre(this._precompute(e1), this._precompute(e2));
  }

  async syncMatches() {
    console.log('[MatchAggregator] Fetching from all providers...');
    const finalMatches = [];
    const finalPres = []; // precomputed identity for each accepted match

    const processProviderMatches = (providerMatches) => {
      if (!providerMatches || !Array.isArray(providerMatches)) return;
      providerMatches.forEach(match => {
        if (!match.id || !match.title) return;

        const pre = this._precompute(match);
        let idx = -1;
        for (let i = 0; i < finalMatches.length; i++) {
          if (this._sameEventPre(finalPres[i], pre)) { idx = i; break; }
        }

        if (idx === -1) {
          finalMatches.push(match);
          finalPres.push(pre);
          return;
        }

        const existing = finalMatches[idx];
        if (!existing.aliasIds) existing.aliasIds = [];
        if (!existing.aliasIds.includes(match.id)) existing.aliasIds.push(match.id);
        if (Array.isArray(match.aliasIds)) {
          for (const aid of match.aliasIds) {
            if (!existing.aliasIds.includes(aid)) existing.aliasIds.push(aid);
          }
        }
        if (match.sources && Array.isArray(match.sources)) {
          if (!Array.isArray(existing.sources)) existing.sources = [];
          match.sources.forEach(src => {
            if (!existing.sources.find(s => s.id === src.id && s.source === src.source)) {
              existing.sources.push(src);
            }
          });
        }
        if (match.popular === '1') existing.popular = '1';
        if (!existing.status && match.status) existing.status = match.status;
        if (!existing.poster && match.poster) existing.poster = match.poster;
        if (!existing.logo && match.logo) existing.logo = match.logo;
        if (!existing.thumbnail_url && match.thumbnail_url) existing.thumbnail_url = match.thumbnail_url;
        if (!existing.background && match.background) existing.background = match.background;
        if (!existing.score && match.score) existing.score = match.score;
        if (!existing.league && match.league) existing.league = match.league;
        if (!existing.team1 && match.team1) existing.team1 = match.team1;
        else if (existing.team1 && !existing.team1.logo && match.team1 && match.team1.logo) existing.team1.logo = match.team1.logo;
        if (!existing.team2 && match.team2) existing.team2 = match.team2;
        else if (existing.team2 && !existing.team2.logo && match.team2 && match.team2.logo) existing.team2.logo = match.team2.logo;

        if (existing.category !== 'college' && match.category === 'college') {
          existing.category = 'college';
          finalPres[idx].category = 'college';
        }

        // Adopt the incoming kickoff when the existing one is missing; the
        // dedicated event provider's precise epoch beats a coarse date.
        const existingDateMs = _parseEventDate(existing.date);
        const incomingDateMs = _parseEventDate(match.date);
        if (incomingDateMs > 0 && (existingDateMs <= 0 || (match.sources && match.sources.some(s => s && s.source === 'streamedpk')))) {
          existing.date = match.date;
          finalPres[idx].date = incomingDateMs;
        }

        // Canonical naming: prefer a team-vs-team fixture title over a
        // channel-like listing title, so the merged event keeps the most
        // informative name regardless of which provider arrived first.
        if (!existing._titleIsFixture && pre.teams) {
          existing.title = match.title;
          existing._titleIsFixture = true;
          finalPres[idx] = pre;
        }
      });
    };

    // Providers swallow their own errors and return []. A non-empty result is the
    // only reliable success signal; it keeps a total upstream outage from wiping the cache.
    let anyProviderSucceeded = false;

    // Replay archives are static past fixtures; re-scraping 21 days of them on
    // every sync burns CPU and bandwidth, so reuse cached replays for 12 hours.
    let previousMatches = [];
    try { previousMatches = this.cacheService.getMatches() || []; } catch (_) { previousMatches = []; }
    const previousReplays = previousMatches.filter(m => m && Array.isArray(m.sources) && m.sources.some(s => s && REPLAY_SOURCE_IDS.has(s.source)));

    if (this.lastReplaySync === undefined && this.cacheService.lastFetchTime) {
      this.lastReplaySync = this.cacheService.lastFetchTime;
    }
    const replayFresh = previousReplays.length > 0 && !!this.lastReplaySync && (Date.now() - this.lastReplaySync < REPLAY_SYNC_INTERVAL_MS);

    if (replayFresh) {
      processProviderMatches(previousReplays);
      anyProviderSucceeded = true;
    } else {
      this.lastReplaySync = Date.now();
    }

    const providersToQuery = this.providers.filter(p => !(replayFresh && REPLAY_SOURCE_IDS.has(p.sourceName)));

    if (process.env.LOW_MEMORY_MODE === 'true') {
      // Memory-safe sequential fetching (Alwaysdata)
      for (const p of providersToQuery) {
        try {
          const providerMatches = await withSyncDeadline(p);
          if (Array.isArray(providerMatches) && providerMatches.length > 0) anyProviderSucceeded = true;
          processProviderMatches(providerMatches);
        } catch (err) {
          console.error(`[MatchAggregator] Provider fetch failed:`, err.message);
        }
      }
    } else {
      // Fast parallel fetching (Render / Local)
      const results = await Promise.allSettled(providersToQuery.map(p => withSyncDeadline(p)));
      results.forEach((promiseResult, index) => {
        if (promiseResult.status === 'fulfilled') {
          if (Array.isArray(promiseResult.value) && promiseResult.value.length > 0) anyProviderSucceeded = true;
          processProviderMatches(promiseResult.value);
        } else {
          console.error(`[MatchAggregator] Provider ${providersToQuery[index].name || index} failed:`, promiseResult.reason);
        }
      });
    }

    const now = Date.now();
    // Smart Trending Engine: Boost popular matches globally, but only if they are actually live or starting soon
    const TRENDING_KEYWORDS = ['bein', 'real madrid', 'barcelona', 'manchester', 'arsenal', 'liverpool', 'chelsea', 'bayern', 'psg', 'lakers', 'warriors', 'mcgregor', 'super bowl', 'champions league', 'el clasico', 'f1', 'formula 1', 'grand prix'];

    finalMatches.forEach(match => {
      const titleLower = match.title.toLowerCase();

      const kickoff = _parseEventDate(match.date);
      // Allow matches to be flagged as 'Live' from 3 hours before kickoff up to 14 hours after kickoff
      const isWithinTimeWindow = kickoff === 0 || (now >= kickoff - (3 * 3600 * 1000) && now <= kickoff + (14 * 3600 * 1000));

      if (TRENDING_KEYWORDS.some(kw => titleLower.includes(kw))) {
        if (isWithinTimeWindow) {
          match.popular = '1';
        }
      }

      // GLOBAL FIX: Some providers (like Streamed.pk) flag future events as popular/live early.
      // We must override and strip the popular flag if the event is too far in the future.
      if (match.popular === '1' && kickoff > 0 && !isWithinTimeWindow) {
        match.popular = '0';
      }
    });

    const activeMatches = finalMatches.filter(match => {
      const sources = Array.isArray(match.sources) ? match.sources : [];
      const kickoff = _parseEventDate(match.date);
      if (kickoff === 0) return true; // Keep if we don't know the time

      const isReplay = sources.some(s => s && REPLAY_SOURCE_IDS.has(s.source));
      const isTimStreams = sources.some(s => s && s.source === 'timstreams');
      let windowMs = 24 * 3600 * 1000;
      if (isReplay) windowMs = REPLAY_RETENTION_DAYS * 24 * 3600 * 1000;
      else if (isTimStreams) windowMs = 48 * 3600 * 1000;
      return now <= kickoff + windowMs;
    });

    this._carryForward(activeMatches, finalMatches, previousMatches);

    console.log(`[MatchAggregator] Sync complete. Merged ${activeMatches.length} active events.`);
    if (anyProviderSucceeded) {
      for (const m of activeMatches) {
        if (!m || (m.team1 && m.team2)) continue;
        const derived = extractTeamsFromTitle(m.title);
        if (!derived) continue;
        if (!m.team1) m.team1 = { name: derived[0] };
        if (!m.team2) m.team2 = { name: derived[1] };
      }
      this.cacheService.setMatches(activeMatches);
      return activeMatches;
    }
    return null;
  }

  /**
   * Re-adds a provider's still-valid rows from the previous cache when it
   * contributed nothing (or only channels, with a broken schedule) this sync, so a
   * single fetch blip does not wipe its fixtures for a whole sync interval.
   *
   * Bounded on purpose: only a provider that came back empty or flagged
   * `lastScheduleOk === false`, only rows inside the normal retention window, and
   * at most CARRY_FORWARD_MAX rows.
   */
  _carryForward(activeMatches, finalMatches, previousMatches) {
    const now = Date.now();
    const presentIds = new Set(activeMatches.map(m => m && m.id).filter(Boolean));

    for (const provider of CARRY_FORWARD_PROVIDERS) {
      const answered = finalMatches.some(m => Array.isArray(m.sources) && m.sources.some(s => s && s.source === provider));
      const scheduleBroke = this.providers.some(p => p && p.sourceName === provider && p.lastScheduleOk === false);
      if (answered && !scheduleBroke) continue;

      const carried = previousMatches.filter(m => {
        if (!m || !m.id || presentIds.has(m.id)) return false;
        if (!Array.isArray(m.sources) || !m.sources.some(s => s && s.source === provider)) return false;
        const kickoff = _parseEventDate(m.date);
        if (!kickoff) return true; // dateless rows are 24/7 channels
        return now <= kickoff + CARRY_FORWARD_RETENTION_MS;
      }).slice(0, CARRY_FORWARD_MAX);

      if (carried.length > 0) {
        activeMatches.push(...carried);
        console.warn(`[MatchAggregator] ${provider} returned nothing usable this sync; carried forward ${carried.length} previous entries.`);
      }
    }
  }
}

module.exports = MatchAggregator;
module.exports._internal = { _compoundify, _stripNoise, _tokenize, _teamsSimilar, _tryExtractTeams };
