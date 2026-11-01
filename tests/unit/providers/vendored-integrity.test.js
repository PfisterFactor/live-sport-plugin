const { describe, it, expect } = require('bun:test');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

// Obfuscated scripts and WASM copied from embed sites. They execute in a child
// process, so any change to them must be a deliberate, reviewed update.
const PINNED = {
  'gasm_india.js':    '551a6bd338b032a0240977bfcad8b28fc4413cd15c0ada212d094f501c5eebce',
  'gasm.wasm':        '9f467ba46e9890b2c5855cda60ca331e769f5b76a0a6da7a07bff10f6f1c0401',
  'streamcorner/Boq5hifj.js': '7acbc980f5901fdc9188e9943f53c689c093088d78958a492f6e509f3885a648',
  'streamcorner/BANJxnvq.js': '9c56157dbca2a7b3516099e48eaf5185d02a42e523ded33557d433d1fde73ce0',
  'streamcorner/P7YlZnsx.js': 'f6e04741b2d506ec65bf269c617385f810a601ae7030a875613c6296b5b73552',
  'streamcorner/CKZ-xZs0.js': 'e059b82b4630203adf9ac905916367315d98fbe84d46c637938f1860a9c81956',
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
