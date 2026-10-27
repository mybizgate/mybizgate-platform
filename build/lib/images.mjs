// Image optimisation: JPG/JPEG/PNG -> WebP where safe. Pure decision logic is exported for tests.
import path from 'node:path';
import { matchesPattern } from './fsutil.mjs';

export const CONVERTIBLE_EXT = new Set(['.jpg', '.jpeg', '.png']);

export const DEFAULT_PRESERVE = [
  'favicon*', 'apple-touch-icon*', 'android-chrome-*', 'mstile-*', 'icon-*.png', '*-icon.png', '*-icon-*.png',
  'maskable-*', 'og-image.*', 'og-*.png', 'og-*.jpg', 'twitter-image.*', 'browserconfig*',
];

/** Collect image paths referenced by web manifests and social-sharing meta tags (kept in original format). */
export function collectProtectedImages(files, readText) {
  const protectedSet = new Set();
  for (const rel of files) {
    const base = path.posix.basename(rel).toLowerCase();
    if (base === 'site.webmanifest' || base === 'manifest.json' || base === 'manifest.webmanifest') {
      try {
        const m = JSON.parse(readText(rel));
        for (const icon of m.icons || []) if (icon && icon.src) protectedSet.add(normalizeRef(icon.src, rel));
      } catch { /* ignore invalid manifests */ }
    } else if (/\.html?$/i.test(rel)) {
      const html = readText(rel);
      const metaRe = /<meta\s+[^>]*(?:property|name)=["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/gi;
      const metaRe2 = /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["']/gi;
      for (const re of [metaRe, metaRe2]) for (const m of html.matchAll(re)) protectedSet.add(normalizeRef(m[1], rel));
      for (const m of html.matchAll(/<link\s+[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon[^"']*|mask-icon)["'][^>]*href=["']([^"']+)["']/gi)) protectedSet.add(normalizeRef(m[1], rel));
      for (const m of html.matchAll(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon[^"']*|mask-icon)["']/gi)) protectedSet.add(normalizeRef(m[1], rel));
    }
  }
  return protectedSet;
}

function normalizeRef(ref, fromRel) {
  const clean = ref.trim().replace(/[?#].*$/, '');
  if (/^[a-z]+:/i.test(clean) || clean.startsWith('//')) return `external:${clean}`;
  if (clean.startsWith('/')) return clean.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), clean));
}

export function shouldConvert(rel, { preserve = [], protectedSet = new Set(), convert = true } = {}) {
  if (!convert) return { convert: false, reason: 'conversion disabled' };
  const ext = path.posix.extname(rel).toLowerCase();
  if (!CONVERTIBLE_EXT.has(ext)) return { convert: false, reason: 'not jpg/png' };
  if (protectedSet.has(rel)) return { convert: false, reason: 'referenced as icon/manifest/social image' };
  for (const p of [...DEFAULT_PRESERVE, ...preserve]) if (matchesPattern(rel, p)) return { convert: false, reason: `preserve pattern ${p}` };
  return { convert: true };
}

export function webpTarget(rel) {
  return rel.replace(/\.(jpe?g|png)$/i, '.webp');
}

/** Convert one image buffer to WebP with sharp; returns null when conversion is not worthwhile. */
export async function convertToWebp(sharp, input, { quality = 82, maxWidth = 1920, png = 'lossy' } = {}) {
  const image = sharp(input, { failOn: 'none' }).rotate();
  const meta = await image.metadata();
  let pipeline = image;
  if (meta.width && meta.width > maxWidth) pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  const isPng = meta.format === 'png';
  const webpOpts = isPng && png === 'lossless' ? { lossless: true, effort: 5 } : { quality, alphaQuality: 100, effort: 4, smartSubsample: true };
  const out = await pipeline.webp(webpOpts).toBuffer();
  return { buffer: out, width: Math.min(meta.width || 0, maxWidth), height: meta.height, format: meta.format, hasAlpha: meta.hasAlpha, resized: Boolean(meta.width && meta.width > maxWidth) };
}
