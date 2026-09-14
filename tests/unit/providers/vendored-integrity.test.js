const { describe, it, expect } = require('bun:test');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

// Obfuscated scripts and WASM copied from embed sites. They execute in a child
// process, so any change to them must be a deliberate, reviewed update.
const PINNED = {
  'lock.js':          'e391c3e6567c3e89759d347f4f80dfc0c4f83088b3eeb187c61859dbad743c75',
  'gasm_india.js':    '551a6bd338b032a0240977bfcad8b28fc4413cd15c0ada212d094f501c5eebce',
  'lock.wasm':        'ccd5dd855e5aa96ac865428f195f4ead31d658872b36e4a96982c62a5ce2be97',
  'gasm.wasm':        '9f467ba46e9890b2c5855cda60ca331e769f5b76a0a6da7a07bff10f6f1c0401',
  'stream-lock.wasm': '914c1bb4038c9eec2ce41a3245bf8d81489d0a66abed9fadc08ec1d9afe983c1',
};

const dir = path.join(__dirname, '..', '..', '..', 'src', 'providers');

describe('vendored provider blobs', () => {
  for (const [file, sha256] of Object.entries(PINNED)) {
    it(`${file} matches its pinned sha256`, () => {
      const digest = createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
      expect(digest).toBe(sha256);
    });
  }
});
