const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

/**
 * zlive.st. The public catalog lives at iptv.zlive.st; the streams list and
 * the per-channel resolver are POST endpoints whose body is an AES-GCM
 * envelope keyed with SHA-256(secret + ":" + <client-supplied date>), the
 * same scheme the zlive SPA uses (see its b1() signer).
 */
const XLIVE_SECRET_BYTES = [
  90, 60, 239, 235, 212, 205, 249, 180, 217, 191, 73, 88, 239, 208, 186, 248,
  244, 243, 198, 162, 91, 95, 133, 199, 145, 194, 247, 197, 242, 192, 106, 34,
  145, 129, 180, 191, 241, 182, 152, 253, 88, 53, 238,
];
const XLIVE_SECRET2_BYTES = [40, 111, 218, 177, 249, 137, 188, 132, 160, 143];

const SECRET = XLIVE_SECRET_BYTES
  .map((v, i) => String.fromCharCode(v ^ XLIVE_SECRET2_BYTES[i % XLIVE_SECRET2_BYTES.length]))
  .join('');

class ZliveProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'ZLive';
    this.apiUrl = 'https://iptv.zlive.st';

    this.fetchChannels = this.circuitBreaker.wrap(`${this.name}_fetchChannels`, async () => {
      const res = await this.proxyFetch(`${this.apiUrl}/channels.json`, {
        headers: { 'User-Agent': DEFAULT_UA, 'Accept': 'application/json' },
        timeoutMs: 15000,
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.postSigned = this.circuitBreaker.wrap(`${this.name}_postSigned`, async (path, payload) => {
      const body = JSON.stringify(await this._makeEnvelope(payload));
      const res = await this.proxyFetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: { 'User-Agent': DEFAULT_UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body,
        timeoutMs: 15000,
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  /**
   * Build the {q, s, t, d} AES-GCM envelope: q is the ciphertext without the
   * auth tag, s the base64 IV, t the tag, d the date the key was bound to.
   */
  async _makeEnvelope(payload) {
    const now = new Date();
    const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const keyBytes = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${SECRET}:${d}`)
    ));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(payload))
    ));

    const tagStart = ct.length - 16;
    const b64 = (u8) => Buffer.from(u8).toString('base64');
    return {
      q: b64(ct.slice(0, tagStart)),
      s: b64(iv),
      t: b64(ct.slice(tagStart)),
      d,
    };
  }

  async getMatches() {
    const matches = [];
    try {
      const [channelsRes, eventsRes] = await Promise.allSettled([
        this.fetchChannels.fire(),
        this.postSigned.fire('/streams', { ts: Math.floor(Date.now() / 1000) }),
      ]);

      if (channelsRes.status === 'fulfilled' && Array.isArray(channelsRes.value)) {
        for (const ch of channelsRes.value) {
          if (!ch || !ch.id || !ch.name || !ch.live) continue;
          matches.push(new MatchEntity({
            id: `zl_${ch.id}`,
            title: ch.name,
            category: 'networks',
            status: '',
            date: '',
            popular: '0',
            logo: ch.logo || '',
            poster: ch.logo || '',
            league: ch.sport || '',
            sources: [{ source: 'zlive', id: String(ch.id), slug: String(ch.id) }],
          }));
        }
      }

      if (eventsRes.status === 'fulfilled' && Array.isArray(eventsRes.value)) {
        for (const ev of eventsRes.value) {
          if (!ev || !ev.id || !ev.name || !ev.live) continue;
          const startsMs = ev.startTime ? Date.parse(ev.startTime) : NaN;
          const slug = (ev.source && ev.source.key) || ev.id;

          matches.push(new MatchEntity({
            id: `zle_${ev.id}`,
            title: ev.name,
            category: this.normalizeCategory(ev.type),
            status: Number.isFinite(startsMs) && startsMs > Date.now() ? 'upcoming' : 'live',
            date: Number.isFinite(startsMs) ? String(startsMs) : '',
            popular: '0',
            poster: ev.thumbnail || '',
            sources: [{ source: 'zlive', id: String(ev.id), slug: String(slug) }],
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    try {
      const slug = src.slug || sourceId;
      const data = await this.postSigned.fire('/resolve', { slug: String(slug), ts: Math.floor(Date.now() / 1000) });
      if (data && data.location) {
        streams.push(new StreamEntity({
          name: this.name,
          title: matchTitle,
          url: data.location,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                'Origin': 'https://zlive.st',
                'Referer': 'https://zlive.st/',
                'User-Agent': DEFAULT_UA,
              },
            },
          },
          resolution: 'HD',
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

ZliveProvider.SECRET = SECRET;

module.exports = ZliveProvider;
