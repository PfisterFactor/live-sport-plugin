/**
 * cenc/boxes.js — minimal ISO BMFF (ISO/IEC 14496-12) box reader.
 *
 * Boxes are descriptors over the caller's Buffer, never copies. Accessors are
 * bounds-checked and return null instead of throwing; init.js and segment.js
 * decide whether a missing box is fatal.
 */

'use strict';

/**
 * Reads one box header at `off`.
 * @param {Buffer} buf
 * @param {number} off
 * @param {number} end  exclusive end of the enclosing container
 * @returns {{type:string,size:number,start:number,body:number,end:number}|null}
 *   `body` is the first byte after the header, `end` is `start + size`.
 */
function readBox(buf, off, end) {
  if (off + 8 > end) return null;
  let size = buf.readUInt32BE(off);
  const type = buf.toString('latin1', off + 4, off + 8);
  let headerSize = 8;

  if (size === 1) {
    if (off + 16 > end) return null;
    size = buf.readUInt32BE(off + 8) * 2 ** 32 + buf.readUInt32BE(off + 12);
    headerSize = 16;
  } else if (size === 0) {
    size = end - off;
  }

  if (size < headerSize || off + size > end) return null;
  return { type, size, start: off, body: off + headerSize, end: off + size };
}

/**
 * Iterates the direct children of [start, end).
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {Generator<object>}
 */
function* children(buf, start, end) {
  let off = start;
  while (off + 8 <= end) {
    const box = readBox(buf, off, end);
    if (!box) return;
    yield box;
    off = box.end;
  }
}

/**
 * First direct child of `parent` with the given type.
 * @param {Buffer} buf
 * @param {object|null} parent  box descriptor, or `{body, end}` for the top level
 * @param {string} type
 * @returns {object|null}
 */
function findChild(buf, parent, type) {
  if (!parent) return null;
  for (const child of children(buf, parent.body, parent.end)) {
    if (child.type === type) return child;
  }
  return null;
}

/**
 * All direct children of `parent` with the given type.
 * @param {Buffer} buf
 * @param {object|null} parent
 * @param {string} type
 * @returns {object[]}
 */
function findChildren(buf, parent, type) {
  const out = [];
  if (!parent) return out;
  for (const child of children(buf, parent.body, parent.end)) {
    if (child.type === type) out.push(child);
  }
  return out;
}

/**
 * First top-level box of `type`.
 * @param {Buffer} buf
 * @param {string} type
 * @returns {object|null}
 */
function findTop(buf, type) {
  return findChild(buf, { body: 0, end: buf.length }, type);
}

/**
 * All top-level boxes of `type`.
 * @param {Buffer} buf
 * @param {string} type
 * @returns {object[]}
 */
function findTops(buf, type) {
  return findChildren(buf, { body: 0, end: buf.length }, type);
}

/**
 * Depth-first collection of every descendant of `parent` whose type is in
 * `types`, at any level. `mdat`, `free` and `skip` are never descended into.
 * @param {Buffer} buf
 * @param {object|null} parent
 * @param {string|string[]} types
 * @param {object[]} [out]
 * @returns {object[]}
 */
function collect(buf, parent, types, out = []) {
  const wanted = typeof types === 'string' ? new Set([types]) : new Set(types);
  if (!parent) return out;
  for (const child of children(buf, parent.body, parent.end)) {
    if (wanted.has(child.type)) out.push(child);
    if (child.type === 'mdat' || child.type === 'free' || child.type === 'skip') continue;
    collect(buf, child, wanted, out);
  }
  return out;
}

/**
 * Rewrites a box type in place. Size, position and payload are untouched.
 * @param {Buffer} buf
 * @param {object} box
 * @param {string} type  four characters
 */
function writeType(buf, box, type) {
  buf.write(type, box.start + 4, 4, 'latin1');
}

/**
 * Version byte of a FullBox.
 * @param {Buffer} buf
 * @param {object|null} box
 * @returns {number}
 */
function version(buf, box) {
  return box && box.body < box.end ? buf[box.body] : 0;
}

/**
 * 24-bit flags of a FullBox.
 * @param {Buffer} buf
 * @param {object|null} box
 * @returns {number}
 */
function flags(buf, box) {
  return box && box.body + 4 <= box.end ? buf.readUIntBE(box.body + 1, 3) : 0;
}

module.exports = {
  readBox,
  children,
  findChild,
  findChildren,
  findTop,
  findTops,
  collect,
  writeType,
  version,
  flags
};
