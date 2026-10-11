const container = require('./container');
const { getChannelLogo } = require('./services/ChannelLogoService');
const streams = require('./streams');
const { BASE_URL } = require('./config');
const imageService = require('./services/ImageService');
const { parseTimezone } = require('./timezone');
const { getMatchTier } = require('./services/MainstreamRankingService');
const { extractTeamsFromTitle } = require('./services/TeamNameExtractor');
const { filterReplayMatches, isReplayFilterDisabled } = require('./services/ReplayFilterService');

// Sources whose matches qualify as replays.
const REPLAY_SOURCES = new Set(['replayzone', 'livetv']);

const REPLAY_SPORT_IDS = ['football', 'motorsport', 'baseball', 'rugby', 'basketball', 'tennis', 'hockey', 'american_football'];

const GENRE_TO_CATEGORY = {
  'football': 'football',
  'soccer': 'football',
  'cricket': 'cricket',
  'basketball': 'basketball',
  'motorsport': 'motorsport',
  'f1 & motor': 'motorsport',
  'formula 1': 'motorsport',
  'tennis': 'tennis',
  'baseball': 'baseball',
  'hockey': 'hockey',
  'rugby': 'rugby',
  'american football': 'american_football',
  'mma': 'mma',
  'golf': 'golf',
  'darts': 'darts',
  'college': 'college',
  'other': 'other'
};

/**
 * Parses a stored kickoff into epoch milliseconds, 0 when there is none.
 * "0"/"00" are the "no kickoff" sentinel for 24/7 channels and must never reach
 * a date parser, which would read them as a year in the host zone.
 */
function getKickoff(d) {
  if (!d) return 0;
  const n = Number(d);
  if (Number.isFinite(n) && n > 0) return n;
  const s = String(d).trim();
  if (!s || /^0+$/.test(s)) return 0;
  const parsed = parseTimezone(s, 'UTC');
  return parsed && parsed > 0 ? parsed : 0;
}

// How long an event can plausibly still be running after kickoff. Providers
// cache status at fetch time, so elapsed time against these windows is what
// separates a live fixture from a finished one.
const SPORT_MAX_DURATION_MS = {
  cricket: 8 * 60 * 60 * 1000,
  mma: 6 * 60 * 60 * 1000,
  fighting: 6 * 60 * 60 * 1000,
  boxing: 5 * 60 * 60 * 1000,
  motorsport: 4 * 60 * 60 * 1000,
  american_football: 4 * 60 * 60 * 1000,
  baseball: 3.5 * 60 * 60 * 1000,
  basketball: 3 * 60 * 60 * 1000,
  tennis: 4 * 60 * 60 * 1000,
  golf: 6 * 60 * 60 * 1000,
  football: 2.5 * 60 * 60 * 1000,
  rugby: 2.5 * 60 * 60 * 1000,
  hockey: 3 * 60 * 60 * 1000,
  darts: 4 * 60 * 60 * 1000,
  college: 4 * 60 * 60 * 1000
};
const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000;

function getEventDurationMs(category) {
  return SPORT_MAX_DURATION_MS[category] || DEFAULT_EVENT_DURATION_MS;
}

/**
 * Accurately determines if an event is currently live right now.
 * 24/7 networks are always live.
 * Fixtures with a kickoff time are live starting 15 minutes before kickoff
 * up to the sport-specific max game duration.
 */
function isMatchLive(match) {
  if (!match) return false;
  if (match.category === 'networks' || !match.date) return true;

  // 1. Explicit finished / postponed / cancelled statuses are never live
  if (match.status === 'finished' || match.status === 'ended' || match.status === 'postponed' || match.status === 'cancelled') {
    return false;
  }

  // 2. Explicit live status from provider
  if (match.status === 'live' || match.status === 'in' || match.status === 'in_progress') {
    return true;
  }

  // 3. Explicit upcoming / pre-match status from provider
  if (match.status === 'upcoming' || match.status === 'pre') {
    return false;
  }

  // 4. Time-based evaluation when status is not explicitly set
  const now = Date.now();
  const kickoff = getKickoff(match.date);

  if (kickoff > 0) {
    return now >= (kickoff - 15 * 60 * 1000) && now <= (kickoff + getEventDurationMs(match.category));
  }

  return false;
}

/**
 * Determines whether a match is a replay (a past event whose coverage is still
 * available) rather than a live or upcoming fixture. 24/7 networks are never
 * replays, and the match must carry a source from a replay-capable provider.
 */
