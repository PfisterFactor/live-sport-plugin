const { describe, test, expect, beforeAll } = require('bun:test');
const fs = require('fs');
const path = require('path');
const DashToHlsService = require('../../../src/services/DashToHlsService');
const { fillSegmentTemplate, parseIsoDuration } = DashToHlsService;
const { KEY_HEX, KID_HEX } = require('./fixtures/cenc-fixtures');

const NITRO_MPD_URL = 'https://otte.live.fly.ww.aiv-cdn.net/fra-nitro/out/v1/ab9d1f/cenc.mpd';
const AKAMAI_MPD_URL = 'https://akamai-edge.example.com/dash/live/tennis/manifest.mpd';

const readFixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const makePayload = (mpdUrl) => ({ mpdUrl, key: KEY_HEX, kid: KID_HEX, headers: {} });

function makeService(xmlByHost) {
  return new DashToHlsService({
    fetcher: async (url) => {
      for (const [host, xml] of Object.entries(xmlByHost)) {
        if (url.includes(host)) return { ok: true, status: 200, url, text: async () => xml };
      }
      return { ok: false, status: 404, url, text: async () => '' };
    }
  });
}

describe('DashToHlsService', () => {
  let nitroXml;
  let akamaiXml;

  beforeAll(() => {
    nitroXml = readFixture('nitro-live.mpd');
    akamaiXml = readFixture('akamai-live.mpd');
  });

  describe('MPD parsing (real Amazon Nitro live manifest)', () => {
    test('extracts video/audio representations from the live (last) period', () => {
      const parsed = new DashToHlsService().parseMpd(nitroXml, NITRO_MPD_URL);

      expect(parsed.videoReps.length).toBe(6);
      expect(parsed.audioReps.length).toBe(1);
      expect(parsed.videoReps[0].bandwidth).toBe(8200000);
      expect(parsed.videoReps[0].codecs).toBe('avc1.640028');
      expect(parsed.audioReps[0].lang).toBe('hin');
    });

    test('detects cenc protection and keeps CDN token params on the init URL', () => {
      const { videoReps, audioReps } = new DashToHlsService().parseMpd(nitroXml, NITRO_MPD_URL);

      expect(videoReps[0].encryption).toBe('cenc');
      expect(audioReps[0].encryption).toBe('cenc');
      expect(videoReps[0].initUrl).toMatch(/^https:\/\/otte\.live\.fly\.ww\.aiv-cdn\.net\/.*cenc_video_6_0_init\.mp4\?m=\d+$/);
    });

    test('keeps an absolute media template for server-side URL synthesis', () => {
      const { videoReps } = new DashToHlsService().parseMpd(nitroXml, NITRO_MPD_URL);
      expect(videoReps[0].mediaTemplate).toMatch(/^https:\/\/otte\.live\.fly\.ww\.aiv-cdn\.net\/.*\$Number\$\.mp4/);
      expect(videoReps[0].segmentShape.uniform).toBe(true);
    });

    test('caps the live window and indexes MEDIA-SEQUENCE from DASH $Number$', () => {
      const { videoReps, audioReps } = new DashToHlsService().parseMpd(nitroXml, NITRO_MPD_URL);
      const video = videoReps[0];

      expect(video.segments.length).toBeLessThanOrEqual(15);
      expect(audioReps[0].segments.length).toBeLessThanOrEqual(15);
      expect(video.segments[0].number).toBe(8550);
      expect(video.segments[video.segments.length - 1].number).toBe(8564);
      expect(video.segments[0].url).toContain('cenc_video_6_0_8550.mp4');
    });

    test('bounds materialized segments for very large SegmentTimeline repeats', () => {
      const xml = '<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000"><SegmentTemplate media="seg-$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="1" r="1000000"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
      const segments = new DashToHlsService().parseMpd(xml, 'https://example.com/manifest.mpd').videoReps[0].segments;

      expect(segments).toHaveLength(15);
      expect(segments[0].number).toBe(999987);
      expect(segments[14].number).toBe(1000001);
      expect(segments[0].url).toContain('seg-999987.m4s');
    });

    test('rejects non-MPD documents and malformed XML', () => {
      const svc = new DashToHlsService();
      expect(() => svc.parseMpd('<html/>', NITRO_MPD_URL)).toThrow(/no <MPD> root/);
      expect(() => svc.parseMpd('<MPD><Period>', NITRO_MPD_URL)).toThrow(/XML parse error/);
      expect(() => svc.parseMpd('<MPD/>', NITRO_MPD_URL)).toThrow(/no <Period>/);
    });
  });

  describe('HLS rendering', () => {
    const reqBase = 'http://192.168.1.50:7000';
    const signed = 'tok.sig';

    test('master playlist: audio rendition group, every video variant, child playlists carrying the token', async () => {
      const master = await makeService({ 'otte.live.fly': nitroXml }).buildMaster(makePayload(NITRO_MPD_URL), signed, reqBase);

      expect(master).toContain('#EXT-X-VERSION:7');
      expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud"');
      expect(master).toContain('LANGUAGE="hin"');
      expect(master).toMatch(/#EXT-X-STREAM-INF:BANDWIDTH=\d+,CODECS="avc1\.640028,mp4a\.40\.2",RESOLUTION=1920x1080,AUDIO="aud"/);
      expect(master).toContain(`${reqBase}/api/dash/audio.m3u8?d=${signed}`);

      const variants = master.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
      const uris = master.split('\n').filter((l) => l.includes('/api/dash/video.m3u8'));
      expect(variants).toHaveLength(6);
      expect(new Set(uris.map((u) => u.match(/&r=([^&]+)/)[1])).size).toBe(6);
      expect(variants[0]).toMatch(/BANDWIDTH=8\d{6}/);
    });

    test('video playlist: no EXT-X-KEY, init and segments served through this server by number', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const repId = svc.parseMpd(nitroXml, NITRO_MPD_URL).videoReps[0].id;
      const playlist = await svc.buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', signed, reqBase);

      expect(playlist).not.toContain('#EXT-X-KEY');
      expect(playlist).toContain(`#EXT-X-MAP:URI="${reqBase}/api/dash/init.mp4?d=${signed}&k=video&r=${repId}"`);
      expect(playlist).toMatch(/#EXT-X-MEDIA-SEQUENCE:8550/);
      expect(playlist).toMatch(/#EXT-X-TARGETDURATION:2/);

      const segmentUrls = playlist.split('\n').filter((l) => l.startsWith('http'));
      expect(segmentUrls.length).toBeGreaterThan(0);
      for (const url of segmentUrls) {
        expect(url.startsWith(`${reqBase}/api/dash/segment.mp4?d=`)).toBe(true);
        expect(url).not.toContain('aiv-cdn.net');
      }
      expect(segmentUrls[0]).toContain('&n=8550');
    });

    test('playlist window slides monotonically when the upstream timeline advances', async () => {
      const slidXml = nitroXml.split('d="50000" r="41"').join('d="50000" r="42"');
      expect(slidXml).not.toBe(nitroXml);

      const seqOf = async (xml) => Number((await makeService({ 'otte.live.fly': xml })
        .buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', signed, reqBase)).match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);

      expect(await seqOf(slidXml)).toBe((await seqOf(nitroXml)) + 1);
    });

    test('resolves a segment number that already slid out of the window (paused player)', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const repId = svc.parseMpd(nitroXml, NITRO_MPD_URL).videoReps[0].id;

      const target = await svc.resolveSegment(makePayload(NITRO_MPD_URL), 'video', repId, 8520);
      expect(target.url).toContain('cenc_video_6_0_8520.mp4');
    });

    test('resolves an out-of-window AUDIO number whose durations alternate (1.984/2.016 s)', async () => {
      const svc = new DashToHlsService();
      const segments = [0, 1, 2, 3].map((i) => ({
        number: 100 + i,
        time: i * 88200,
        durationSec: i % 2 ? 2.016 : 1.984,
        url: `https://cdn.example/audio/seg_${100 + i}.mp4?m=1`
      }));
      const rep = {
        kind: 'audio',
        id: '7',
        bandwidth: 128000,
        timescale: 44100,
        baseUrl: 'https://cdn.example/audio/',
        mediaTemplate: 'https://cdn.example/audio/seg_$Number$.mp4?m=1',
        segments
      };
      rep.segmentShape = svc._shapeOf(segments, rep.timescale);
      expect(rep.segmentShape.uniform).toBe(false);

      svc._streamContext = async () => ({ parsed: { videoReps: [], audioReps: [rep] }, policy: {} });
      const target = await svc.resolveSegment(makePayload(NITRO_MPD_URL), 'audio', '7', 500);

      expect(target.url).toBe('https://cdn.example/audio/seg_500.mp4?m=1');
    });

    test('the stream policy allowlists the MPD host and the hosts the MPD points at', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const { policy } = await svc.resolveRepresentation(makePayload(NITRO_MPD_URL), 'video');
      expect([...policy.hosts]).toEqual(['otte.live.fly.ww.aiv-cdn.net']);
    });
  });

  describe('Akamai-style fixed-duration MPD ($RepresentationID$, BaseURL)', () => {
    const reqBase = 'http://10.0.0.5:7000';
    const clearKeyXml = (xml, startIso) => xml
      .replace(/value="cbcs"/g, 'value="cenc"')
      .replace(/availabilityStartTime="[^"]*"/, `availabilityStartTime="${startIso}"`);
    const isoAgo = (ms) => new Date(Date.now() - ms).toISOString().replace('Z', '+00:00');

    test('derives the live window from the wall clock', async () => {
      const svc = makeService({ 'akamai-edge.example.com': clearKeyXml(akamaiXml, isoAgo(2 * 3600 * 1000)) });
      const playlist = await svc.buildMediaPlaylist(makePayload(AKAMAI_MPD_URL), 'video', 'tok.sig', reqBase);
      const seq = Number(playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);

      expect(playlist).not.toContain('#EXT-X-KEY');
      expect(playlist).toContain('&r=video_1080');
      expect(seq).toBeGreaterThanOrEqual(700000);
      expect(playlist.match(/&n=\d+/g).length).toBeGreaterThan(5);
    });

    test('synthesises segment and init URLs from BaseURL and $RepresentationID$', async () => {
      const svc = makeService({ 'akamai-edge.example.com': clearKeyXml(akamaiXml, isoAgo(2 * 3600 * 1000)) });
      const { rep } = await svc.resolveRepresentation(makePayload(AKAMAI_MPD_URL), 'video', 'video_1080');
      expect(rep.initUrl).toBe('https://akamai-edge.example.com/dash/live/tennis/video_1080/init.mp4');
      expect((await svc.resolveSegment(makePayload(AKAMAI_MPD_URL), 'video', 'video_1080', 700123)).url)
        .toBe('https://akamai-edge.example.com/dash/live/tennis/video_1080/700123.m4s');
    });

    test('emits nothing before the availability start (pre-live guard)', () => {
      const inOneHour = new Date(Date.now() + 3600 * 1000).toISOString().replace('Z', '+00:00');
      expect(() => new DashToHlsService().parseMpd(clearKeyXml(akamaiXml, inOneHour), AKAMAI_MPD_URL))
        .toThrow(/no video representations/i);
    });

    test('refuses cbcs: CTR-decrypting it would emit garbage', () => {
      expect(() => new DashToHlsService().parseMpd(akamaiXml, AKAMAI_MPD_URL)).toThrow(/cbcs/);
    });
  });

  describe('upstream header sanitization (Akamai 403s Dalvik UAs)', () => {
    test('prefers a non-Dalvik UA when both variants are present', () => {
      const headers = new DashToHlsService()._sanitizeUpstreamHeaders({
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 5)'
      });
      expect(headers['User-Agent']).toMatch(/Mozilla/);
    });

    test('replaces a Dalvik-only UA and strips hop-by-hop headers', () => {
      const headers = new DashToHlsService()._sanitizeUpstreamHeaders({
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13)',
        Host: 'evil.example.com',
        Connection: 'keep-alive',
        Referer: 'https://keep-me.example/'
      });
      expect(headers['User-Agent']).toMatch(/Mozilla/);
      expect(headers.Host).toBeUndefined();
      expect(headers.Connection).toBeUndefined();
      expect(headers.Referer).toBe('https://keep-me.example/');
    });
  });

  describe('template helpers', () => {
    test('fillSegmentTemplate substitutes identifiers, widths and escaped dollars', () => {
      expect(fillSegmentTemplate('$RepresentationID$/$Number%05d$-$Time$-$Bandwidth$-$$.m4s', {
        representationId: 'v1', bandwidth: 800, number: 42, time: 9000
      })).toBe('v1/00042-9000-800-$.m4s');
    });

    test('parseIsoDuration reads live-window durations and tolerates garbage', () => {
      expect(parseIsoDuration('PT299.000S')).toBe(299);
      expect(parseIsoDuration('PT1H2M3.5S')).toBe(3723.5);
      expect(parseIsoDuration('nope')).toBe(0);
    });
  });
});
