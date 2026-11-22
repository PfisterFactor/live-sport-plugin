/**
 * SkTechCrypto.js — decryption of the SK Tech app backend payloads.
 *
 * Primary payloads (events.txt, categories.txt, pro/*.txt, app.txt): an
 * alphabet substitution, base64, string reversal, base64, then AES-128-CBC.
 * `tokenApi` payloads use a second AES-128-CBC key pair.
 */

'use strict';

const crypto = require('crypto');

const PRIMARY_KEY = Buffer.from('l2l5kB7xC5qP1rK1', 'utf8');
const PRIMARY_IV = Buffer.from('p1K5nP7uB8hH1l19', 'utf8');
const SECONDARY_KEY = Buffer.from('l2K5wB8xC1wP7rK1', 'utf8');
const SECONDARY_IV = Buffer.from('n0K4nP8uB8hH1l18', 'utf8');

const SUBSTITUTED = 'fFgGjJkKaApPbBmMoOzZeEnNcCdDrRqQtTvVuUxXhHiIwWyYlLsS';
const PLAIN = 'aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ';
const SUBSTITUTION = new Map([...SUBSTITUTED].map((ch, i) => [ch, PLAIN[i]]));

/**
 * Decrypts a primary backend payload.
 * @param {string} rawText  ciphertext as served by the backend
 * @returns {string} plaintext, '' when the input is empty
 * @throws {Error} when the ciphertext cannot be decrypted
 */
function decryptPrimary(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return '';

  let substituted = '';
  for (const ch of text) substituted += SUBSTITUTION.get(ch) || ch;
  const padded = substituted + '='.repeat((4 - (substituted.length % 4)) % 4);

  const reversed = [...Buffer.from(padded, 'base64').toString('utf8')].reverse().join('');
  const cipherBytes = Buffer.from(reversed, 'base64');
  if (cipherBytes.length === 0) return '';

  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', PRIMARY_KEY, PRIMARY_IV);
    return Buffer.concat([decipher.update(cipherBytes), decipher.final()]).toString('utf8');
  } catch (_) {
    // A few payloads carry non-PKCS7 padding; strip it by hand.
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', PRIMARY_KEY, PRIMARY_IV);
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
      const pad = plain[plain.length - 1];
      return (pad && pad <= 16 ? plain.subarray(0, plain.length - pad) : plain).toString('utf8');
    } catch (err) {
      throw new Error(`Failed to decrypt SK Tech payload: ${err.message}`);
    }
  }
}

/**
 * Decrypts a `tokenApi` payload.
 * @param {string|Buffer} cipherData  base64 text or raw bytes
 * @returns {string}
 * @throws {Error} when the ciphertext cannot be decrypted
 */
function decryptSecondary(cipherData) {
  if (!cipherData) return '';
  const bytes = Buffer.isBuffer(cipherData) ? cipherData : Buffer.from(cipherData, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', SECONDARY_KEY, SECONDARY_IV);
  return Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8');
}

module.exports = { decryptPrimary, decryptSecondary };
