/**
 * MpdXml.js — a small XML reader for MPEG-DASH manifests.
 *
 * Supports exactly what MPDs use: elements, quoted attributes, text, CDATA,
 * comments, processing instructions and the five predefined entities plus
 * numeric references. Namespace prefixes are stripped from element names
 * (`cenc:pssh` is `pssh`); attribute names are kept as written. DOCTYPE is
 * refused, so no entity can expand.
 */

'use strict';

const MAX_XML_CHARS = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const ATTR_RE = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Decodes XML character and entity references.
 * @param {string} text
 * @returns {string}
 */
function decode(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, ref) ? ENTITIES[ref] : whole;
  });
}

/**
 * @param {string} qualified
 * @returns {string} the local part of a possibly prefixed name
 */
function localName(qualified) {
  const colon = qualified.indexOf(':');
  return colon < 0 ? qualified : qualified.slice(colon + 1);
}

/**
 * Parses an XML document into `{name, attrs, children, text}` elements.
 * @param {string} xml
 * @returns {{name:string, attrs:Object<string,string>, children:object[], text:string}} the root element
 * @throws {Error} on malformed or oversized input
 */
function parseXml(xml) {
  const src = String(xml);
  if (src.length > MAX_XML_CHARS) throw new Error('XML document too large');

  const stack = [];
  let root = null;
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (stack.length && lt > i) stack[stack.length - 1].text += decode(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0 || !stack.length) throw new Error('bad CDATA section');
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('unterminated processing instruction');
      i = end + 2;
    } else if (src.startsWith('<!', lt)) {
      throw new Error('DOCTYPE and markup declarations are not supported');
    } else if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      if (gt < 0) throw new Error('unterminated end tag');
      const open = stack.pop();
      if (!open || open.name !== localName(src.slice(lt + 2, gt).trim())) throw new Error('mismatched end tag');
      i = gt + 1;
    } else {
      const name = /^[^\s/>]+/.exec(src.slice(lt + 1, lt + 1 + 256));
      if (!name) throw new Error('malformed start tag');
      const node = { name: localName(name[0]), attrs: {}, children: [], text: '' };
      let p = lt + 1 + name[0].length;
      for (;;) {
        ATTR_RE.lastIndex = p;
        const attr = ATTR_RE.exec(src);
        if (!attr) break;
        node.attrs[attr[1]] = decode(attr[2] !== undefined ? attr[2] : attr[3]);
        p = ATTR_RE.lastIndex;
      }
      while (p < src.length && /\s/.test(src[p])) p++;
      const selfClosing = src[p] === '/';
      if (selfClosing) p++;
      if (src[p] !== '>') throw new Error('malformed start tag');
      i = p + 1;

      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (root) throw new Error('multiple root elements');
      else root = node;
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new Error('XML nesting too deep');
        stack.push(node);
      }
    }
  }

  if (!root || stack.length) throw new Error('unterminated XML document');
  return root;
}

/**
 * @param {{children: object[]}|null|undefined} node
 * @param {string} name
 * @returns {object[]} direct children with that name
 */
function childrenNamed(node, name) {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/**
 * @param {{children: object[]}|null|undefined} node
 * @param {string} name
 * @returns {object|null} first direct child with that name
 */
function firstChild(node, name) {
  return node ? node.children.find((c) => c.name === name) || null : null;
}

module.exports = { parseXml, childrenNamed, firstChild };
