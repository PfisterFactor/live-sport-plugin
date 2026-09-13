const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

class StreamicProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'Streamic';
    this.apiUrl = 'https://streamic.st/api/J.php';
    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetch`, async () => {
      const headers = { 'User-Agent': DEFAULT_UA };
      let lastErr;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await this.proxyFetch(this.apiUrl, { headers });
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          const data = await res.json();
          // The upstream sometimes answers 200 with an empty/garbage payload
          // during flap windows - treat that like a transient failure so the
          // retry below can recover it.
          if (!Array.isArray(data)) throw new Error('unexpected API payload: ' + (typeof data));
          console.log(`[Streamic] fetched ${data.length} event(s)`);
          return data;
        } catch (err) {
          lastErr = err;
          // Transient upstream 5xx (observed as boot-time 503 blips): one short
          // retry recovers it; otherwise the provider is silent for 4 hours.
          const transient = /status: 5\d\d/.test(err.message);
          if (attempt === 1 && transient) {
            console.warn(`[${this.name}] transient ${err.message} - retrying in 1200ms`);
            await new Promise(r => setTimeout(r, 1200));
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchData.fire();
      if (!Array.isArray(data)) return [];

      data.forEach(s => {
        const id = s.id ? s.id.toString() : '';
        if (!id) return;

        const categoryName = this.normalizeCategory(s.category);

        let team1 = null, team2 = null;
        if (s.title && s.title.includes(' - ')) {
           const parts = s.title.split(' - ');
           team1 = parts[0].trim();
           team2 = parts[1].trim();
        } else if (s.title && s.title.includes(' vs ')) {
           const parts = s.title.split(' vs ');
           team1 = parts[0].trim();
           team2 = parts[1].trim();
        }

        matches.push(new MatchEntity({
          id: 'streamic_' + id,
          title: s.title,
          category: categoryName,
          date: s.startTime ? (s.startTime * 1000).toString() : null,
          popular: '0',
          league: s.league || categoryName,
          team1: team1,
          team2: team2,
          sources: [{ source: 'streamic', id: id, _embeds: s._embeds || [] }]
        }));
      });
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, extraData) {
    try {
      if (!extraData || !extraData._embeds) return [];
      
      const streams = [];
      extraData._embeds.forEach(embedGroup => {
        const lang = embedGroup.language || 'Unknown';
        if (Array.isArray(embedGroup.embeds)) {
          embedGroup.embeds.forEach((e, idx) => {
            if (e.embed) {
              let streamUrl = e.embed;
              
              // Some API results return half a URL like `https://streami.fit/live/?channel_id=`
              if (streamUrl.endsWith('=')) {
                streamUrl += sourceId;
              }
              
              streams.push(new StreamEntity({
                name: 'Streamic',
                title: `${lang} ${e.label ? '(' + e.label + ')' : ''}`,
                externalUrl: streamUrl
              }));
            }
          });
        }
      });
      return streams;
    } catch (error) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, error.message);
      return [];
    }
  }
}

module.exports = StreamicProvider;
