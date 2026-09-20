const { describe, it, expect } = require('bun:test');
const PpvProvider = require('../../../src/providers/PpvProvider');
const ZliveProvider = require('../../../src/providers/ZliveProvider');
const DliveProvider = require('../../../src/providers/DliveProvider');
const StreamCornerProvider = require('../../../src/providers/StreamCornerProvider');
const { makeCradle } = require('./fixtures/helpers');

const HOUR_MS = 3600 * 1000;

describe('PpvProvider', () => {
  function apiPayload(now) {
    return {
      streams: [
        {
          category: 'American Football', id: 26, always_live: true, streams: [
            { id: 18172, name: 'NFL Network', uri_name: 'nfl-network', starts_at: 0, ends_at: 0, always_live: 1, category_name: 'American Football', iframe: 'https://embedindia.st/embed/nfl-network', viewers: '27' },
          ],
        },
        {
          category: 'Football', id: 34, always_live: false, streams: [
            { id: 28624, name: 'Carolina Panthers at Atlanta Falcons', uri_name: 'nfl/2026-09-20/car-atl', starts_at: Math.floor((now.getTime() - HOUR_MS) / 1000), ends_at: Math.floor((now.getTime() + 2 * HOUR_MS) / 1000), always_live: 0, category_name: 'Football', iframe: 'https://embedindia.st/embed/x', viewers: '752' },
            { id: 29999, name: 'Long Ended Match', uri_name: 'old', starts_at: Math.floor((now.getTime() - 5 * HOUR_MS) / 1000), ends_at: Math.floor((now.getTime() - 4 * HOUR_MS) / 1000), always_live: 0, category_name: 'Football', iframe: 'https://embedindia.st/embed/y', viewers: '0' },
            { id: 29998, name: 'Next Week', uri_name: 'next', starts_at: Math.floor((now.getTime() + 48 * HOUR_MS) / 1000), ends_at: Math.floor((now.getTime() + 50 * HOUR_MS) / 1000), always_live: 0, category_name: 'Football', iframe: 'https://embedindia.st/embed/z', viewers: '0' },
          ],
        },
      ],
    };
  }

  function makeProvider(payload) {
    const p = new PpvProvider(makeCradle());
    p.fetchStreams = { fire: async () => payload };
    return p;
  }

  it('maps always-live channels to the networks category with empty status', async () => {
    const p = makeProvider(apiPayload(new Date()));
    const matches = await p.getMatches();
    const net = matches.find(m => m.id === 'ppv_18172');
    expect(net).toBeDefined();
    expect(net.category).toBe('networks');
    expect(net.status).toBe('');
    expect(net.popular).toBe('1');
  });

  it('marks in-window events live and drops events ended beyond the grace window', async () => {
    const p = makeProvider(apiPayload(new Date()));
    const matches = await p.getMatches();
    expect(matches.find(m => m.id === 'ppv_28624').status).toBe('live');
    expect(matches.find(m => m.id === 'ppv_28624').category).toBe('football');
    expect(matches.find(m => m.id === 'ppv_29999')).toBeUndefined();
  });

  it('marks future events upcoming', async () => {
    const p = makeProvider(apiPayload(new Date()));
    const matches = await p.getMatches();
    expect(matches.find(m => m.id === 'ppv_29998').status).toBe('upcoming');
  });

  it('resolves nothing when the event vanished from the API', async () => {
    const p = makeProvider(apiPayload(new Date()));
    const streams = await p.resolveStream('123', 'football', 'Gone', {});
    expect(streams).toEqual([]);
  });
});

describe('ZliveProvider envelope', () => {
  it('round-trips the payload through AES-GCM: q+s+t decrypt to the original JSON', async () => {
    const p = new ZliveProvider(makeCradle());
    const env = await p._makeEnvelope({ slug: 'beinsports2-au', ts: 1789929090 });

    expect(env.d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const iv = Buffer.from(env.s, 'base64');
    expect(iv.length).toBe(12);

    const keyBytes = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(ZliveProvider.SECRET + ':' + env.d)
    ));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const ct = Buffer.concat([Buffer.from(env.q, 'base64'), Buffer.from(env.t, 'base64')]);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ slug: 'beinsports2-au', ts: 1789929090 });
  });
});

