const { describe, it, expect } = require('bun:test');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

// Obfuscated scripts and WASM copied from embed sites. They execute in a child
// process, so any change to them must be a deliberate, reviewed update.
const PINNED = {
  'gasm_india.js':    '551a6bd338b032a0240977bfcad8b28fc4413cd15c0ada212d094f501c5eebce',
  'gasm.wasm':        '9f467ba46e9890b2c5855cda60ca331e769f5b76a0a6da7a07bff10f6f1c0401',
  'streamcorner_worker.js': 'f700bd0ddac90792222b5f026cd5083ef08aea5abf7cc6127743dea4986de67a',
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