function isReplayMatch(match) {
  if (!match) return false;
  if (match.category === 'networks') return false;
  if (match.status === 'postponed' || match.status === 'cancelled') return false;

  if (match.sources && match.sources.length > 0) {
    if (!match.sources.some(s => s && REPLAY_SOURCES.has(s.source))) return false;
  }

  const kickoff = match.date ? getKickoff(match.date) : 0;

  // Without a usable kickoff time, only an explicit terminal status qualifies.
  if (kickoff === 0) {
    return match.status === 'finished' || match.status === 'ended';
  }

  // An explicit terminal status is authoritative.
  if (match.status === 'finished' || match.status === 'ended') {
    return kickoff <= Date.now();
  }

  return Date.now() > kickoff + getEventDurationMs(match.category);
}

/**
 * Lowercases and strips diacritics so "Nautico" matches "Náutico".
 * Applied to both the query and the title.
 */
function foldText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Normalizes the "Favorite teams" config field into folded phrases with their
 * tokens. A multi-word favourite only matches when every token is found, so
 * "man united" cannot be satisfied by "Manchester City".
 */
function parseFavoriteTeams(conf) {
  const raw = conf && conf.teams;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',')
    .map(t => foldText(t.trim()))
    .filter(Boolean)
    .map(phrase => ({ phrase, tokens: phrase.split(/\s+/).filter(Boolean) }));
}

/**
 * True when the match title mentions any favourite team. Tokens match on word
 * boundaries with prefix semantics, so "atletico" finds "Atlético Goianiense"
 * while "real" does not match "Montreal Canadiens".
 */
function isFavoriteMatch(match, favorites) {
  if (!favorites || favorites.length === 0) return false;
  const title = foldText(match && match.title);
  if (!title) return false;

  const titleTokens = title.split(/[^a-z0-9]+/).filter(Boolean);
  if (titleTokens.length === 0) return false;

  return favorites.some(fav =>
    fav.tokens.length > 0 &&
    fav.tokens.every(ft => titleTokens.some(tt => tt.startsWith(ft)))
  );
}

/**
 * Ordering for the Live Now / Upcoming / per-sport / replay catalogs. Key order,
 * highest priority first:
 *   1. live before not-live
 *   2. real fixtures before 24/7 channels
 *   3. mainstream before local / lower-division (getMatchTier)
 *   4. popular before non-popular
 *   5. date: upcoming nearest kickoff first; live and replays newest first
 * Favourite teams deliberately do not reorder catalogs; they only drive the
 * Your Teams catalog.
 */
function compareCatalogMatches(a, b, isReplayMode = false) {
  const aIsLive = isMatchLive(a) ? 1 : 0;
  const bIsLive = isMatchLive(b) ? 1 : 0;
  if (aIsLive !== bIsLive) return bIsLive - aIsLive;

  // A 24/7 network is always live, so it would otherwise flood the top of the
  // list. Real fixtures carry a kickoff, team names, or a "vs"/"@" title.
  const isRealFixture = (m) => (m.category !== 'networks' && (!!m.date || !!m.team1 || !!m.team2 || /( vs | @ )/.test(m.title || ''))) ? 1 : 0;
  const aFix = isRealFixture(a);
  const bFix = isRealFixture(b);
  if (aFix !== bFix) return bFix - aFix;

  // `popular` cannot separate a top-flight tie from a second-division one
  // (Streamed.pk flags most of its events popular), so rank by tier first.
  const aTier = getMatchTier(a);
  const bTier = getMatchTier(b);
  if (aTier !== bTier) return aTier - bTier;

  const aPop = a.popular === '1' ? 1 : 0;
  const bPop = b.popular === '1' ? 1 : 0;
  if (aPop !== bPop) return bPop - aPop;

  const dateA = a.date ? getKickoff(a.date) : 0;
  const dateB = b.date ? getKickoff(b.date) : 0;

  if (dateA > 0 && dateB > 0) {
    return (isReplayMode || aIsLive) ? dateB - dateA : dateA - dateB;
  }
  if (dateA > 0) return -1;
  if (dateB > 0) return 1;
  return 0;
}

function normalizeImageUrl(url, defaultHost = 'https://streamfree.top') {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (u.startsWith('/')) return `${defaultHost}${u}`;
  return `${defaultHost}/${u}`;
}

