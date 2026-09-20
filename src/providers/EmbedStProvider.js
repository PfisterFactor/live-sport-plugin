const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const StreamEntity = require('../domain/StreamEntity');
const { findEmbedIframe } = require('./embedIframe');
const { runProviderScript } = require('./runner');
const path = require('path');
const { manifestProxyUrl } = require('../proxyUrl');

class EmbedStProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'EmbedSt';
    this.embedIndiaProvider = opts.embedIndiaProvider;
  }

  async getMatches() {
    return [];
  }

  /**
   * Extracts a signed m3u8 from an embed.st (or sportsembed.su) page.
   * Shared by resolveStream and the manifest proxy's token renewal.
   */
  async extractM3u8(embedUrl) {
    if (embedUrl.includes('sportsembed.su') || embedUrl.includes('watchfooty.st/embed')) {
      const { extractSportsEmbed } = require('./SportsEmbedExtractor');
      const m3u8 = await extractSportsEmbed(embedUrl);
      return m3u8 ? { m3u8, referer: 'https://sportsembed.su/' } : null;
    }

    const parts = embedUrl.split('/');
    const user = parts[parts.length - 3];
    const event = parts[parts.length - 2];
    const id = parts[parts.length - 1];
    if (!user || !event || !id) return null;

    const scriptPath = path.join(__dirname, 'run_wasm_native.js');
    const stdout = await runProviderScript(scriptPath, [user, event, id, embedUrl]);
    const urlMatch = stdout.match(/https:\/\/[^\s"]+\.m3u8/);
    if (!urlMatch) return null;

    let referer;
    try {
      referer = new URL(embedUrl).origin + '/';
    } catch (_) {
      referer = 'https://embed.st/';
    }
    return { m3u8: urlMatch[0], referer };
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
        console.log(`[${this.name}] Decrypting native stream for ${embedUrl}...`);
        const extracted = await this.extractM3u8(embedUrl);

        if (extracted) {
          console.log(`[${this.name}] Natively decrypted M3U8 for ${matchTitle}: ${extracted.m3u8}`);
          streams.push(new StreamEntity({
            name: 'EmbedSt',
            title: `[Direct] ${matchTitle}`,
            url: manifestProxyUrl({
              url: extracted.m3u8,
              referer: extracted.referer,
              renew: 'embedst',
              embed: embedUrl,
            }),
            behaviorHints: { notWebReady: true },
            resolution: 'HD'
          }));
        } else {
          console.warn(`[${this.name}] Native decryption failed to extract M3U8 for ${embedUrl}`);
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
