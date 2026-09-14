const { parsePlaylist } = require('./m3u8');

class M3U8ParserService {
  constructor() {}

  /**
   * Synchronously parse already fetched manifest text to extract maximum resolution, FPS, and bitrate.
   */
  parseManifestText(manifestText) {
    if (!manifestText || !manifestText.includes('#EXT')) return null;
    try {
      const playlists = parsePlaylist(manifestText).playlists;
      if (playlists.length === 0) return null;

      // Sort by bandwidth descending
      playlists.sort((a, b) => (b.attributes.BANDWIDTH || 0) - (a.attributes.BANDWIDTH || 0));

      const best = playlists[0];
      let height = null;
      if (best.attributes && best.attributes.RESOLUTION) {
        height = best.attributes.RESOLUTION.height;
      }

      const frameRate = best.attributes && best.attributes['FRAME-RATE'] 
        ? Math.round(best.attributes['FRAME-RATE']) 
        : null;
      const bandwidth = best.attributes && best.attributes.BANDWIDTH ? best.attributes.BANDWIDTH : 0;

      let qualityTag = '';
      if (height) {
        qualityTag = `${height}p`;
        if (frameRate && frameRate >= 45) {
          qualityTag += `${frameRate}`;
        }
      } else {
        qualityTag = 'HD';
      }

      let bitrateTag = '';
      if (bandwidth > 0) {
        if (bandwidth >= 1000000) {
          bitrateTag = `${(bandwidth / 1000000).toFixed(1)} Mbps`;
        } else {
          bitrateTag = `${Math.round(bandwidth / 1000)} kbps`;
        }
      }

      let fullQuality = qualityTag;
      if (bitrateTag) {
        fullQuality += ` · ${bitrateTag}`;
      }

      return {
        resolution: height ? `${best.attributes.RESOLUTION.width}x${height}` : null,
        qualityTag,
        bitrateTag,
        frameRate,
        fullQuality
      };
    } catch (e) {
      return null;
    }
  }
}

module.exports = M3U8ParserService;
