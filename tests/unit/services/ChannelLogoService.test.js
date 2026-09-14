const { describe, it, expect } = require('bun:test');
const { getChannelLogo, CHANNEL_LOGOS } = require('../../../src/services/ChannelLogoService');

describe('ChannelLogoService.getChannelLogo', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const expected = CHANNEL_LOGOS['tennis channel'];
    expect(getChannelLogo('Tennis Channel')).toBe(expected);
    expect(getChannelLogo('  TENNIS CHANNEL  ')).toBe(expected);
  });

  it('prefers the longest matching key over a generic branding prefix', () => {
    expect(getChannelLogo('Sky Sports Cricket')).toBe(CHANNEL_LOGOS['sky sports cricket']);
    expect(getChannelLogo('Sky Sports F1')).toBe(CHANNEL_LOGOS['sky sports f1']);
    expect(getChannelLogo('Sky Sports Main Event HD')).toBe(CHANNEL_LOGOS['sky sports main event']);
    expect(getChannelLogo('Sky Sports Mix')).toBe(CHANNEL_LOGOS['sky sports']);
  });

  it('keeps numbered siblings distinct', () => {
    expect(getChannelLogo('TNT Sports 1')).toBe(CHANNEL_LOGOS['tnt sports 1']);
    expect(getChannelLogo('TNT Sports 2')).toBe(CHANNEL_LOGOS['tnt sports 2']);
    expect(getChannelLogo('TNT Sports 1')).not.toBe(getChannelLogo('TNT Sports 2'));
    expect(getChannelLogo('TNT Sports')).toBe(CHANNEL_LOGOS['tnt sports']);
  });

  it('matches a known channel embedded in a decorated listing title', () => {
    expect(getChannelLogo('[UK] Sky Sports Premier League FHD'))
      .toBe(CHANNEL_LOGOS['sky sports premier league']);
    expect(getChannelLogo('ESPNU — Live')).toBe(CHANNEL_LOGOS['espnu']);
  });

  it('does not let a longer unrelated key win over the correct specific one', () => {
    expect(getChannelLogo('beIN Sports XTRA')).toBe(CHANNEL_LOGOS['bein sports xtra']);
    expect(getChannelLogo('beIN Sports USA')).toBe(CHANNEL_LOGOS['bein sports usa']);
    expect(getChannelLogo('CBS Sports Golazo Network')).toBe(CHANNEL_LOGOS['cbs sports golazo network']);
  });

  it('returns null for unknown channels and for empty input', () => {
    expect(getChannelLogo('Manchester United vs Arsenal')).toBeNull();
    expect(getChannelLogo('')).toBeNull();
    expect(getChannelLogo(null)).toBeNull();
    expect(getChannelLogo(undefined)).toBeNull();
  });

  it('exposes only absolute https logo URLs', () => {
    const bad = Object.entries(CHANNEL_LOGOS).filter(([, v]) => !/^https:\/\//.test(v));
    expect(bad).toEqual([]);
  });
});
