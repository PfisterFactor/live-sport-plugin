const { describe, it, expect } = require('bun:test');
const M3U8ParserService = require('../../../src/services/M3U8ParserService');

const svc = new M3U8ParserService();

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,FRAME-RATE=25.000
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,FRAME-RATE=50.000
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,FRAME-RATE=25.000
720/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:6.000,
seg1.ts
#EXTINF:6.000,
seg2.ts
`;

describe('M3U8ParserService.parseManifestText', () => {
  it('picks the highest-bandwidth variant of a master playlist regardless of its position', () => {
    const r = svc.parseManifestText(MASTER);
    expect(r.resolution).toBe('1920x1080');
    expect(r.frameRate).toBe(50);
    expect(r.bitrateTag).toBe('5.2 Mbps');
  });

  it('appends the frame rate to the quality tag only for high-frame-rate variants', () => {
    expect(svc.parseManifestText(MASTER).qualityTag).toBe('1080p50');

    const lowFps = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,FRAME-RATE=25.000
720/index.m3u8
`;
    expect(svc.parseManifestText(lowFps).qualityTag).toBe('720p');
  });

  it('joins quality and bitrate into fullQuality', () => {
    expect(svc.parseManifestText(MASTER).fullQuality).toBe('1080p50 · 5.2 Mbps');
  });

  it('reports sub-megabit variants in kbps', () => {
    const low = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=640000,RESOLUTION=640x360
360/index.m3u8
`;
    const r = svc.parseManifestText(low);
    expect(r.bitrateTag).toBe('640 kbps');
    expect(r.fullQuality).toBe('360p · 640 kbps');
  });

  it('falls back to an HD tag and a null resolution when no RESOLUTION attribute is present', () => {
    const r = svc.parseManifestText(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1500000
a/index.m3u8
`);
    expect(r.qualityTag).toBe('HD');
    expect(r.resolution).toBeNull();
    expect(r.frameRate).toBeNull();
    expect(r.fullQuality).toBe('HD · 1.5 Mbps');
  });

  it('returns null for a media playlist, which carries no variant information', () => {
    expect(svc.parseManifestText(MEDIA)).toBeNull();
  });

  it('returns null for empty, non-manifest and non-string input', () => {
    expect(svc.parseManifestText('')).toBeNull();
    expect(svc.parseManifestText(null)).toBeNull();
    expect(svc.parseManifestText(undefined)).toBeNull();
    expect(svc.parseManifestText('<html><body>403 Forbidden</body></html>')).toBeNull();
  });

  it('survives a truncated manifest without throwing', () => {
    expect(() => svc.parseManifestText('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=')).not.toThrow();
    const r = svc.parseManifestText(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
`);
    expect(r === null || r.qualityTag === '1080p').toBe(true);
  });
});
