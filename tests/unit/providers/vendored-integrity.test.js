const { describe, it, expect } = require('bun:test');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

// Obfuscated scripts and WASM copied from embed sites. They execute in a child
// process, so any change to them must be a deliberate, reviewed update.
const PINNED = {
  'gasm_india.js':    '551a6bd338b032a0240977bfcad8b28fc4413cd15c0ada212d094f501c5eebce',
  'gasm.wasm':        '9f467ba46e9890b2c5855cda60ca331e769f5b76a0a6da7a07bff10f6f1c0401',
  'streamcorner/rauMAbe8.js': '4add0f9b63450bec0198cc04a63bdfaca4993eb2e06e86f84bf3d270de147887',
  'streamcorner/AYGVBDzQ.js': '9d0c7e7ef2c2de5359def5a5b8db555d4dd99548fd5a4a931ef63d4ff5afaa04',
  'streamcorner/BfZQisrQ.js': '21cea7c74668378c4560d34fc3ec5781a7e25b83a1eeab93a3ed2b428ce3d0a1',
  'streamcorner/BQw4J5pZ.js': 'd5b35246369106e117e00ca054d2b813e57be8764bb67d8d364ca45537cdd6f5',
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
