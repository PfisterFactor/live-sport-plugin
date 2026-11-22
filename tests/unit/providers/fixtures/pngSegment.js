const zlib = require('node:zlib');

/** A buffer of `packets` MPEG-TS packets (0x47 sync, packet index in the payload). */
function tsBytes(packets) {
  const out = Buffer.alloc(packets * 188);
  for (let i = 0; i < packets; i++) {
    out[i * 188] = 0x47;
    out[i * 188 + 1] = i & 0xff;
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

/**
 * Packs `payload` into an 8-bit RGB PNG the way the TimStreams CDN does:
 * payload bytes become pixel bytes (zero padded), one filter byte per row,
 * with the true length in a `kwLn` chunk.
 *
 * @param {Buffer} payload
 * @param {{ width?: number, filter?: number }} [opts]
 */
function pngSegment(payload, { width = 16, filter = 0 } = {}) {
  const stride = width * 3;
  const height = Math.ceil(payload.length / stride);
  const pixels = Buffer.alloc(height * stride);
  payload.copy(pixels);

  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const cur = pixels[y * stride + i];
      const left = i >= 3 ? pixels[y * stride + i - 3] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const sub = filter === 1 ? left : filter === 2 ? up : 0;
      raw[y * (stride + 1) + 1 + i] = (cur - sub) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('kwLn', len),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { pngSegment, tsBytes };
