/**
 * PngSegmentDecoder.js — unpacks HLS segments that a CDN hides inside PNG images.
 *
 * The image's pixel bytes carry the media: an optional `kwLn` chunk gives the
 * payload length, and the payload is either `KWP1` + u32 length + MPEG-TS or
 * bare MPEG-TS (0x47 sync bytes). Filtering is undone per the PNG spec.
 */

const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAMPLES_PER_PIXEL = { 0: 1, 2: 3, 4: 2, 6: 4 };
const TS_PACKET = 188;

/** True when the bytes start with the PNG signature. */
function isPng(bytes) {
  return bytes.length >= 8 && Buffer.compare(bytes.subarray(0, 8), PNG_SIGNATURE) === 0;
}

/** Reverses the per-scanline PNG filters in place over `raw` (filter byte + stride per row). */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = y > 0 ? out[prev + i] : 0;
      const upLeft = y > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let add;
      switch (filter) {
        case 0: add = 0; break;
        case 1: add = left; break;
        case 2: add = up; break;
        case 3: add = (left + up) >> 1; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default: throw new Error(`Bad PNG filter ${filter}`);
      }
      out[dst + i] = (raw[src + i] + add) & 0xff;
    }
  }
  return out;
}

/**
 * Decodes a pixel-packed PNG segment into MPEG-TS bytes. Non-PNG input is
 * returned unchanged.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer}
 */
function decodePngSegment(input) {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isPng(buf)) return buf;

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0, payloadLen = -1;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + len;
    if (end + 4 > buf.length) throw new Error(`Truncated PNG chunk: ${type}`);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      bitDepth = buf[start + 8];
      colorType = buf[start + 9];
      interlace = buf[start + 12];
    } else if (type === 'kwLn' && len === 4) {
      payloadLen = buf.readUInt32BE(start);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4;
  }

  const bpp = SAMPLES_PER_PIXEL[colorType];
  if (bitDepth !== 8 || interlace !== 0 || !bpp) throw new Error('Unsupported PNG layout');

  let pixels = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, bpp);
  if (colorType === 4 || colorType === 6) {
    const keep = colorType === 4 ? 1 : 3;
    const stripped = Buffer.alloc(width * height * keep);
    for (let i = 0, j = 0; j < stripped.length; i += bpp, j += keep) {
      for (let k = 0; k < keep; k++) stripped[j + k] = pixels[i + k];
    }
    pixels = stripped;
  }
  if (payloadLen >= 0 && payloadLen <= pixels.length) pixels = pixels.subarray(0, payloadLen);

  if (pixels.length >= 8 && pixels.toString('latin1', 0, 4) === 'KWP1') {
    const dataLen = pixels.readUInt32BE(4);
    if (8 + dataLen > pixels.length) throw new Error('KWP1 length exceeds decoded bytes');
    return pixels.subarray(8, 8 + dataLen);
  }
  if (pixels.length >= TS_PACKET && pixels[0] === 0x47) {
    let end = Math.floor(pixels.length / TS_PACKET) * TS_PACKET;
    while (end >= 2 * TS_PACKET && (pixels[end - TS_PACKET] !== 0x47 || pixels[end - 2 * TS_PACKET] !== 0x47)) end -= TS_PACKET;
    return end > 0 ? pixels.subarray(0, end) : pixels;
  }
  throw new Error('Decoded pixels do not start with KWP1 or an MPEG-TS sync byte');
}

module.exports = { decodePngSegment, isPng };
