/**
 * cenc/init.js — reads the initialization segment (`styp` + `moov`) and turns
 * an encrypted track into one a demuxer treats as plain H.264/AAC.
 *
 * `uncloakInit` only rewrites four-character box types; every size and offset
 * stays byte-identical, so `stsz`/`stco`/`co64` never need repair.
 */

'use strict';

const { readBox, children, findChild, findChildren, findTop, collect, writeType, version } = require('./boxes');

const ENTRY_HEADER = { video: 78, audio: 28, subtitle: 8 };
const VIDEO_ENTRIES = new Set(['encv', 'avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);
const AUDIO_ENTRIES = new Set(['enca', 'mp4a', 'ac-3', 'ec-3', 'Opus', 'fLaC']);
const SUBTITLE_ENTRIES = new Set(['encs', 'wvtt', 'stpp']);

/**
 * Track kind a sample-entry type belongs to.
 * @param {string} type
 * @returns {'video'|'audio'|'subtitle'|null}
 */
function entryKindOf(type) {
  if (VIDEO_ENTRIES.has(type)) return 'video';
  if (AUDIO_ENTRIES.has(type)) return 'audio';
  if (SUBTITLE_ENTRIES.has(type)) return 'subtitle';
  return null;
}

/**
 * Child boxes of a sample entry, after its format-specific fixed header.
 * @param {Buffer} buf
 * @param {object} entry
 * @returns {object[]}
 */
function sampleEntryChildren(buf, entry) {
  const kind = entryKindOf(entry.type);
  const start = entry.body + (kind ? ENTRY_HEADER[kind] : 0);
  if (start >= entry.end) return [];
  const first = readBox(buf, start, entry.end);
  if (!first || first.size < 8) return [];
  return [...children(buf, start, entry.end)];
}

/**
 * Track ID from a `tkhd` box.
 * @param {Buffer} buf
 * @param {object|null} tkhd
 * @returns {number|null}
 */
function readTrackId(buf, tkhd) {
  if (!tkhd) return null;
  const off = tkhd.body + 4 + (version(buf, tkhd) === 1 ? 16 : 8);
  return off + 4 > tkhd.end ? null : buf.readUInt32BE(off);
}

/**
 * Handler type (`vide`, `soun`, ...) from an `hdlr` box.
 * @param {Buffer} buf
 * @param {object|null} hdlr
 * @returns {string}
 */
function readHandlerType(buf, hdlr) {
  return hdlr ? buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) : '';
}

/**
 * Finds `tenc` in a protection scheme info box. The spec puts it in
 * `sinf > schi > tenc`; some packagers write it directly under `sinf`, and
 * the live Akamai/Nitro feeds use the `schi` form.
 * @param {Buffer} buf
 * @param {object|null} sinf
 * @returns {object|null}
 */
function findTenc(buf, sinf) {
  if (!sinf) return null;
  return findChild(buf, findChild(buf, sinf, 'schi'), 'tenc') || findChild(buf, sinf, 'tenc');
}

/**
 * Reads a `tenc` box. The spec layout is 4 bytes version/flags, one reserved
 * byte, isProtected, Per_Sample_IV_Size, then the 16-byte KID. The live
 * Amazon/Akamai ClearKey inits write TWO reserved bytes, which shifts every
 * field one byte early (isProtected=0, IV size 1, KID from the middle of the
 * real one). The KID is therefore located at the spec offset and at the
 * end-anchored offset, and the winner is the candidate that matches the KID the
 * manifest declared, else the first with sane fields.
 * @param {Buffer} buf
 * @param {object|null} tenc
 * @param {string} [expectedKid]  hex KID from the provider, dashes allowed
 * @returns {{isProtected:number, ivSize:number, kid:string, constantIv:number}|null}
 */
function parseTenc(buf, tenc, expectedKid = '') {
  if (!tenc) return null;
  const bodyLen = tenc.end - tenc.body;
  if (bodyLen < 19) return null;

  const at = (kidOffset) => ({
    isProtected: buf[tenc.body + kidOffset - 2],
    ivSize: buf[tenc.body + kidOffset - 1],
    kid: buf.toString('hex', tenc.body + kidOffset, tenc.body + kidOffset + 16),
    kidOffset
  });

  const candidates = [];
  if (bodyLen >= 23) candidates.push(at(7));
  if (bodyLen >= 24) candidates.push(at(bodyLen - 16));

  const sane = (c) => (c.isProtected === 0 || c.isProtected === 1) && [0, 8, 16].includes(c.ivSize);
  const wanted = String(expectedKid || '').toLowerCase().replace(/-/g, '');
  const chosen = (wanted && candidates.find((c) => c.kid === wanted)) || candidates.find(sane) || candidates[0];
  if (!chosen) return null;

  let constantIv = 0;
  if (chosen.isProtected === 1 && chosen.ivSize === 0) {
    constantIv = buf[tenc.body + chosen.kidOffset + 16] || 0;
  }
  return { isProtected: chosen.isProtected, ivSize: chosen.ivSize, kid: chosen.kid, constantIv };
}

/**
 * Describes one `trak`.
 * @param {Buffer} buf
 * @param {object} trak
 * @param {string} [expectedKid]
 * @returns {{trackId:number, kind:string, format:string, protected:boolean, scheme:string, ivSize:number, kid:string}|null}
 */
function parseTrack(buf, trak, expectedKid = '') {
  const trackId = readTrackId(buf, findChild(buf, trak, 'tkhd'));
  if (trackId === null) return null;

  const mdia = findChild(buf, trak, 'mdia');
  const handler = readHandlerType(buf, findChild(buf, mdia, 'hdlr'));
  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler === 'subt' ? 'subtitle' : 'other';

  const stsd = findChild(buf, findChild(buf, findChild(buf, mdia, 'minf'), 'stbl'), 'stsd');
  const entry = stsd && stsd.body + 8 <= stsd.end ? readBox(buf, stsd.body + 8, stsd.end) : null;
  if (!entry) return { trackId, kind, format: '', protected: false, scheme: '', ivSize: 0, kid: '' };

  const protectedTrack = entry.type.startsWith('enc');
  let scheme = '';
  let ivSize = 0;
  let kid = '';
  if (protectedTrack) {
    const sinf = sampleEntryChildren(buf, entry).find((b) => b.type === 'sinf') || null;
    const schm = findChild(buf, sinf, 'schm');
    if (schm && schm.body + 8 <= schm.end) scheme = buf.toString('latin1', schm.body + 4, schm.body + 8);
    const tenc = parseTenc(buf, findTenc(buf, sinf), expectedKid);
    if (tenc) {
      ivSize = tenc.ivSize;
      kid = tenc.kid;
      if (!tenc.isProtected) scheme = '';
    }
  }

  return { trackId, kind, format: entry.type, protected: protectedTrack, scheme, ivSize: ivSize || 8, kid };
}

/**
 * Reads every `trak` of `moov`.
 * @param {Buffer} buf
 * @param {{expectedKid?: string}} [options]
 * @returns {{tracks: Map<number, object>, moov: object|null}}
 */
function parseInit(buf, options = {}) {
  const moov = findTop(buf, 'moov');
  const tracks = new Map();
  if (!moov) return { tracks, moov: null };

  for (const trak of findChildren(buf, moov, 'trak')) {
    const info = parseTrack(buf, trak, options.expectedKid);
    if (info) tracks.set(info.trackId, info);
  }
  return { tracks, moov };
}

/**
 * Relabels `seig` key-rotation groups, which must not survive uncloaking.
 * @param {Buffer} buf
 * @param {object} root
 */
function maskSeigGroups(buf, root) {
  for (const box of collect(buf, root, ['sgpd', 'sbgp'])) {
    if (box.body + 8 <= box.end && buf.toString('latin1', box.body + 4, box.body + 8) === 'seig') {
      writeType(buf, box, 'free');
    }
  }
}

/**
 * Rewrites protected sample entries to their clear equivalents and neutralises
 * every box that would tell a demuxer the track is encrypted. Mutates `buf`.
 * @param {Buffer} buf
 * @param {{expectedKid?: string, maskSencInInit?: boolean}} [options]
 * @returns {{buf: Buffer, tracks: Map<number, object>}}
 */
function uncloakInit(buf, options = {}) {
  const { tracks, moov } = parseInit(buf, options);
  if (!moov) return { buf, tracks };

  for (const trak of findChildren(buf, moov, 'trak')) {
    const mdia = findChild(buf, trak, 'mdia');
    const stsd = findChild(buf, findChild(buf, findChild(buf, mdia, 'minf'), 'stbl'), 'stsd');
    if (!stsd || stsd.body + 8 > stsd.end) continue;

    const entry = readBox(buf, stsd.body + 8, stsd.end);
    if (!entry || !entry.type.startsWith('enc')) continue;

    const sinf = sampleEntryChildren(buf, entry).find((b) => b.type === 'sinf') || null;
    const frma = findChild(buf, sinf, 'frma');
    const originalFormat = frma && frma.end - frma.body >= 4
      ? buf.toString('latin1', frma.body, frma.body + 4)
      : '';

    const kind = entryKindOf(entry.type);
    const clear = originalFormat || (kind === 'audio' ? 'mp4a' : kind === 'video' ? 'avc1' : '');
    if (clear && clear !== entry.type) writeType(buf, entry, clear);

    // Children are relabelled as well as the parent so a byte scan for "tenc"
    // cannot conclude the track is still protected.
    if (sinf) {
      for (const child of children(buf, sinf.body, sinf.end)) {
        if (child.type === 'schi') {
          for (const inner of children(buf, child.body, child.end)) {
            if (inner.type === 'tenc') writeType(buf, inner, 'free');
          }
          writeType(buf, child, 'free');
        } else if (child.type === 'schm' || child.type === 'tenc' || child.type === 'frma') {
          writeType(buf, child, 'free');
        }
      }
      writeType(buf, sinf, 'free');
    }
  }

  for (const pssh of findChildren(buf, moov, 'pssh')) writeType(buf, pssh, 'free');
  maskSeigGroups(buf, moov);

  if (options.maskSencInInit) {
    for (const senc of collect(buf, moov, 'senc')) writeType(buf, senc, 'free');
  }

  return { buf, tracks };
}

module.exports = { parseInit, uncloakInit, parseTenc, sampleEntryChildren, entryKindOf };