// Building an Intl.DateTimeFormat costs more than formatting with one, and a
// catalog renders hundreds of kickoff times that share a handful of timezones.
const timeFormatters = new Map();

/** 24-hour kickoff formatter for `timeZone`, falling back to UTC when invalid. */
function kickoffFormatter(timeZone) {
  const key = timeZone || '';
  let formatter = timeFormatters.get(key);
  if (formatter) return formatter;
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (timeZone) options.timeZone = timeZone;
  try {
    formatter = new Intl.DateTimeFormat('en-US', options);
  } catch (e) {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
  timeFormatters.set(key, formatter);
  return formatter;
}

const dateFormatters = new Map();

/** "Sep 14, 2026" formatter for `timeZone`, falling back to UTC when invalid. */
function dateFormatter(timeZone) {
  const key = timeZone || '';
  let formatter = dateFormatters.get(key);
  if (formatter) return formatter;
  const options = { month: 'short', day: 'numeric', year: 'numeric', timeZone: timeZone || 'UTC' };
  try {
    formatter = new Intl.DateTimeFormat('en-US', options);
  } catch (e) {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
  dateFormatters.set(key, formatter);
  return formatter;
}

/** Strips emoji and flag glyphs some providers embed in team names. */
function cleanTeamName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\u{1F3F4}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapMatchToMetaPreview(match, config = {}) {
  const isLive = isMatchLive(match);
  const isReplay = !isLive && isReplayMatch(match);
  const titleStr = match.title || (isLive ? 'Live Match' : 'Upcoming Match');
  
  // Dynamic Sport-Specific Posters
  const categoryColors = {
    football: '10b981', // green
    basketball: 'f97316', // orange
    motorsport: 'ef4444', // red
    cricket: '0ea5e9', // light blue
    tennis: 'a3e635', // lime
    rugby: '8b5cf6', // purple
    american_football: '0369a1', // dark blue
    baseball: 'f43f5e', // rose
    hockey: '06b6d4', // cyan
    golf: '22c55e', // emerald
    darts: 'eab308', // yellow
    mma: 'dc2626', // crimson red
    networks: '64748b', // slate
    college: 'd946ef' // fuchsia
  };
  const color = categoryColors[match.category] || '333333';
  
  // Channel logos come from the unified ChannelLogoService (tv-logos CDN + Wikimedia).

  // Competitor names, filled from the title when the provider omitted them.
  const derivedTeams = extractTeamsFromTitle(match.title);
  const team1Name = cleanTeamName((match.team1 && match.team1.name) || (derivedTeams && derivedTeams[0]));
  const team2Name = cleanTeamName((match.team2 && match.team2.name) || (derivedTeams && derivedTeams[1]));

  // Generate a clean, readable fallback poster using the match title
  let posterText = titleStr;
  if (team1Name && team2Name) {
      posterText = `${team1Name}\nvs\n${team2Name}`;
  } else if (isReplay) {
      // Replay titles are session titles ("A @ B - League - Full Game Replay -
      // September 14, 2026"), so lead the card with the part before the first dash.
      posterText = posterText.replace(/ [-\u2013\u2014] /, '\n-\n');
  } else {
      posterText = posterText.replace(/ vs /i, '\nvs\n').replace(/ - /i, '\n-\n');
  }

  if (posterText.length > 50) {
      posterText = match.category.toUpperCase();
  }

  // Self-hosted fallback poster (replaces the external placehold.co dependency)
  const fallbackPoster = imageService.placeholderUrl(BASE_URL, posterText, color);

  // Self-hosted image proxy: serves the upstream image from cache and falls
  // back to a generated placeholder when the source is dead, so the client
  // never sees a broken image.
  const buildImg = (sourceUrl, fbText, c) =>
    imageService.proxyUrl(BASE_URL, sourceUrl, { text: fbText, color: c });

  let poster = fallbackPoster;
  const channelLogo = getChannelLogo(match.title);
  const team1Logo = match.team1 && match.team1.logo ? normalizeImageUrl(match.team1.logo) : null;
  const matchPoster = match.poster ? normalizeImageUrl(match.poster) : null;
  const matchThumb = match.thumbnail_url ? normalizeImageUrl(match.thumbnail_url) : null;
  const matchLogo = match.logo ? normalizeImageUrl(match.logo) : null;

  let logo = matchLogo || team1Logo || channelLogo || null;

  if (matchPoster) {
    poster = buildImg(matchPoster, posterText, color) || fallbackPoster;
  } else if (channelLogo) {
    poster = buildImg(channelLogo, titleStr, '161616') || fallbackPoster;
    logo = channelLogo;
  } else if (matchThumb) {
    const isLogo = match.category === 'networks' || matchThumb.toLowerCase().includes('logo') || matchThumb.toLowerCase().includes('icon');
    poster = buildImg(matchThumb, posterText, color) || fallbackPoster;
    if (isLogo && !logo) {
      logo = matchThumb;
    }
  } else if (team1Logo) {
    poster = buildImg(team1Logo, posterText, color) || fallbackPoster;
    if (!logo) logo = team1Logo;
  }

  if (logo) {
    logo = buildImg(logo, titleStr, '161616') || logo;
  }
  
  const matchBackground = match.background ? normalizeImageUrl(match.background) : null;
  let background = matchBackground ? (buildImg(matchBackground, posterText, color) || poster) : poster;

  let timeString = match.category === 'networks' ? '24/7 Stream' : 'Live Now';
  let dateString = '';
  let relativeTimeStr = '';
  let releasedIso = null;
  const timeZone = config && config.timezone ? config.timezone : null;

  const kickoff = match.date ? getKickoff(match.date) : 0;
  if (kickoff > 0) {
     const dateObj = new Date(kickoff);
     releasedIso = dateObj.toISOString();

     timeString = kickoffFormatter(timeZone).format(dateObj) + (timeZone ? ` (${timeZone})` : '');
     dateString = dateFormatter(timeZone).format(dateObj);

     const diff = dateObj.getTime() - Date.now();
     if (diff > 0 && !isLive) {
       const hours = Math.floor(diff / (1000 * 60 * 60));
       const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
       if (hours > 24) {
         relativeTimeStr = ` (in ${Math.floor(hours / 24)} days)`;
       } else if (hours > 0) {
         relativeTimeStr = ` (in ${hours}h ${minutes}m)`;
       } else {
         relativeTimeStr = ` (in ${minutes} mins)`;
       }
     }
  }

  const is247 = !isReplay && (match.category === 'networks' || !match.date);
  const prefix = isReplay ? '⏪ ' : (isLive ? (is247 ? '📺 ' : '🔴 LIVE: ') : '⏱️ ');
  const cast = [];
  if (team1Name) cast.push(team1Name);
  if (team2Name) cast.push(team2Name);

  const replayReleaseInfo = dateString || 'Replay';
  const scoreSuffix = match.score ? ` (${match.score})` : '';

  const leagueStr = match.league ? `🏆 League: ${match.league}\n` : '';
  let statusStr;
  if (is247) statusStr = '24/7 Live Network';
  else if (isLive) statusStr = `🔴 LIVE NOW${scoreSuffix}`;
  else if (isReplay) statusStr = `⏪ Replay (${replayReleaseInfo})`;
  else statusStr = `Kickoff at ${timeString}${relativeTimeStr}`;
  const desc = `${leagueStr}📅 Category: ${match.category.toUpperCase()}\n⏰ Status: ${statusStr}`;

  let releaseInfo = timeString;
  if (isReplay) releaseInfo = replayReleaseInfo;
  else if (isLive) releaseInfo = is247 ? '24/7' : 'LIVE';

  const metaPreview = {
    id: `nuvio_sport_${match.id}`,
    type: 'tv',
    name: `${prefix}${titleStr}`,
    genres: [match.category.toUpperCase()],
    poster: poster,
    posterShape: 'landscape',
    background: background,
    logo: logo,
    releaseInfo,
    description: desc,
    cast: cast,
    behaviorHints: {
      defaultVideoId: `nuvio_sport_${match.id}`
    }
  };

  if (releasedIso) {
    metaPreview.released = releasedIso;
  }

  return metaPreview;
}

// Stremio's catalog page size. Clients request further pages with `skip`.
const PAGE_SIZE = 100;

// Clients may hold a catalog page this long. The list itself is refreshed on a
// background window (CronService.REVALIDATE_AFTER_MS), so a minute of staleness
// never exceeds what the server would have served anyway.
const CATALOG_MAX_AGE = 60;

// Replays are static archive content, so clients may hold them far longer.
const REPLAY_MAX_AGE = 1800;
const REPLAY_STALE_REVALIDATE = 3600;

const TOP_LEVEL_CATEGORIES = ['football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball', 'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts', 'networks', 'college'];

/** True when the match belongs on the given sport catalog (including topical 24/7 networks). */
function matchesSportCatalog(m, sport) {
  if (m.category === sport) return true;
  if (m.category !== 'networks') return false;
  const titleLower = (m.title || '').toLowerCase();
  switch (sport) {
    case 'cricket': return titleLower.includes('cricket');
    case 'tennis': return titleLower.includes('tennis');
    case 'motorsport': return titleLower.includes('f1') || titleLower.includes('racing') || titleLower.includes('moto') || titleLower.includes('motorsport');
    case 'basketball': return titleLower.includes('nba') || titleLower.includes('basketball');
    case 'football': return titleLower.includes('football') || titleLower.includes('soccer') || titleLower.includes('golazo') || titleLower.includes('laliga') || titleLower.includes('premier league') || titleLower.includes('bein sports');
    case 'rugby':
      if (/premier league|champions league|europa league|la liga|serie a|bundesliga/.test(titleLower)) return false;
      return /rugby|nrl|super league|six nations|fox league/.test(titleLower);
    case 'american_football': return titleLower.includes('nfl') || titleLower.includes('american football');
    case 'baseball': return titleLower.includes('mlb') || titleLower.includes('baseball');
    case 'hockey': return titleLower.includes('nhl') || titleLower.includes('hockey');
    case 'golf': return titleLower.includes('golf') || titleLower.includes('pga');
    default: return false;
  }
}

/** Narrows matches to one sport from a genre label such as "American Football" or "Other". */
function filterByGenre(matches, genre) {
  if (typeof genre !== 'string' || !genre.trim()) return matches;
  const wanted = GENRE_TO_CATEGORY[genre.trim().toLowerCase()];
  if (!wanted) return matches;
  if (wanted === 'other') return matches.filter(m => !TOP_LEVEL_CATEGORIES.includes(m.category));
  return matches.filter(m => m.category === wanted);
}

/** Keeps only the sports named in `config.sports`; 24/7 networks are never sport-bound. */
function filterBySports(matches, conf) {
  if (typeof conf.sports !== 'string' || conf.sports === 'all') return matches;
  const allowedSports = conf.sports.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return matches.filter(m => m.category === 'networks' || allowedSports.includes(m.category));
}

/** True when the match is a replay served by a replay-capable provider. */
function isListedReplay(m) {
  return isReplayMatch(m) &&
    Array.isArray(m.sources) &&
    m.sources.some(s => s && REPLAY_SOURCES.has(s.source)) &&
    !m.sources.some(s => s && s.source === 'timstreams');
}

/** True when a finished or over-running fixture should not appear as live or upcoming. */
function isExpiredFixture(m) {
  if (m.status === 'finished' || m.status === 'ended') return true;
  const kickoff = m.date ? getKickoff(m.date) : 0;
  return kickoff > 0 && !isMatchLive(m) && Date.now() > kickoff + getEventDurationMs(m.category);
}

/** Slices one page and renders it, searching rendered metas when a query is given. */
function paginateMetas(matches, extra, conf) {
  const skip = Math.max(0, parseInt(extra && extra.skip, 10) || 0);
  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    return matches
      .map(m => mapMatchToMetaPreview(m, conf))
      .filter(m =>
        m.name.toLowerCase().includes(q) ||
        (m.description && m.description.toLowerCase().includes(q)) ||
        (m.cast && m.cast.some(c => c.toLowerCase().includes(q)))
      )
      .slice(skip, skip + PAGE_SIZE);
  }
  return matches.slice(skip, skip + PAGE_SIZE).map(m => mapMatchToMetaPreview(m, conf));
}

/** UTC calendar day (YYYY-MM-DD) of a kickoff, '' when the match has none. */
function utcDay(match) {
  const ko = match.date ? getKickoff(match.date) : 0;
  return ko > 0 ? new Date(ko).toISOString().slice(0, 10) : '';
}

const REPLAY_LEAGUE_FILTERS = {
  premier_league: { league: /premier/i, title: /premier\s*league/i },
  epl: { league: /premier/i, title: /premier\s*league/i },
  ucl: { league: /champions|europa|conference|uefa/i, title: /champions\s*league|europa\s*league/i },
  champions_league: { league: /champions|europa|conference|uefa/i, title: /champions\s*league|europa\s*league/i },
  european: { league: /la\s*liga|serie\s*a|bundesliga|ligue\s*1/i, title: null },
  f1: { league: /formula\s*1|f1/i, title: /formula\s*1|\bf1\b/i },
  nba: { league: /nba/i, title: /\bnba\b/i },
  mlb: { league: /mlb/i, title: /\bmlb\b/i },
  nfl: { league: /nfl/i, title: /\bnfl\b/i },
  nhl: { league: /nhl/i, title: /\bnhl\b/i },
  atp: { league: /atp/i, title: /\batp\b/i },
  wta: { league: /wta/i, title: /\bwta\b/i }
};

/**
 * Applies a replay sub-filter (`today`, `yesterday`, `this_week`, `older`,
 * `recent`, `date_YYYY-MM-DD`, or a competition key) to replay matches.
 */
function applyReplaySubFilter(matches, filterType) {
  const now = Date.now();
  const dayMs = 86400000;
  const kickoffOf = (m) => (m.date ? getKickoff(m.date) : 0);

  const dateMatch = filterType.match(/(?:date_)?(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return matches.filter(m => utcDay(m) === dateMatch[1]);
  if (filterType === 'today') {
    const today = new Date(now).toISOString().slice(0, 10);
    return matches.filter(m => utcDay(m) === today);
  }
  if (filterType === 'yesterday') {
    const yesterday = new Date(now - dayMs).toISOString().slice(0, 10);
    return matches.filter(m => utcDay(m) === yesterday);
  }
  if (filterType === 'this_week') {
    return matches.filter(m => { const ko = kickoffOf(m); return ko <= now - 2 * dayMs && ko >= now - 7 * dayMs; });
  }
  if (filterType === 'older') return matches.filter(m => kickoffOf(m) < now - 7 * dayMs);
  if (filterType === 'recent') {
    const recent = matches.filter(m => kickoffOf(m) >= now - 14 * dayMs);
    return recent.length >= 10 ? recent : matches.slice(0, 40);
  }
  const rule = REPLAY_LEAGUE_FILTERS[filterType];
  if (rule) {
    return matches.filter(m => (m.league && rule.league.test(m.league)) || (rule.title && rule.title.test(m.title)));
  }
  return matches;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Serves `nuvio_sports_replays_<sport>[_<filter>]` rows: replay fixtures of one
 * sport, newest first. Returns nothing when the user disabled replays.
 */
async function handleReplayCatalog(id, extra, conf) {
  if (isReplayFilterDisabled(conf)) return { metas: [] };

  const sub = id.replace('nuvio_sports_replays_', '');
  const targetSport = REPLAY_SPORT_IDS.find(s => sub === s || sub.startsWith(`${s}_`)) || 'other';
  const filterType = sub.replace(targetSport, '').replace(/^_/, '');

  const cacheService = container.resolve('cacheService');
  let matches = (cacheService.getMatches() || []).filter(m => {
    if (!m || !isListedReplay(m)) return false;
    return targetSport === 'other' ? !REPLAY_SPORT_IDS.includes(m.category) : m.category === targetSport;
  });

  matches = filterReplayMatches(matches, conf);
  matches = applyReplaySubFilter(matches, filterType);
  matches = [...matches].sort((a, b) => compareCatalogMatches(a, b, true));

  const metas = paginateMetas(matches, extra, conf);
  return { metas, cacheMaxAge: REPLAY_MAX_AGE, staleRevalidate: REPLAY_STALE_REVALIDATE };
}

async function handleCatalog(type, id, extra, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sports_')) {
    return { metas: [] };
  }

  // Fire-and-forget stale-while-revalidate: return the cached list now and let
  // CronService refresh it in the background once it passes the revalidate window.
  container.resolve('cronService').ensureFresh();

  const conf = config || (extra && extra.config) || {};

  const categoryMatch = id.replace('nuvio_sports_', '');

  if (categoryMatch.startsWith('replays_')) {
    return handleReplayCatalog(id, extra, conf);
  }

  const isReplayMode = categoryMatch === 'replays' || (extra && extra.genre === 'Replays');
  if (isReplayMode && isReplayFilterDisabled(conf)) {
    return { metas: [] };
  }

  // Use CacheService instead of hitting APIs on demand
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();

  let filteredMatches = matches;

  if (categoryMatch === 'live') {
    if (!isReplayMode) filteredMatches = matches.filter(m => isMatchLive(m));
  } else if (categoryMatch === 'upcoming') {
    if (!isReplayMode) {
      const now = Date.now();
      filteredMatches = matches.filter(m => !isMatchLive(m) && getKickoff(m.date) > now);
    }
  } else if (categoryMatch === 'teams') {
    const favoriteTeams = parseFavoriteTeams(conf);
    filteredMatches = favoriteTeams.length ? matches.filter(m => isFavoriteMatch(m, favoriteTeams)) : [];
  } else if (categoryMatch === 'other') {
    filteredMatches = matches.filter(m => !TOP_LEVEL_CATEGORIES.includes(m.category));
  } else if (categoryMatch !== 'catalog' && categoryMatch !== 'replays') {
    filteredMatches = matches.filter(m => matchesSportCatalog(m, categoryMatch));
  }

  filteredMatches = filterBySports(filteredMatches, conf);
  if (extra && extra.genre && (categoryMatch === 'live' || categoryMatch === 'upcoming' || categoryMatch === 'replays')) {
    filteredMatches = filterByGenre(filteredMatches, extra.genre);
  }

  filteredMatches = filteredMatches.filter(m => {
    if (isReplayMode) return isListedReplay(m);
    if (isReplayMatch(m)) return false;
    return !isExpiredFixture(m);
  });

  if (isReplayMode) filteredMatches = filterReplayMatches(filteredMatches, conf);

  filteredMatches = [...filteredMatches].sort((a, b) => compareCatalogMatches(a, b, isReplayMode));

  // Stremio pages catalogs with `skip`; without the slice every page re-sends
  // the entire list. Search has to run on rendered metas, so it maps first.
  const metas = paginateMetas(filteredMatches, extra, conf);

  if (isReplayMode) {
    return { metas, cacheMaxAge: REPLAY_MAX_AGE, staleRevalidate: REPLAY_STALE_REVALIDATE, staleError: 600 };
  }
  return { metas, cacheMaxAge: CATALOG_MAX_AGE, staleRevalidate: 300, staleError: 600 };
}

/**
 * Builds the placeholder meta for an id that is no longer cached, so a client
 * holding a stale link sees an explanation instead of "could not load details".
 */
function buildMissingMatchMeta(matchId) {
  const slug = matchId.replace(/^[a-z0-9]+_[0-9]+_/, '').replace(/[-_]/g, ' ');
  const title = slug.replace(/\b\w/g, c => c.toUpperCase()) || 'Sports Event';
  const poster = imageService.placeholderUrl(BASE_URL, title, '333333');
  return {
    meta: {
      id: `nuvio_sport_${matchId}`,
      type: 'tv',
      name: `⏱️ ${title}`,
      genres: ['SPORTS'],
      posterShape: 'landscape',
      poster,
      background: poster,
      logo: `${BASE_URL}/logo.png`,
      description: 'This event may have ended or updated in the schedule. Please refresh the catalog or check back shortly.',
      behaviorHints: { defaultVideoId: `nuvio_sport_${matchId}` }
    },
    cacheMaxAge: 60,
    staleRevalidate: 120
  };
}

async function handleMeta(type, id, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { meta: null };
  }

  // Fire-and-forget stale-while-revalidate, same as handleCatalog.
  container.resolve('cronService').ensureFresh();

  const matchId = id.replace('nuvio_sport_', '');
  const cacheService = container.resolve('cacheService');
  const match = cacheService.findMatch(matchId);

  if (!match) {
    return buildMissingMatchMeta(matchId);
  }

  // Prewarm: mint tokens for this match's top sources while the user is still
  // on the detail page, so the eventual click is near-instant. Fire-and-forget.
  try { streams.prewarmMatch(match, config || {}).catch(() => {}); } catch (_) {}

  return { meta: mapMatchToMetaPreview(match, config || {}), cacheMaxAge: CATALOG_MAX_AGE, staleRevalidate: 300, staleError: 600 };
}

module.exports = {
  handleCatalog,
  handleReplayCatalog,
  handleMeta,
  isMatchLive,
  isReplayMatch,
  mapMatchToMetaPreview,
  compareCatalogMatches,
  getKickoff,
  getEventDurationMs,
  isFavoriteMatch,
  parseFavoriteTeams,
  SPORT_MAX_DURATION_MS
};
