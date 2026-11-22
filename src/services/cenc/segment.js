/**
 * cenc/segment.js — removes CENC (`cenc` / AES-CTR) protection from one
 * fragmented-MP4 media segment, in place.
 *
 * Framing comes from `tfhd` + `trun`; encryption metadata comes from `senc`.
 *
 * The CTR keystream covers the cipher bytes only. Clear bytes
 * (`BytesOfClearData`, the NAL headers) neither are encrypted nor advance the
 * counter, so consecutive cipher runs of a sample share one continuous
 * keystream that starts at the sample IV. Decrypting the whole sample and
 * restoring the clear spans desynchronises every cipher run by the clear length
 * and yields slices the decoder rejects. One `Decipher` per sample, fed run by
 * run, keeps its counter between `update()` calls and gives the right stream.
 */

'use strict';

const crypto = require('crypto');
const { findChild, findChildren, findTops, collect, writeType, flags } = require('./boxes');

const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;

const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTS = 0x000800;

const SENC_OVERRIDE = 0x000001;
const SENC_SUBSAMPLE = 0x000002;

/** Failure to decrypt a segment; `code` names the cause. */
class CencError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {object} [extra]  extra properties copied onto the error
   */
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'CencError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * 8- or 16-byte IV to a 16-byte counter block (IV in the high bytes, counter 0).
 * @param {Buffer} iv
 * @param {number} ivSize
 * @returns {Buffer}
 */
function counterBlock(iv, ivSize) {
  if (ivSize === 16) return iv.subarray(0, 16);
  const block = Buffer.alloc(16);
  iv.copy(block, 0, 0, Math.min(ivSize, iv.length));
  return block;
}

/**
 * Reads the fields of `tfhd` the decryptor needs.
 * @param {Buffer} buf
 * @param {object} tfhd
 * @returns {{trackId:number, flags:number, baseDataOffset:number|null, defaultSampleSize:number}}
 */
function readTfhd(buf, tfhd) {
  const tfFlags = flags(buf, tfhd);
  const trackId = tfhd.body + 8 <= tfhd.end ? buf.readUInt32BE(tfhd.body + 4) : 0;
  let p = tfhd.body + 8;
  const out = { trackId, flags: tfFlags, baseDataOffset: null, defaultSampleSize: 0 };

  if (tfFlags & TFHD_BASE_DATA_OFFSET) {
    if (p + 8 > tfhd.end) throw new CencError('TFHD_TRUNCATED');
    out.baseDataOffset = Number(buf.readBigUInt64BE(p));
    p += 8;
  }
  if (tfFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) p += 4;
  if (tfFlags & TFHD_DEFAULT_SAMPLE_DURATION) p += 4;
  if (tfFlags & TFHD_DEFAULT_SAMPLE_SIZE) {
    out.defaultSampleSize = p + 4 <= tfhd.end ? buf.readUInt32BE(p) : 0;
    p += 4;
  }
  if (tfFlags & TFHD_DEFAULT_SAMPLE_FLAGS) p += 4;
  return out;
}

/**
 * Parses one `trun` into absolute sample byte ranges. `data_offset` is signed
 * and relative to the base-data offset.
 * @param {Buffer} buf
 * @param {object} trun
 * @param {number} baseDataOffset
 * @param {number} defaultSampleSize
 * @param {number} cursor  where the previous run ended
 * @returns {{samples: {offset:number,size:number}[], nextCursor:number}}
 */
