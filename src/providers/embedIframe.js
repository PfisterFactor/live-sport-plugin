/**
 * Find the first `src` URL in an embed page whose hostname is one of
 * `domains`. Used to detect embed pages that delegate to another provider.
 * Accepts single- or double-quoted attributes and protocol-relative URLs
 * (normalised to https). Returns the URL string, or null when none matches.
 */
function findEmbedIframe(html, domains) {
  if (!html) return null;
  const attrRegex = /src\s*=\s*(?:"((?:https?:)?\/\/[^"]+)"|'((?:https?:)?\/\/[^']+)')/g;
  let m;
  while ((m = attrRegex.exec(html)) !== null) {
    let src = (m[1] || m[2]).replace(/&amp;/g, '&');
    if (src.startsWith('//')) src = `https:${src}`;
    try {
      if (domains.includes(new URL(src).hostname)) return src;
    } catch (_) {}
  }
  return null;
}

module.exports = { findEmbedIframe };
