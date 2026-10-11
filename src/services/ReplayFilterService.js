'use strict';

/**
 * Pure helper behind the "Replay catalog" config option (`config.replayFilter`).
 *
 *   'all' (default)  -> no filtering
 *   'mainstream'     -> only fixtures MainstreamRankingService classifies as mainstream
 *   'disabled'       -> replay catalogs are hidden from the manifest and serve nothing
 *
 * Replay rows are assembled from every replay-capable source, so a busy
 * Saturday lists hundreds of niche and lower-division fixtures; 'mainstream'
 * turns the existing tier classifier into one user-facing switch.
 *
 * Malformed config and malformed input degrade to "no filtering" rather than
 * throwing. An empty result is legitimate (a quiet day can have no mainstream
 * replays) and is handed to the caller's normal empty path.
 */

const { TIER, getMatchTier } = require('./MainstreamRankingService');

const REPLAY_FILTER_ALL = 'all';
const REPLAY_FILTER_MAINSTREAM = 'mainstream';
const REPLAY_FILTER_DISABLED = 'disabled';

/** Normalizes the raw option to 'all' | 'mainstream' | 'disabled' ('all' default). */
function parseReplayFilter(config) {
  const raw = typeof config === 'string'
    ? config
    : (config && typeof config === 'object' ? config.replayFilter : null);
  if (typeof raw !== 'string') return REPLAY_FILTER_ALL;
  const normalized = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'mainstream' || normalized === 'mainstreamonly') return REPLAY_FILTER_MAINSTREAM;
  if (normalized === 'disabled' || normalized === 'off' || normalized === 'hidden' || normalized === 'none') return REPLAY_FILTER_DISABLED;
  return REPLAY_FILTER_ALL;
}

/** True when the user asked for mainstream-only replay catalogs. */
function isMainstreamOnlyReplayFilter(config) {
  return parseReplayFilter(config) === REPLAY_FILTER_MAINSTREAM;
}

/** True when the user switched replay catalogs off entirely. */
function isReplayFilterDisabled(config) {
  return parseReplayFilter(config) === REPLAY_FILTER_DISABLED;
}

/**
 * Applies the replay personalization to a list of matches. Returns the SAME
 * array when nothing should be filtered; non-array input yields an empty array.
 */
function filterReplayMatches(matches, config) {
  if (!Array.isArray(matches)) return [];
  const mode = parseReplayFilter(config);
  if (mode === REPLAY_FILTER_DISABLED) return [];
  if (mode === REPLAY_FILTER_ALL) return matches;
  return matches.filter(m => getMatchTier(m) === TIER.MAINSTREAM);
}

module.exports = {
  REPLAY_FILTER_ALL,
  REPLAY_FILTER_MAINSTREAM,
  REPLAY_FILTER_DISABLED,
  parseReplayFilter,
  isMainstreamOnlyReplayFilter,
  isReplayFilterDisabled,
  filterReplayMatches
};