function readTrun(buf, trun, baseDataOffset, defaultSampleSize, cursor) {
  const trFlags = flags(buf, trun);
  const count = trun.body + 8 <= trun.end ? buf.readUInt32BE(trun.body + 4) : 0;
  let p = trun.body + 8;

  let offset = cursor;
  if (trFlags & TRUN_DATA_OFFSET) {
    if (p + 4 > trun.end) throw new CencError('TRUN_TRUNCATED');
    offset = baseDataOffset + buf.readInt32BE(p);
    p += 4;
  }
  if (trFlags & TRUN_FIRST_SAMPLE_FLAGS) p += 4;

  const perSampleSize = Boolean(trFlags & TRUN_SAMPLE_SIZE);
  const samples = [];
  for (let i = 0; i < count; i++) {
    if (trFlags & TRUN_SAMPLE_DURATION) p += 4;
    let size;
    if (perSampleSize) {
      if (p + 4 > trun.end) throw new CencError('TRUN_TRUNCATED');
      size = buf.readUInt32BE(p);
      p += 4;
    } else {
      size = defaultSampleSize;
    }
    if (trFlags & TRUN_SAMPLE_FLAGS) p += 4;
    if (trFlags & TRUN_SAMPLE_CTS) p += 4;

    if (!size) throw new CencError('SAMPLE_SIZE_UNKNOWN');
    samples.push({ offset, size });
    offset += size;
  }
  return { samples, nextCursor: offset };
}

/**
 * Parses `senc` into one entry per sample.
 * @param {Buffer} buf
 * @param {object} senc
 * @param {number} [trackIvSize]  IV size from the track's `tenc`
 * @returns {{iv:Buffer, ivSize:number, kid:string, subsamples:{clear:number,cipher:number}[]|null}[]}
 */
function readSenc(buf, senc, trackIvSize) {
  const sencFlags = flags(buf, senc);
  let p = senc.body + 4;
  let ivSize = trackIvSize || 8;
  let kid = '';

  if (sencFlags & SENC_OVERRIDE) {
    if (p + 20 > senc.end) throw new CencError('SENC_TRUNCATED');
    ivSize = buf[p + 3] || ivSize;
    kid = buf.toString('hex', p + 4, p + 20);
    p += 20;
  }
  if (p + 4 > senc.end) throw new CencError('SENC_TRUNCATED');
  const count = buf.readUInt32BE(p);
  p += 4;

  const hasSubsamples = Boolean(sencFlags & SENC_SUBSAMPLE);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + ivSize > senc.end) throw new CencError('SENC_TRUNCATED');
    const iv = buf.subarray(p, p + ivSize);
    p += ivSize;

    let subsamples = null;
    if (hasSubsamples) {
      if (p + 2 > senc.end) throw new CencError('SENC_TRUNCATED');
      const n = buf.readUInt16BE(p);
      p += 2;
      subsamples = [];
      for (let j = 0; j < n; j++) {
        if (p + 6 > senc.end) throw new CencError('SENC_TRUNCATED');
        subsamples.push({ clear: buf.readUInt16BE(p), cipher: buf.readUInt32BE(p + 2) });
        p += 6;
      }
    }
    entries.push({ iv, ivSize, kid, subsamples });
  }
  return entries;
}

/**
 * Looks a KID up in the key table, falling back to `__fallback`.
 * @param {Object<string, Buffer>} keysByKid
 * @param {string} kid
 * @returns {Buffer|null}
 */
function resolveKey(keysByKid, kid) {
  if (!keysByKid) return null;
  if (kid && keysByKid[kid]) return keysByKid[kid];
  const normalised = String(kid || '').toLowerCase().replace(/-/g, '');
  if (normalised && keysByKid[normalised]) return keysByKid[normalised];
  return keysByKid.__fallback || null;
}

/**
 * Decrypts every sample of every `traf` of every `moof` in `buf`, in place.
 * A segment without `moof` is returned untouched.
 * @param {Buffer} buf  `styp` + `moof` + `mdat`, possibly repeated
 * @param {{tracks?: Map<number, object>, keysByKid?: Object<string, Buffer>}} [opts]
 * @returns {{buf: Buffer, stats: {samples:number, bytes:number, moofs:number, trafs:number, skipped:number}}}
 * @throws {CencError} SENC_MISSING | KID_MISSING | SENC_COUNT_MISMATCH | SAMPLE_OUT_OF_BOUNDS | SUBSAMPLE_OVERFLOW | truncation codes
 */
