const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const StreamEntity = require('../domain/StreamEntity');
const { findEmbedIframe } = require('./embedIframe');
const { runProviderScript } = require('./runner');
const path = require('path');

class EmbedStProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'EmbedSt';
    this.embedIndiaProvider = opts.embedIndiaProvider;
  }

  async getMatches() {
    return [];
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];

    const embedUrl = src.embedUrl || sourceId;
    if (!embedUrl || !embedUrl.startsWith('http')) {
      console.warn(`[${this.name}] Invalid embed URL: ${embedUrl}`);
      return streams;
    }

    let referer = src.referer;
    if (!referer) {
      try {
        referer = new URL(embedUrl).origin + '/';
      } catch (err) {
        referer = 'https://embed.st/';
      }
    }

    // CF Worker edge-scraper removed per user request

    // ─── Tier 0: Iframe redirect detection ───────────────────────────────────
    // Some embed.st pages (e.g. dead channels like rally-tv) swap their native 
    // stream for an <iframe src="https://embedindia.st/..."> fallback.
    // WASM would still extract a token for the dead stream → 404/Not found.
    // We detect this by quickly fetching the embed HTML and checking for iframes
    // pointing at known external providers. If found, skip WASM entirely.
    const IFRAME_FALLBACK_DOMAINS = ['embedindia.st', 'embedindia.com', 'embedsport.xyz', 'sportsembed.su'];
    if (streams.length === 0 && !embedUrl.includes('sportsembed.su')) {
      try {
        const htmlRes = await this.proxyFetch(embedUrl, {
          headers: { 'User-Agent': DEFAULT_UA, 'Referer': referer, 'Accept': 'text/html' },
          timeoutMs: 6000,
        });
        const iframeSrc = findEmbedIframe(await htmlRes.text(), IFRAME_FALLBACK_DOMAINS);
        if (iframeSrc) {
          console.log(`[${this.name}] Detected iframe redirect -> ${iframeSrc} for ${matchTitle}. Resolving via iframe provider.`);
          const iframeReferer = new URL(iframeSrc).origin + '/';

          if (iframeSrc.includes('embedindia') && this.embedIndiaProvider) {
            const indiaStreams = await this.embedIndiaProvider.resolveStream(iframeSrc, matchCategory, matchTitle, { referer: iframeReferer });
            if (indiaStreams.length > 0) {
              indiaStreams.forEach((s) => {
                s.name = this.name;
                s.title = s.title.replace('EmbedIndia', this.name);
              });
              streams.push(...indiaStreams);
            }
          }

          if (streams.length === 0) {
            streams.push(new StreamEntity({
              name: 'EmbedSt',
              title: `${matchTitle} (Live)`,
              externalUrl: `/watch?mode=extract&embed=${encodeURIComponent(iframeSrc)}&referer=${encodeURIComponent(iframeReferer)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
            }));
          }
        }
      } catch (e) {
        // Non-fatal - if HTML fetch fails just fall through to WASM
        console.warn(`[${this.name}] Iframe detection prefetch failed for ${embedUrl}: ${e.message}`);
      }
    }

    // ─── Tier 1: Native WASM decryption ─────────────────────────────────────
    if (streams.length === 0) {
      try {
        // Parse the user, event, id from the URL: https://embed.st/embed/admin/ppv-celtic-vs-lask-linz/1
        const parts = embedUrl.split('/');
        const user  = parts[parts.length - 3];
        const event = parts[parts.length - 2];
        const id    = parts[parts.length - 1];

        if (user && event && id && !embedUrl.includes('sportsembed.su')) {
          console.log(`[${this.name}] Decrypting native WASM for ${user}/${event}/${id}...`);

          const scriptPath = path.join(__dirname, 'run_wasm_native.js');
          const stdout = await runProviderScript(scriptPath, [user, event, id, embedUrl]);
          const urlMatch = stdout.match(/https:\/\/[^\s"]+\.m3u8/);
          const m3u8Url = urlMatch ? urlMatch[0] : null;

          if (m3u8Url) {
            console.log(`[${this.name}] Natively decrypted M3U8 for ${matchTitle}: ${m3u8Url}`);
            const { BASE_URL } = require('../config');
            const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(new URL(referer).origin)}`;
            streams.push(new StreamEntity({
              name: 'EmbedSt',
              title: `[Direct] ${matchTitle}`,
              url: proxyUrl,
              behaviorHints: { 
                notWebReady: true
              },
              resolution: 'HD'
            }));
          } else {
            console.warn(`[${this.name}] Native decryption failed to extract M3U8 for ${embedUrl}`);
          }
        } else if (embedUrl.includes('sportsembed.su') || embedUrl.includes('watchfooty.st/embed')) {
            console.log(`[${this.name}] Decrypting native WASM for sportsembed...`);
            try {
                const { extractSportsEmbed } = require('./SportsEmbedExtractor');
                const m3u8Url = await extractSportsEmbed(embedUrl);
                if (m3u8Url) {
                    console.log(`[${this.name}] Natively decrypted M3U8 for sportsembed: ${m3u8Url}`);
                    const { BASE_URL } = require('../config');
                    const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent('https://sportsembed.su/')}&origin=${encodeURIComponent('https://sportsembed.su')}`;
                    streams.push(new StreamEntity({
                        name: 'EmbedSt',
                        title: `[Direct] ${matchTitle}`,
                        url: proxyUrl,
                        behaviorHints: { notWebReady: true },
                        resolution: 'HD'
                    }));
                }
            } catch (err) {
                console.warn(`[${this.name}] SportsEmbed Decryptor error: ${err.message}`);
            }
        }
      } catch (err) {
        console.warn(`[${this.name}] Decryptor error for ${embedUrl}: ${err.message}`);
      }
    }



    // ─── Tier 3: Raw embed fallback — always appended ────────────────────────
    streams.push(new StreamEntity({
      name: 'EmbedSt',
      title: `${matchTitle} (Web Player)`,
      externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
    }));

    return streams;
  }
}

module.exports = EmbedStProvider;
