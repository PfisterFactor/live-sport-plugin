/**
 * Find the first `src="..."` URL in an embed page whose hostname is one of
 * `domains`. Used to detect embed pages that delegate to another provider.
 * Returns the URL string, or null when none matches.
 */
function findEmbedIframe(html, domains) {
  const attrs = html.match(/src="(https?:\/\/[^"]+)"/g);
  if (!attrs) return null;
  for (const attr of attrs) {
    const srcMatch = attr.match(/src="(https?:\/\/[^"]+)"/);
    if (!srcMatch) continue;
    try {
      if (domains.includes(new URL(srcMatch[1]).hostname)) return srcMatch[1];
    } catch (_) {}
  }
  return null;
}

module.exports = { findEmbedIframe };
