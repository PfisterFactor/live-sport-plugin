const container = require('./container');
const { getChannelLogo } = require('./services/ChannelLogoService');
const streams = require('./streams');
const { BASE_URL } = require('./config');
const imageService = require('./services/ImageService');

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
  const kickoff = match.date ? parseInt(match.date, 10) : 0;

  if (kickoff > 0) {
    // If kickoff is more than 15 minutes in the future, it's definitely UPCOMING, not live
    if (kickoff > now + 15 * 60 * 1000) {
      return false;
    }

    const durations = {
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
      darts: 4 * 60 * 60 * 1000
    };
    const maxDuration = durations[match.category] || (3 * 60 * 60 * 1000);

    return now >= (kickoff - 15 * 60 * 1000) && now <= (kickoff + maxDuration);
  }

  return false;
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

function mapMatchToMetaPreview(match, config = {}) {
  const isLive = isMatchLive(match);
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

  // Generate a clean, readable fallback poster using the match title
  let posterText = titleStr;
  if (match.team1 && match.team2 && match.team1.name && match.team2.name) {
      posterText = `${match.team1.name}\nvs\n${match.team2.name}`;
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
  let relativeTimeStr = '';
  let releasedIso = null;
  
  if (match.date && !isNaN(parseInt(match.date)) && parseInt(match.date) > 0) {
     const dateObj = new Date(parseInt(match.date));
     releasedIso = dateObj.toISOString();
     const timeZone = config && config.timezone ? config.timezone : null;

     timeString = kickoffFormatter(timeZone).format(dateObj) + (timeZone ? ` (${timeZone})` : '');
     
     const now = Date.now();
     const diff = dateObj.getTime() - now;
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

  const is247 = match.category === 'networks' || !match.date;
  const prefix = isLive ? (is247 ? '📺 ' : '🔴 LIVE: ') : '⏱️ ';
  const cast = [];
  if (match.team1 && match.team1.name) cast.push(match.team1.name);
  if (match.team2 && match.team2.name) cast.push(match.team2.name);

  const leagueStr = match.league ? `🏆 League: ${match.league}\n` : '';
  const statusStr = is247 
    ? '24/7 Live Network' 
    : (isLive ? '🔴 LIVE NOW' : `Kickoff at ${timeString}${relativeTimeStr}`);
  const desc = `${leagueStr}📅 Category: ${match.category.toUpperCase()}\n⏰ Status: ${statusStr}`;

  const metaPreview = {
    id: `nuvio_sport_${match.id}`,
    type: 'tv',
    name: `${prefix}${titleStr}`,
    genres: [match.category.toUpperCase()],
    poster: poster,
    posterShape: 'landscape',
    background: background,
    logo: logo,
    releaseInfo: isLive ? (is247 ? '24/7' : 'LIVE') : timeString,
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

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCatalog(type, id, extra, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sports_')) {
    return { metas: [] };
  }

  // Fire-and-forget stale-while-revalidate: return the cached list now and let
  // CronService refresh it in the background once it passes the revalidate window.
  container.resolve('cronService').ensureFresh();
  
  const conf = config || (extra && extra.config) || {};

  const categoryMatch = id.replace('nuvio_sports_', '');
  
  // Use CacheService instead of hitting APIs on demand
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  
  let filteredMatches = matches;

  if (categoryMatch === 'live') {
    filteredMatches = matches.filter(m => isMatchLive(m));
  } else if (categoryMatch === 'upcoming') {
    const now = Date.now();
    filteredMatches = matches.filter(m => !isMatchLive(m) && (parseInt(m.date) || 0) > now);
  } else if (categoryMatch === 'teams') {
    if (typeof conf.teams === 'string' && conf.teams.trim()) {
      const favoriteTeams = conf.teams.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
      filteredMatches = matches.filter(m => {
        const titleWords = m.title.toLowerCase();
        return favoriteTeams.some(team => titleWords.includes(team));
      });
    } else {
      filteredMatches = []; // If no config, return empty
    }
  } else if (categoryMatch === 'other') {
    const topLevelCats = ['football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball', 'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts', 'networks', 'college'];
    filteredMatches = matches.filter(m => !topLevelCats.includes(m.category));
  } else if (categoryMatch !== 'catalog') {
    filteredMatches = matches.filter(m => {
      if (m.category === categoryMatch) return true;
      // Also include 24/7 networks specifically matching the sport category
      if (m.category === 'networks') {
        const titleLower = m.title.toLowerCase();
        if (categoryMatch === 'cricket' && titleLower.includes('cricket')) return true;
        if (categoryMatch === 'tennis' && titleLower.includes('tennis')) return true;
        if (categoryMatch === 'motorsport' && (titleLower.includes('f1') || titleLower.includes('racing') || titleLower.includes('moto') || titleLower.includes('motorsport'))) return true;
        if (categoryMatch === 'basketball' && (titleLower.includes('nba') || titleLower.includes('basketball'))) return true;
        if (categoryMatch === 'football' && (titleLower.includes('football') || titleLower.includes('soccer') || titleLower.includes('golazo') || titleLower.includes('laliga') || titleLower.includes('premier league') || titleLower.includes('bein sports'))) return true;
        if (categoryMatch === 'rugby' && (titleLower.includes('rugby') || titleLower.includes('league') || titleLower.includes('nrl'))) return true;
        if (categoryMatch === 'american_football' && (titleLower.includes('nfl') || titleLower.includes('american football'))) return true;
        if (categoryMatch === 'baseball' && (titleLower.includes('mlb') || titleLower.includes('baseball'))) return true;
        if (categoryMatch === 'hockey' && (titleLower.includes('nhl') || titleLower.includes('hockey'))) return true;
        if (categoryMatch === 'golf' && (titleLower.includes('golf') || titleLower.includes('pga'))) return true;
      }
      return false;
    });
  }

  if (typeof conf.sports === 'string' && conf.sports !== 'all') {
    const allowedSports = conf.sports.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    // Don't filter out networks (24/7 TV) since they aren't tied to a specific sport
    filteredMatches = filteredMatches.filter(m => m.category === 'networks' || allowedSports.includes(m.category));
  }

  filteredMatches = [...filteredMatches].sort((a, b) => {
    const aIsLive = isMatchLive(a) ? 1 : 0;
    const bIsLive = isMatchLive(b) ? 1 : 0;
    if (aIsLive !== bIsLive) return bIsLive - aIsLive; // Live matches first
    
    // Within live matches: Actual live event fixtures (UFC, F1, Football, etc.) take priority over 24/7 TV channels
    const aIsEvent = a.category !== 'networks' ? 1 : 0;
    const bIsEvent = b.category !== 'networks' ? 1 : 0;
    if (aIsEvent !== bIsEvent) return bIsEvent - aIsEvent;

    // Featured / Popular matches first
    const aPop = a.popular === '1' ? 1 : 0;
    const bPop = b.popular === '1' ? 1 : 0;
    if (aPop !== bPop) return bPop - aPop;
    
    const dateA = a.date ? parseInt(a.date) : 0;
    const dateB = b.date ? parseInt(b.date) : 0;
    
    // Sort upcoming by closest kickoff first
    if (dateA > 0 && dateB > 0) return dateA - dateB;
    return 0;
  });

  // Stremio pages catalogs with `skip`; without the slice every page re-sends
  // the entire list. Search has to run on rendered metas, so it maps first.
  const skip = Math.max(0, parseInt(extra && extra.skip, 10) || 0);
  let metas;

  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    metas = filteredMatches
      .map(m => mapMatchToMetaPreview(m, conf))
      .filter(m =>
        m.name.toLowerCase().includes(q) ||
        (m.description && m.description.toLowerCase().includes(q)) ||
        (m.cast && m.cast.some(c => c.toLowerCase().includes(q)))
      )
      .slice(skip, skip + PAGE_SIZE);
  } else {
    metas = filteredMatches.slice(skip, skip + PAGE_SIZE).map(m => mapMatchToMetaPreview(m, conf));
  }

  return { metas, cacheMaxAge: CATALOG_MAX_AGE, staleRevalidate: 300, staleError: 600 };
}

async function handleMeta(type, id, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { meta: null };
  }

  // Fire-and-forget stale-while-revalidate, same as handleCatalog.
  container.resolve('cronService').ensureFresh();

  const matchId = id.replace('nuvio_sport_', '');
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match) {
    return { meta: null };
  }

  // Prewarm: mint tokens for this match's top sources while the user is still
  // on the detail page, so the eventual click is near-instant. Fire-and-forget.
  try { streams.prewarmMatch(match, config || {}).catch(() => {}); } catch (_) {}

  return { meta: mapMatchToMetaPreview(match, config || {}), cacheMaxAge: CATALOG_MAX_AGE, staleRevalidate: 300, staleError: 600 };
}

module.exports = {
  handleCatalog,
  handleMeta,
  isMatchLive
};
