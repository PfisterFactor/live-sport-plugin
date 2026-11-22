/**
 * AppFeed.js — helpers shared by the providers that read a sports app's
 * encrypted backend (Ak47Live, SK Tech): event timing, link header suffixes,
 * ClearKey DASH rows and embedindia-family embeds.
 *
 * Event dates in these backends ("DD/MM/YYYY" + "HH:MM[:SS]") are read as UTC.
 */

'use strict';

const StreamEntity = require('../domain/StreamEntity');
const { manifestProxyUrl, dashHlsUrl } = require('../proxyUrl');
const { DEFAULT_UA } = require('../providers/BaseProvider');

const FINISHED_GRACE_MS = 30 * 60 * 1000;
const UNKNOWN_END_MS = 4 * 3600e3;
const DAY_MS = 24 * 3600e3;

/**
 * Parses "dd/mm/yyyy" + "hh:mm[:ss]" (UTC) into epoch ms.
 * @param {string} date
 * @param {string} time
 * @returns {number} 0 when the input is unusable
 */
function parseEventTime(date, time) {
  if (!date || !time) return 0;
  const d = String(date).split('/').map(Number);
  const t = String(time).split(':').map(Number);
  if (d.length !== 3 || !d[0] || !d[1] || !d[2]) return 0;
  const ms = Date.UTC(d[2], d[1] - 1, d[0], t[0] || 0, t[1] || 0, t[2] || 0);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Kickoff in epoch ms. Feeds reuse old entries and only bump end_date, leaving
 * a start days before the end; a span over a day is read as the start time on
 * the end date.
 * @param {{date: string, time: string, end_date: string}} ev
 * @param {number} endMs
 * @returns {number}
 */
function eventStartMs(ev, endMs) {
  const startMs = parseEventTime(ev.date, ev.time);
  if (!startMs || !endMs || endMs - startMs <= DAY_MS) return startMs;
  const sameDay = parseEventTime(ev.end_date, ev.time);
  return sameDay > endMs ? sameDay - DAY_MS : sameDay;
}

/**
 * Start, end and state of a backend event at `now`.
 * @param {object} ev  decoded event row
 * @param {number} now  epoch ms
 * @returns {{startMs: number, endMs: number, finished: boolean, status: 'upcoming'|'live'}}
 */
function eventTiming(ev, now) {
  const endMs = parseEventTime(ev.end_date, ev.end_time);
  const startMs = eventStartMs(ev, endMs);
  const finished = endMs > 0
    ? now > endMs + FINISHED_GRACE_MS
    : (startMs > 0 && now > startMs + UNKNOWN_END_MS);
  return { startMs, endMs, finished, status: startMs > 0 && now < startMs ? 'upcoming' : 'live' };
}

/**
 * Applies a "k=v&k=v" suffix (from "url|Referer=...&User-Agent=..." links) onto
 * a header set as `referer`, `origin` and `userAgent`.
 * @param {string} suffix
 * @param {{referer?: string, origin?: string, userAgent?: string}} headers
 */
function applyHeaderPairs(suffix, headers) {
  for (const pair of suffix.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim().toLowerCase();
    const v = pair.slice(eq + 1).trim();
    if (k === 'referer' || k === 'http-referrer') headers.referer = v;
    else if (k === 'origin' || k === 'http-origin') headers.origin = v;
    else if (k === 'user-agent' || k === 'http-user-agent') headers.userAgent = v;
  }
}

/**
 * A backend row with an .mpd `link` ("<mpd>|k=v&k=v") and a ClearKey (`api`
 * "<kid>:<key>", or `key`/`kid`) as a relayed HLS stream.
 * @param {string} providerName
 * @param {object} selected  decoded link row
 * @param {string} matchTitle
 * @param {string} channelLabel
 * @returns {StreamEntity|null} null when the row is not ClearKey DASH or its key is not 32 hex chars
 */
function clearKeyDashStream(providerName, selected, matchTitle, channelLabel) {
  const [mpdUrl, ...suffix] = String(selected.link || '').split('|');
  if (!/\.mpd(\?|$)/i.test(mpdUrl.trim())) return null;

  const [kid, key] = typeof selected.api === 'string' && selected.api.includes(':')
    ? selected.api.trim().split(':')
    : [selected.kid, selected.key];
  const linkHeaders = {};
  applyHeaderPairs(suffix.join('|'), linkHeaders);
  const url = dashHlsUrl({
    mpdUrl: mpdUrl.trim(),
    key: String(key || '').trim(),
    kid: String(kid || '').trim(),
    headers: { 'User-Agent': linkHeaders.userAgent || DEFAULT_UA, Referer: linkHeaders.referer, Origin: linkHeaders.origin },
  });
  if (!url) return null;

  return new StreamEntity({
    name: providerName,
    title: `${matchTitle || 'Live Event'} (${channelLabel})`,
    url,
    behaviorHints: { notWebReady: true },
    resolution: 'FHD',
  });
}

/**
 * Embed page URL of an embedindia-family tokenApi entry ({type:'embed', api}).
 * @param {string|object} tokenApi
 * @param {object} [embedIndiaProvider]
 * @returns {string} '' when it is not such an embed
 */
function embedIndiaUrl(tokenApi, embedIndiaProvider) {
  if (!embedIndiaProvider) return '';
  let token;
  try {
    token = typeof tokenApi === 'string' ? JSON.parse(tokenApi) : tokenApi;
  } catch (_) { return ''; }
  const url = token && token.type === 'embed' ? token.api : '';
  return embedIndiaProvider.isEmbedUrl(url) ? url : '';
}

/**
 * Signed m3u8 from an embedindia-family embed page, proxied with renewal through that embed.
 * @param {string} providerName
 * @param {object} embedIndiaProvider
 * @param {string} embedUrl
 * @param {string} matchTitle
 * @param {string} channelLabel
 * @returns {Promise<StreamEntity[]>}
 */
async function embedIndiaStreams(providerName, embedIndiaProvider, embedUrl, matchTitle, channelLabel) {
  const extracted = await embedIndiaProvider.extractM3u8(embedUrl);
  if (!extracted) return [];
  return [new StreamEntity({
    name: providerName,
    title: `${matchTitle || 'Live Event'} (${channelLabel})`,
    url: manifestProxyUrl({ url: extracted.m3u8, referer: extracted.referer, renew: 'embedindia', embed: embedUrl }),
    behaviorHints: { notWebReady: true },
    resolution: 'HD',
  })];
}

module.exports = {
  parseEventTime,
  eventStartMs,
  eventTiming,
  applyHeaderPairs,
  clearKeyDashStream,
  embedIndiaUrl,
  embedIndiaStreams,
};
