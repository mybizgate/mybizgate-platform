// Validation of a built dist/ directory: existence, local references, internal anchors.
import fs from 'node:fs';
import path from 'node:path';
import { walk, readText } from './fsutil.mjs';

const ATTR_RE = /\b(?:src|href|poster|data-src|data-srcset|srcset|content)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;

export function isLocalReference(ref) {
  if (!ref) return false;
  const r = ref.trim();
  if (!r || r.startsWith('#') || r.startsWith('data:') || r.startsWith('blob:')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return false; // http:, https:, mailto:, tel:, javascript:, whatsapp:
  if (r.startsWith('//')) return false;
  if (r.startsWith('{') || r.includes('${')) return false; // template placeholders
  return true;
}

export function extractReferences(text, kind) {
  const refs = [];
  if (kind === 'html') {
    for (const m of text.matchAll(ATTR_RE)) {
      const attr = m[0].split('=')[0].trim().toLowerCase();
      const value = m[2] ?? m[3] ?? '';
      if (attr === 'content') {
        // only image-ish meta content (og:image etc.) is a file reference
        if (!/\.(png|jpe?g|webp|gif|svg|ico|avif)(\?|$)/i.test(value)) continue;
      }
      if (attr === 'srcset' || attr === 'data-srcset') {
        for (const part of value.split(',')) { const url = part.trim().split(/\s+/)[0]; if (url) refs.push({ ref: url, attr }); }
      } else refs.push({ ref: value, attr });
    }
    for (const m of text.matchAll(/style\s*=\s*"([^"]*)"/gi)) for (const u of m[1].matchAll(CSS_URL_RE)) refs.push({ ref: u[1] ?? u[2] ?? u[3], attr: 'style' });
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) for (const u of m[1].matchAll(CSS_URL_RE)) refs.push({ ref: u[1] ?? u[2] ?? u[3], attr: 'style' });
  } else if (kind === 'css') {
    for (const u of text.matchAll(CSS_URL_RE)) refs.push({ ref: u[1] ?? u[2] ?? u[3], attr: 'url' });
  }
  return refs;
}

export function resolveLocalReference(ref, fileRel, root) {
  const clean = ref.trim().replace(/[?#].*$/, '');
  if (!clean) return null;
  const base = clean.startsWith('/') ? path.join(root, clean) : path.join(root, path.posix.dirname(fileRel), clean);
  return path.normalize(base);
}

export function validateDist(root) {
  const errors = [];
  const warnings = [];
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) { errors.push('dist/index.html does not exist'); return { ok: false, errors, warnings, checked: 0 }; }
  const files = walk(root);
  let checked = 0;
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!['.html', '.htm', '.css'].includes(ext)) continue;
    const text = readText(path.join(root, rel));
    const kind = ext === '.css' ? 'css' : 'html';
    if (kind === 'html') {
      if (!/<html[\s>]/i.test(text) || !/<\/html>/i.test(text)) errors.push(`${rel}: not a complete HTML document (missing <html> or </html>)`);
      if (!/<title[\s>]/i.test(text)) warnings.push(`${rel}: missing <title>`);
      if (!/<body[\s>]/i.test(text)) warnings.push(`${rel}: missing <body>`);
      const ids = new Set([...text.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
      for (const m of text.matchAll(/href\s*=\s*["']#([^"']+)["']/g)) {
        if (!ids.has(m[1])) warnings.push(`${rel}: internal link #${m[1]} has no matching id`);
      }
    }
    for (const { ref, attr } of extractReferences(text, kind)) {
      if (!isLocalReference(ref)) continue;
      const target = resolveLocalReference(ref, rel, root);
      if (!target) continue;
      checked += 1;
      const inside = path.resolve(target).startsWith(path.resolve(root));
      if (!inside) { errors.push(`${rel}: ${attr} "${ref}" escapes the site root`); continue; }
      if (fs.existsSync(target)) continue;
      if (fs.existsSync(path.join(target, 'index.html'))) continue;
      if (/\.(html?|php)$/i.test(ref) === false && attr === 'href' && !path.extname(target)) { warnings.push(`${rel}: link "${ref}" has no local target (may be a route)`); continue; }
      errors.push(`${rel}: ${attr} "${ref}" -> missing file`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, checked, files: files.length };
}