function decryptSegment(buf, opts = {}) {
  const tracks = opts.tracks || new Map();
  const keysByKid = opts.keysByKid || {};
  const stats = { samples: 0, bytes: 0, moofs: 0, trafs: 0, skipped: 0 };
  const moofs = findTops(buf, 'moof');
  if (moofs.length === 0) return { buf, stats };

  for (const moof of moofs) {
    stats.moofs += 1;
    for (const traf of findChildren(buf, moof, 'traf')) {
      stats.trafs += 1;
      const tfhd = findChild(buf, traf, 'tfhd');
      if (!tfhd) throw new CencError('TFHD_MISSING');
      const header = readTfhd(buf, tfhd);
      const track = tracks.get(header.trackId) || null;

      const senc = findChild(buf, traf, 'senc');
      if (!senc) {
        if (track && track.protected) {
          throw new CencError('SENC_MISSING', `traf ${header.trackId} has no senc`, { trackId: header.trackId });
        }
        stats.skipped += 1;
        continue;
      }

      const baseDataOffset = header.baseDataOffset !== null ? header.baseDataOffset : moof.start;
      const entries = readSenc(buf, senc, track && track.ivSize);

      // All runs are walked before any byte is decrypted so a count mismatch
      // is reported on an untouched segment.
      const samples = [];
      let cursor = baseDataOffset;
      for (const trun of findChildren(buf, traf, 'trun')) {
        const run = readTrun(buf, trun, baseDataOffset, header.defaultSampleSize, cursor);
        cursor = run.nextCursor;
        samples.push(...run.samples);
      }
      if (entries.length !== samples.length) {
        throw new CencError('SENC_COUNT_MISMATCH',
          `senc has ${entries.length} entries for ${samples.length} samples`, { trackId: header.trackId });
      }

      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const entry = entries[i];
        if (sample.offset < 0 || sample.offset + sample.size > buf.length) {
          throw new CencError('SAMPLE_OUT_OF_BOUNDS',
            `sample ${i} [${sample.offset}, +${sample.size}] exceeds segment (${buf.length})`);
        }

        const kid = entry.kid || (track && track.kid);
        const key = resolveKey(keysByKid, kid);
        if (!key) throw new CencError('KID_MISSING', `no key for KID ${kid || '(unknown)'}`, { kid });

        const decipher = crypto.createDecipheriv(
          'aes-128-ctr', key, counterBlock(entry.iv, entry.ivSize || (track && track.ivSize) || 8)
        );

        if (!entry.subsamples || entry.subsamples.length === 0) {
          decipher.update(buf.subarray(sample.offset, sample.offset + sample.size)).copy(buf, sample.offset);
        } else {
          let at = 0;
          for (const ss of entry.subsamples) {
            if (at + ss.clear + ss.cipher > sample.size) {
              throw new CencError('SUBSAMPLE_OVERFLOW',
                `subsample runs past sample ${i} (${at}+${ss.clear}+${ss.cipher} > ${sample.size})`);
            }
            if (ss.cipher > 0) {
              const from = sample.offset + at + ss.clear;
              decipher.update(buf.subarray(from, from + ss.cipher)).copy(buf, from);
            }
            at += ss.clear + ss.cipher;
          }
        }

        stats.samples += 1;
        stats.bytes += sample.size;
      }
    }

    for (const box of collect(buf, moof, ['senc', 'saiz', 'saio', 'pssh'])) writeType(buf, box, 'free');
    for (const box of collect(buf, moof, ['sgpd', 'sbgp'])) {
      if (box.body + 8 <= box.end && buf.toString('latin1', box.body + 4, box.body + 8) === 'seig') {
        writeType(buf, box, 'free');
      }
    }
  }

  return { buf, stats };
}

module.exports = { decryptSegment, CencError, counterBlock };
