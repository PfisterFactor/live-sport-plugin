const { describe, test, expect } = require('bun:test');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const MlbLiveProvider = require('../../../src/providers/MlbLiveProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/live', name), 'utf8');

describe('MlbLiveProvider', () => {
  test('parses replay cards from the listing page', async () => {
    const p = new MlbLiveProvider(makeCradle());
    p.fetchPage = { fire: async () => fixture('mlb_listing.html') };
    const matches = await p.getMatches();
    expect(matches.length).toBeGreaterThan(10);
    const game = matches.find((m) => /world series game 1/i.test(m.title));
    expect(game.category).toBe('baseball');
    expect(game.status).toBe('finished');
    expect(game.league).toBe('MLB World Series');
    expect(game.team1.name).toBe('Tampa Bay Rays');
    expect(game.date).toBe(String(Date.UTC(2026, 9, 23, 12)));
    expect(game.sources[0].url).toStartWith('https://mlblive.net/');
  });

  test('decryptByse round-trips an AES-GCM payload', () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify({ sources: [{ url: 'https://cdn/x.m3u8' }] })), cipher.final()]);
    const playback = {
      iv: iv.toString('base64'),
      payload: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
      key_parts: [key.subarray(0, 16).toString('base64'), key.subarray(16).toString('base64')],
    };
    expect(MlbLiveProvider.decryptByse(playback).sources[0].url).toBe('https://cdn/x.m3u8');
    expect(MlbLiveProvider.decryptByse({ ...playback, iv: crypto.randomBytes(12).toString('base64') })).toBeNull();
  });

  test('resolves OK.ru embeds from a replay page', async () => {
    const p = new MlbLiveProvider(makeCradle());
    const options = JSON.stringify({ flashvars: { metadata: JSON.stringify({
      videos: [{ name: 'hd', url: 'https://vk.example/hd.mp4' }, { name: 'full', url: 'https://vk.example/full.mp4' }],
      hlsManifestUrl: 'https://vk.example/video.m3u8',
    }) } }).replace(/"/g, '&quot;');
    p.fetchPage = { fire: async (url) => (url.includes('ok.ru') ? `<div data-options="${options}"></div>` : fixture('mlb_game.html')) };
    const streams = await p.resolveStream('https://mlblive.net/game', 'baseball', 'Game', {});
    const okStreams = streams.filter((s) => s.title.includes('[OK.ru]'));
    expect(okStreams.map((s) => s.resolution)).toEqual(['Auto', '720p', '1080p']);
    expect(okStreams[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://ok.ru/');
  });
});
