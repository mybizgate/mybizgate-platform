// Personalisation engine: fills template tokens with the client's business information,
// and the residue scanner that proves no source-design branding survived.
//
// Token syntax inside template files:
//   {{KEY}}            value, HTML-escaped (safe in text and attributes)
//   {{KEY|js}}         value escaped for a JavaScript/JSON string literal
//   {{KEY|url}}        value encoded with encodeURIComponent
//   {{KEY|raw}}        value verbatim
//   {{#KEY}}...{{/KEY}} block kept only when KEY is non-empty
//   {{^KEY}}...{{/KEY}} block kept only when KEY is empty
// Keys are UPPER_SNAKE_CASE. A token with no value is an error (reported as residue), so a
// generated site can never ship with an unfilled placeholder.
import fs from 'node:fs';
import path from 'node:path';
import { PlatformError } from './utils.mjs';

export const TOKEN_RE = /\{\{([#^/]?)([A-Z][A-Z0-9_]*)(?:\|(html|js|url|raw))?\}\}/g;
const BLOCK_RE = /\{\{([#^])([A-Z][A-Z0-9_]*)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
// Files whose contents are personalised and scanned.
export const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.webmanifest', '.xml', '.txt', '.svg', '.md', '.yml', '.yaml', '.htaccess']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.mybizgate']);
// Generic words dropped from the end of a business name to form the short name.
const GENERIC_TAIL = new Set(['cat', 'cats', 'pet', 'pets', 'hotel', 'boarding', 'daycare', 'grooming', 'resort', 'retreat', 'centre', 'center', 'studio', 'house', 'home', 'lodge', 'inn', 'villa', 'clinic', 'care', 'sdn', 'bhd', 'enterprise', 'plt', 'the', 'and', '&']);

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const escapeJs = (s) => JSON.stringify(String(s)).slice(1, -1).replace(/<\/script/gi, '<\\/script');

// "Paw Haven Cat Hotel" -> "Paw Haven"; "PetGate" -> "PetGate"; "Cat Hotel KL" -> "Cat Hotel KL"
export function deriveShortName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 2) return words.join(' ');
  const kept = [...words];
  while (kept.length > 1 && GENERIC_TAIL.has(kept[kept.length - 1].toLowerCase().replace(/[.,]/g, ''))) kept.pop();
  const onlyStopword = kept.length === 1 && /^(the|a|an|my|our|de|di)$/i.test(kept[0]);
  return kept.length < words.length && !onlyStopword ? kept.join(' ') : words.slice(0, 2).join(' ');
}

// "12 Jalan Ampang, 55100 Kuala Lumpur" -> "Kuala Lumpur"; "Kuala Lumpur" -> "Kuala Lumpur"
export function deriveLocality(address) {
  const parts = String(address || '').split(/[,\n]/).map((p) => p.replace(/\b\d{4,6}\b/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length) return '';
  const last = parts[parts.length - 1];
  // Skip a trailing country name when there is a city before it.
  if (parts.length >= 2 && /^(malaysia|singapore|brunei|indonesia)$/i.test(last)) return parts[parts.length - 2];
  return last;
}

export function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words.slice(0, 2).map((w) => w[0]) : [...String(words[0] || '').slice(0, 2)];
  return letters.join('').toUpperCase();
}

// Accepts a full URL or a handle (with or without @) and returns a URL, or '' when empty.
export function socialUrl(network, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '').replace(/^.*\//, '');
  if (!handle) return '';
  return { facebook: `https://www.facebook.com/${handle}`, instagram: `https://www.instagram.com/${handle}`, tiktok: `https://www.tiktok.com/@${handle}` }[network] || '';
}

const digits = (s) => String(s || '').replace(/\D/g, '');

/**
 * Build the token context for a client from its validated site config and the template record.
 * `template.metadata.defaults` may reference tokens; they are rendered against the base context.
 */
export function buildContext(cfg, template = {}) {
  const b = cfg.business || {};
  const meta = (template && template.metadata) || {};
  const defaults = (meta.defaults && typeof meta.defaults === 'object') ? meta.defaults : {};
  const name = cfg.client.name;
  const shortName = b.short_name || deriveShortName(name);
  const whatsapp = b.whatsapp || '';
  const phone = b.phone || whatsapp;
  const address = b.address || '';
  const locality = b.locality || deriveLocality(address) || '';
  const productionUrl = String(cfg.site.production_url || '').replace(/\/$/, '');
  const encAddress = encodeURIComponent(address);
  const socials = { FACEBOOK_URL: socialUrl('facebook', b.facebook), INSTAGRAM_URL: socialUrl('instagram', b.instagram), TIKTOK_URL: socialUrl('tiktok', b.tiktok) };
  const socialList = Object.values(socials).filter(Boolean);
  const ctx = {
    BUSINESS_NAME: name,
    SHORT_NAME: shortName,
    INITIALS: initialsOf(shortName),
    SLUG: cfg.client.slug,
    DOMAIN: cfg.domain.primary,
    PRODUCTION_URL: productionUrl,
    WHATSAPP: whatsapp,
    WHATSAPP_DIGITS: digits(whatsapp),
    PHONE: phone,
    PHONE_TEL: normalizeTel(phone, whatsapp),
    EMAIL: b.email || '',
    ADDRESS: address,
    LOCALITY: locality,
    OPENING_HOURS: b.opening_hours || '',
    FACEBOOK: b.facebook || '',
    INSTAGRAM: b.instagram || '',
    TIKTOK: b.tiktok || '',
    ...socials,
    SOCIAL_JSON: socialList.map((u) => JSON.stringify(u)).join(','),
    MAPS_URL: address ? `https://www.google.com/maps/search/?api=1&query=${encAddress}` : '',
    MAPS_EMBED_URL: address ? `https://www.google.com/maps?q=${encAddress}&z=16&output=embed` : '',
    MAPS_DIRECTIONS_URL: address ? `https://www.google.com/maps/dir/?api=1&destination=${encAddress}` : '',
    TAGLINE: '',
    SEO_TITLE: b.seo_title || '',
    SEO_DESCRIPTION: b.seo_description || '',
  };
  // Template defaults (may contain tokens) fill whatever is still empty.
  for (const [key, value] of Object.entries(defaults)) {
    const K = String(key).toUpperCase();
    if (ctx[K] === undefined || ctx[K] === '') ctx[K] = renderText(String(value), ctx, { escape: 'raw' }).text;
  }
  if (!ctx.SEO_TITLE) ctx.SEO_TITLE = name;
  if (!ctx.SEO_DESCRIPTION) ctx.SEO_DESCRIPTION = `${name} - website by MyBizGate.`;
  return ctx;
}

function normalizeTel(phone, whatsapp) {
  const src = phone || whatsapp;
  if (!src) return '';
  let d = digits(src);
  if (!d) return '';
  if (/^\+/.test(src.trim())) return `+${d}`;
  if (d.startsWith('0')) d = `60${d.slice(1)}`;
  else if (d.startsWith('00')) d = d.slice(2);
  return `+${d}`;
}

/**
 * Render tokens in `text`. Returns { text, used, missing }. Missing keys are left in place so the
 * residue scan reports them with file and line; callers may also treat `missing` as an error.
 */
export function renderText(text, ctx, { escape = 'html' } = {}) {
  const used = new Set();
  const missing = new Set();
  const has = (k) => ctx[k] !== undefined && ctx[k] !== null && String(ctx[k]) !== '';
  let out = String(text);
  // Conditional blocks (repeat until stable to allow blocks inside blocks of other keys).
  for (let i = 0; i < 5; i += 1) {
    const before = out;
    out = out.replace(BLOCK_RE, (m, kind, key, body) => {
      if (!(key in ctx)) { missing.add(key); return m; }
      used.add(key);
      const keep = kind === '#' ? has(key) : !has(key);
      return keep ? body : '';
    });
    if (out === before) break;
  }
  out = out.replace(TOKEN_RE, (m, kind, key, filter) => {
    if (kind) return m; // stray block marker, reported as residue
    if (!(key in ctx)) { missing.add(key); return m; }
    used.add(key);
    const v = ctx[key] == null ? '' : String(ctx[key]);
    const f = filter || escape;
    if (f === 'js') return escapeJs(v);
    if (f === 'url') return encodeURIComponent(v);
    if (f === 'raw') return v;
    return escapeHtml(v);
  });
  return { text: out, used, missing };
}

function listTextFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) visit(abs);
      else if (e.isFile() && (TEXT_EXTENSIONS.has(path.extname(e.name).toLowerCase()) || e.name === '.htaccess')) out.push(abs);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out.sort();
}

/** Apply the context to every text file under `dir` that contains tokens. */
export function personalizeProject(dir, ctx) {
  const files = [];
  const used = new Set();
  const missing = new Map();
  for (const abs of listTextFiles(dir)) {
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes('{{')) continue;
    const r = renderText(text, ctx);
    if (r.text !== text) fs.writeFileSync(abs, r.text);
    if (!r.used.size && !r.missing.size) continue; // e.g. GitHub's ${{ }} syntax, not our tokens
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    files.push(rel);
    for (const k of r.used) used.add(k);
    for (const k of r.missing) missing.set(k, [...(missing.get(k) || []), rel]);
  }
  return { files, tokens: [...used].sort(), missing: [...missing.entries()].map(([key, where]) => ({ key, files: where })) };
}

// Which template-required content is missing from the config (template.yml required_content).
export function missingRequiredContent(template, cfg) {
  const required = (template && template.metadata && Array.isArray(template.metadata.required_content)) ? template.metadata.required_content : [];
  const b = cfg.business || {};
  const present = { business_name: Boolean(cfg.client && cfg.client.name), whatsapp: Boolean(b.whatsapp), email: Boolean(b.email), address: Boolean(b.address), phone: Boolean(b.phone), opening_hours: Boolean(b.opening_hours) };
  return required.filter((k) => !(k in present ? present[k] : Boolean(b[k])));
}

// Residue patterns: template.yml `residue` list (literal, case-insensitive) plus, for legacy demo
// copies, the demo name itself. Unfilled tokens are always residue.
export function residuePatternsFor(template) {
  const out = [];
  const list = template && template.metadata && Array.isArray(template.metadata.residue) ? template.metadata.residue : [];
  for (const p of list) if (p != null && String(p).trim()) out.push(String(p).trim());
  if (template && template.legacy) out.push(template.ref);
  return out;
}

/**
 * Scan a generated project for source-template branding and unfilled tokens.
 * Returns { ok, findings: [{ file, line, match }] }.
 */
export function scanResidue(dir, { patterns = [], maxPerFile = 5, ignore = [] } = {}) {
  const findings = [];
  const ignored = new Set(ignore);
  const literal = patterns.map((p) => ({ label: p, re: new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));
  const tokenRe = /\{\{[#^/]?[A-Z][A-Z0-9_]*(?:\|[a-z]+)?\}\}/;
  const check = (file, lineNo, line) => {
    for (const { label, re } of literal) { const m = re.exec(line); if (m) findings.push({ file, line: lineNo, match: m[0], pattern: label }); }
    const t = tokenRe.exec(line); if (t) findings.push({ file, line: lineNo, match: t[0], pattern: 'unfilled token' });
  };
  for (const abs of listTextFiles(dir)) {
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    if (ignored.has(rel) || ignored.has(path.basename(rel))) continue;
    const before = findings.length;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    for (let i = 0; i < lines.length && findings.length - before < maxPerFile; i += 1) check(rel, i + 1, lines[i]);
  }
  // File and directory names too (e.g. images/petgate-hero.webp).
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || ignored.has(e.name)) continue;
      const rel = path.relative(dir, path.join(d, e.name)).split(path.sep).join('/');
      for (const { label, re } of literal) if (re.test(e.name)) findings.push({ file: rel, line: 0, match: e.name, pattern: label });
      if (e.isDirectory()) visit(path.join(d, e.name));
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return { ok: findings.length === 0, findings };
}

export function formatResidue(findings, { limit = 12 } = {}) {
  const lines = findings.slice(0, limit).map((f) => `${f.file}${f.line ? `:${f.line}` : ''}: ${f.match}${f.pattern === 'unfilled token' ? ' (unfilled token)' : ''}`);
  if (findings.length > limit) lines.push(`... ${findings.length - limit} more`);
  return lines;
}

export function assertNoResidue(dir, template) {
  const r = scanResidue(dir, { patterns: residuePatternsFor(template) });
  if (!r.ok) {
    throw new PlatformError(`Template personalisation incomplete\n${formatResidue(r.findings).join('\n')}`, { code: 'TEMPLATE_RESIDUE', hint: 'The generated site still carries source-template branding or unfilled tokens. Fix the template or the client information; nothing remote was created.' });
  }
  return r;
}