describe('DliveProvider schedule parsing', () => {
  function scheduleHtml() {
    return `<html><body><section>
      <div class="schedule schedule--compact" id="schedule">
        <div class="schedule__day">
          <div class="schedule__dayTitle">Sunday 20th Sep 2026 - Schedule Time UK GMT</div>
          <div class="schedule__category is-expanded">
            <div class="schedule__catHeader" tabindex="0" role="button" aria-expanded="true">
              <div class="card__meta">All Soccer Events ⚽</div>
              <i class="fa-solid fa-chevron-right cat-icon" aria-hidden="true"></i>
            </div>
            <div class="schedule__categoryBody">
              <div class="schedule__event">
                <div class="schedule__eventHeader" data-title="x">
                  <span class="schedule__time" data-time="11:00">11:00</span>
                  <span class="schedule__eventTitle">Celtic vs Rangers</span>
                </div>
                <div class="schedule__channels">
                  <a target="_blank" href="/watch.php?id=35" title="Sky Sports Football UK">Sky Sports Football UK</a>
                  <a target="_blank" href="/watch.php?id=38" title="Sky Sports Main Event UK">Sky Sports Main Event UK</a>
                </div>
              </div>
              <div class="schedule__event">
                <div class="schedule__eventHeader" data-title="y">
                  <span class="schedule__time" data-time="23:59">23:59</span>
                  <span class="schedule__eventTitle">No Channels Match</span>
                </div>
                <div class="schedule__channels"></div>
              </div>
            </div>
          </div>
          <div class="schedule__category is-expanded">
            <div class="schedule__catHeader">
              <div class="card__meta">Upcoming Events</div>
            </div>
            <div class="schedule__categoryBody">
              <div class="schedule__event">
                <div class="schedule__eventHeader" data-title="z">
                  <span class="schedule__time" data-time="06:00">06:00</span>
                  <span class="schedule__eventTitle">🏎️ Formula 1 Grand Prix Baku – Race | Baku, Azerbaijan | 26 September 2026</span>
                </div>
                <div class="schedule__channels">
                  <a target="_blank" href="/watch.php?id=60" title="Sky Sports F1 UK">Sky Sports F1 UK</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section></body></html>`;
  }

  function makeProvider() {
    const p = new DliveProvider(makeCradle());
    p.fetchSchedule = { fire: async () => scheduleHtml() };
    return p;
  }

  it('extracts events with time, channels and emoji-mapped category', async () => {
    const p = makeProvider();
    const matches = await p.getMatches();
    const oldFirm = matches.find(m => m.title === 'Celtic vs Rangers');
    expect(oldFirm).toBeDefined();
    expect(oldFirm.category).toBe('football');
    expect(oldFirm.sources[0].id).toBe('35,38');
    expect(matches.find(m => m.title === 'No Channels Match')).toBeUndefined();
  });

  it('derives the event date from the title for Upcoming Events rows and maps via title emoji', async () => {
    const p = makeProvider();
    const matches = await p.getMatches();
    const f1 = matches.find(m => m.title.includes('Formula 1'));
    expect(f1.category).toBe('motorsport');
    expect(new Date(Number(f1.date)).toISOString().startsWith('2026-09-26')).toBe(true);
  });

  it('falls back to a watch page link for every listed channel when extraction fails', async () => {
    const p = makeProvider();
    p._playerEmbedUrl = async () => null;
    const streams = await p.resolveStream('35,38', 'football', 'Celtic vs Rangers');
    expect(streams.map(s => s.externalUrl)).toEqual([
      'https://dlive.sx/watch.php?id=35',
      'https://dlive.sx/watch.php?id=38',
    ]);
  });

  it('proxies the extracted manifest with a renewal descriptor', async () => {
    const p = makeProvider();
    p._playerEmbedUrl = async (id) => `https://dlive.sx/embed.php?id=${id}`;
    p.extractM3u8 = async () => ({ m3u8: 'https://edge.dl/live/a.m3u8', referer: 'https://dlive.sx/' });
    const [stream] = await p.resolveStream('35', 'football', 'Celtic vs Rangers');
    const q = new URL(stream.url).searchParams;
    expect(q.get('url')).toBe('https://edge.dl/live/a.m3u8');
    expect(q.get('renew')).toBe('dlive');
    expect(q.get('embed')).toBe('https://dlive.sx/embed.php?id=35');
  });

  it('decodes the embed config envelope produced by the player host', () => {
    const config = { stream_url: 'https://cdn.example/hls/a.m3u8?s=tok&e=1', stream_url_nop2p: 'https://cdn.example/hls/b.m3u8?s=tok&e=1', p2p: true };
    const inner = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');

    // Inverse of the site's encoder: reorder [2,0,3,1], base64 each chunk,
    // then inject one junk character at index 3.
    const order = [2, 0, 3, 1];
    const size = Math.ceil(inner.length / order.length);
    const slices = [];
    for (let i = 0, at = 0; i < order.length; i++, at += size) slices.push(inner.substr(at, size));
    const encoded = Buffer.from(
      order.map((pos) => {
        const b = Buffer.from(slices[pos], 'binary').toString('base64');
        return b.slice(0, 3) + 'X' + b.slice(3);
      }).join(''),
      'binary'
    ).toString('base64');

    expect(DliveProvider.decodeEmbedConfig(encoded)).toEqual(config);
  });
});

describe('StreamCornerProvider', () => {
  it('uses only worker hosts from the pinned pool', () => {
    expect(StreamCornerProvider.WORKER_HOSTS.length).toBeGreaterThan(10);
    expect(StreamCornerProvider.WORKER_HOSTS).toContain('data.daniellemarsh444.workers.dev');
  });
});
