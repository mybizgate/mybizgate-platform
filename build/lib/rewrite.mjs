// Rewrite references to converted images and replace cache-busting tokens. Pure functions.
import path from 'node:path';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace references to converted files inside a text file.
 * @param {string} text file contents
 * @param {string} fileRel posix path of the text file relative to the site root
 * @param {Array<{from:string,to:string}>} conversions site-root-relative posix paths
 */
export function rewriteReferences(text, fileRel, conversions) {
  if (!conversions.length) return { text, count: 0 };
  const fileDir = path.posix.dirname(fileRel);
  let count = 0;
  let out = text;
  for (const { from, to } of conversions) {
    const candidates = new Set();
    candidates.add(from);
    candidates.add(`/${from}`);
    candidates.add(`./${from}`);
    let rel = path.posix.relative(fileDir === '.' ? '' : fileDir, from);
    if (rel && !rel.startsWith('.')) { candidates.add(rel); candidates.add(`./${rel}`); } else if (rel) candidates.add(rel);
    const fromExt = path.posix.extname(from);
    const toExt = path.posix.extname(to);
    for (const cand of candidates) {
      const target = cand.slice(0, cand.length - fromExt.length) + toExt;
      const re = new RegExp(`(?<![A-Za-z0-9_./-])${escape(cand)}(?![A-Za-z0-9_.-])`, 'g');
      out = out.replace(re, () => { count += 1; return target; });
    }
  }
  return { text: out, count };
}

export const BUILD_VERSION_TOKEN = '__BUILD_VERSION__';

export function replaceBuildVersion(text, version) {
  if (!text.includes(BUILD_VERSION_TOKEN)) return { text, count: 0 };
  const parts = text.split(BUILD_VERSION_TOKEN);
  return { text: parts.join(version), count: parts.length - 1 };
}

export const BUILD_VERSION_META_NAME = 'build-version';

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function buildVersionMetaTag(version) {
  return `<meta name="${BUILD_VERSION_META_NAME}" content="${escapeAttr(version)}">`;
}

/**
 * Ensure a dist HTML document carries exactly one `<meta name="build-version" content="<version>">`.
 * Existing tags (any attribute order / quoting) are replaced in place; duplicates are removed.
 * When absent, the tag is inserted inside <head>, directly after a leading <meta charset> when present.
 * Source files are never expected to contain the tag; this runs on dist output only.
 */
export function injectBuildVersionMeta(html, version) {
  const tag = buildVersionMetaTag(version);
  const existing = /<meta\b[^>]*\bname\s*=\s*(?:"build-version"|'build-version'|build-version(?=[\s/>]))[^>]*>/gi;
  let count = 0;
  const replaced = html.replace(existing, () => { count += 1; return count === 1 ? tag : ''; });
  if (count > 0) return { text: replaced, action: count > 1 ? 'deduplicated' : 'updated', removed: count - 1 };

  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    let at = head.index + head[0].length;
    const charset = /^\s*<meta\b[^>]*\bcharset\b[^>]*>/i.exec(html.slice(at));
    if (charset) at += charset[0].length;
    return { text: `${html.slice(0, at)}\n${tag}${html.slice(at)}`, action: 'inserted', removed: 0 };
  }
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return { text: `${html.slice(0, at)}\n<head>${tag}</head>${html.slice(at)}`, action: 'inserted', removed: 0 };
  }
  return { text: `${tag}\n${html}`, action: 'inserted', removed: 0 };
}

export function injectNoindex(html) {
  let out = html.replace(/<meta\s+name=["']robots["'][^>]*>\s*/gi, '');
  const tag = '<meta name="robots" content="noindex,nofollow">';
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  return `${tag}\n${out}`;
}

export function rewriteCanonical(html, originUrl) {
  if (!originUrl) return html;
  const origin = originUrl.replace(/\/$/, '');
  return html.replace(/(<link\s+[^>]*rel=["']canonical["'][^>]*href=["'])([^"']+)(["'])/gi, (m, a, href, c) => {
    try {
      const u = new URL(href, `${origin}/`);
      return `${a}${origin}${u.pathname === '/' ? '/' : u.pathname}${u.search}${c}`;
    } catch { return m; }
  }).replace(/(<meta\s+[^>]*property=["']og:url["'][^>]*content=["'])([^"']+)(["'])/gi, (m, a, href, c) => {
    try { const u = new URL(href, `${origin}/`); return `${a}${origin}${u.pathname === '/' ? '/' : u.pathname}${c}`; } catch { return m; }
  });
}

export function stagingRobotsTxt() {
  return 'User-agent: *\nDisallow: /\n';
}
