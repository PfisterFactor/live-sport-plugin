/**
 * m3u8.js — the subset of HLS playlist parsing this addon needs.
 *
 * Extracts #EXT-X-TARGETDURATION and the #EXT-X-STREAM-INF variants of a
 * master playlist. Attribute grammar follows RFC 8216 §4.2: comma-separated
 * key=value pairs where the value is either a quoted string or runs to the
 * next comma.
 */

const ATTRIBUTE = /(?:^|,)\s*([^=,]+)=("[^"]*"|[^,]*)/g;

function parseAttributes(text) {
  const out = {};
  for (const m of text.matchAll(ATTRIBUTE)) {
    out[m[1].trim()] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  if (out.RESOLUTION) {
    const [w, h] = out.RESOLUTION.split('x');
    out.RESOLUTION = { width: parseInt(w, 10), height: parseInt(h, 10) };
  }
  if (out.BANDWIDTH) out.BANDWIDTH = parseInt(out.BANDWIDTH, 10);
  if (out['FRAME-RATE']) out['FRAME-RATE'] = parseFloat(out['FRAME-RATE']);
  return out;
}

/**
 * @param {string} text playlist body
 * @returns {{ targetDuration: number|undefined, totalDuration: number, playlists: Array<{ uri: string, attributes: object }> }}
 */
function parsePlaylist(text) {
  const manifest = { targetDuration: undefined, totalDuration: 0, playlists: [] };
  let pending = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace('\r', '').trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const d = parseInt(line.slice('#EXT-X-TARGETDURATION:'.length), 10);
      if (Number.isFinite(d) && d >= 0) manifest.targetDuration = d;
    } else if (line.startsWith('#EXTINF:')) {
      const d = parseFloat(line.slice('#EXTINF:'.length));
      if (Number.isFinite(d) && d > 0) manifest.totalDuration += d;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = Object.assign(pending || {}, parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length)));
    } else if (line[0] !== '#' && pending) {
      manifest.playlists.push({ uri: line, attributes: pending });
      pending = null;
    }
  }
  return manifest;
}

module.exports = { parsePlaylist, parseAttributes };
