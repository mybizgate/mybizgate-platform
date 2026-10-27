// Template library discovery and validation.
//
// Reusable website templates live in the workspace-level templates/ directory:
//
//   templates/<business-type>/<template>/
//
// Both levels are discovered from the filesystem every time the wizard runs; nothing is
// hardcoded. A template directory that contains only .gitkeep (or no files at all) is a
// placeholder: it is listed and can be dry-run, but it cannot generate a client website.
// Optional metadata lives in template.yml (name, version, description, ...).
//
// A template reference ("ref") is the path form "<business-type>/<template>", for example
// "pet-boarding/modern-01". It is the identity stored in the client's site.config.yml.
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { PlatformError, exists } from './utils.mjs';
import { WORKSPACE_DIR, DEMO_SITES } from './config.mjs';

export const TEMPLATES_DIR_ENV_VAR = 'MYBIZGATE_TEMPLATES_DIR';
export const TEMPLATE_METADATA_FILE = 'template.yml';
export const BLANK_TEMPLATE = 'blank';
// Demo-site names were accepted as templates by earlier platform versions. They still work for
// CLI compatibility but are deprecated: real templates live in templates/.
export const LEGACY_TEMPLATES = [...DEMO_SITES];

export const TEMPLATE_STATUS = Object.freeze({ READY: 'ready', PLACEHOLDER: 'placeholder', INCOMPLETE: 'incomplete' });

const SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TEMPLATE_REF_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
// Files that may sit in a template directory without counting as website source.
const NON_SOURCE_FILES = new Set(['.gitkeep', TEMPLATE_METADATA_FILE, 'README.md', 'README.txt', 'LICENSE', '.DS_Store']);
const NON_SOURCE_PREFIXES = ['preview.'];
// Never copied into a client project.
export const TEMPLATE_COPY_EXCLUDES = ['.gitkeep', TEMPLATE_METADATA_FILE, 'README.md', 'README.txt', 'LICENSE', 'preview.*', '.git', 'node_modules', 'dist', '.DS_Store', 'site.config.yml'];

export function templatesDir(env = process.env) {
  const override = env[TEMPLATES_DIR_ENV_VAR];
  return override ? path.resolve(override) : path.join(WORKSPACE_DIR, 'templates');
}

// "pet-boarding" -> "Pet Boarding", "modern-01" -> "Modern 01", "general_business" -> "General Business"
export function humanize(name) {
  return String(name || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function listDirs(root) {
  if (!isDir(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function isSourceFile(rel) {
  const base = path.posix.basename(rel);
  if (NON_SOURCE_FILES.has(base)) return false;
  if (NON_SOURCE_PREFIXES.some((p) => base.startsWith(p))) return false;
  return true;
}

// Count website source files (recursively), ignoring metadata/placeholder files.
export function countSourceFiles(dir) {
  let count = 0;
  const visit = (d, relBase) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(d, e.name), rel);
      else if (e.isFile() && isSourceFile(rel)) count += 1;
    }
  };
  if (isDir(dir)) visit(dir, '');
  return count;
}

// ---------------------------------------------------------------------------
// Metadata (template.yml)
// ---------------------------------------------------------------------------
export function readTemplateMetadata(dir, { ref } = {}) {
  const file = path.join(dir, TEMPLATE_METADATA_FILE);
  const warnings = [];
  if (!exists(file)) return { metadata: null, warnings };
  let data;
  try {
    data = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    warnings.push(`${file}: could not parse (${err.message.split('\n')[0]}); using folder name`);
    return { metadata: null, warnings };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    warnings.push(`${file}: expected a mapping; using folder name`);
    return { metadata: null, warnings };
  }
  const metadata = {};
  for (const key of ['id', 'name', 'category', 'version', 'description', 'origin']) {
    const v = data[key];
    if (v == null) continue;
    if (typeof v !== 'string' && typeof v !== 'number') { warnings.push(`${file}: "${key}" must be a string; ignored`); continue; }
    metadata[key] = String(v).trim();
  }
  // Structured sections used by the personalisation engine.
  for (const key of ['features', 'defaults', 'notes']) {
    const v = data[key];
    if (v == null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) { warnings.push(`${file}: "${key}" must be a mapping; ignored`); continue; }
    metadata[key] = Object.fromEntries(Object.entries(v).map(([k, val]) => [k, typeof val === 'object' && val !== null ? val : String(val)]));
  }
  for (const key of ['required_content', 'optional_content', 'residue']) {
    const v = data[key];
    if (v == null) continue;
    if (!Array.isArray(v)) { warnings.push(`${file}: "${key}" must be a list; ignored`); continue; }
    metadata[key] = v.filter((x) => x != null && String(x).trim()).map((x) => String(x).trim());
  }
  if (metadata.name && (metadata.name.length > 80 || /[\x00-\x1f<>`$\\]/.test(metadata.name))) {
    warnings.push(`${file}: "name" is too long or contains unsafe characters; using folder name`);
    delete metadata.name;
  }
  if (metadata.version && !VERSION_RE.test(metadata.version)) {
    warnings.push(`${file}: version "${metadata.version}" is not a valid semantic version; recorded as null`);
    delete metadata.version;
  }
  if (ref && metadata.category && metadata.category !== ref.split('/')[0]) {
    warnings.push(`${file}: category "${metadata.category}" does not match folder "${ref.split('/')[0]}"`);
  }
  return { metadata, warnings };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
export function discoverCategories({ root = templatesDir() } = {}) {
  return listDirs(root)
    .filter((name) => SEGMENT_RE.test(name))
    .map((id) => ({ id, name: humanize(id), dir: path.join(root, id), templateCount: listDirs(path.join(root, id)).filter((t) => SEGMENT_RE.test(t)).length }));
}

export function describeTemplate(ref, dir) {
  const [category, folder] = ref.split('/');
  const { metadata, warnings } = readTemplateMetadata(dir, { ref });
  const files = countSourceFiles(dir);
  const hasIndex = exists(path.join(dir, 'index.html'));
  const status = hasIndex ? TEMPLATE_STATUS.READY : files === 0 ? TEMPLATE_STATUS.PLACEHOLDER : TEMPLATE_STATUS.INCOMPLETE;
  return {
    ref,
    id: ref,
    category,
    categoryName: humanize(category),
    folder,
    name: (metadata && metadata.name) || humanize(folder),
    description: (metadata && metadata.description) || '',
    version: (metadata && metadata.version) || null,
    dir,
    status,
    placeholder: status !== TEMPLATE_STATUS.READY,
    usable: status === TEMPLATE_STATUS.READY,
    files,
    metadata,
    warnings,
    legacy: false,
  };
}

export function discoverTemplates(categoryId, { root = templatesDir() } = {}) {
  if (!SEGMENT_RE.test(String(categoryId || ''))) throw new PlatformError(`Invalid business type "${categoryId}".`, { code: 'INVALID_TEMPLATE' });
  const catDir = path.join(root, categoryId);
  if (!isDir(catDir)) {
    const available = discoverCategories({ root }).map((c) => c.id);
    throw new PlatformError(`Unknown business type "${categoryId}".`, { code: 'INVALID_TEMPLATE', hint: available.length ? `Available: ${available.join(', ')} (from ${root})` : `No business types found in ${root}` });
  }
  return listDirs(catDir).filter((t) => SEGMENT_RE.test(t)).map((folder) => describeTemplate(`${categoryId}/${folder}`, path.join(catDir, folder)));
}

export function discoverAllTemplates({ root = templatesDir() } = {}) {
  return discoverCategories({ root }).flatMap((c) => discoverTemplates(c.id, { root }));
}

// Resolve a template reference given on the CLI or chosen in the wizard.
// Accepts "<business-type>/<template>" from the library, "blank" (built-in starter) and,
// for compatibility only, a legacy demo-site name.
export function resolveTemplate(ref, { root = templatesDir() } = {}) {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) throw new PlatformError('Template is required.', { code: 'INVALID_TEMPLATE', hint: 'Use --template <business-type>/<template> (run "mybizgate templates" to list them) or --template blank.' });
  if (value === BLANK_TEMPLATE) {
    return { ref: BLANK_TEMPLATE, id: BLANK_TEMPLATE, category: null, categoryName: 'Built-in', folder: BLANK_TEMPLATE, name: 'Blank starter', description: 'Minimal coming-soon page generated by the platform.', version: null, dir: null, status: TEMPLATE_STATUS.READY, placeholder: false, usable: true, files: 3, metadata: null, warnings: [], legacy: false, builtin: true };
  }
  if (LEGACY_TEMPLATES.includes(value)) {
    const dir = path.join(WORKSPACE_DIR, value);
    const usable = exists(path.join(dir, 'index.html'));
    return { ref: value, id: value, category: null, categoryName: 'Legacy demo', folder: value, name: `${humanize(value)} (legacy demo source)`, description: `Copy of the ${value}/ demo site. Deprecated: use templates/<business-type>/<template>.`, version: null, dir, status: usable ? TEMPLATE_STATUS.READY : TEMPLATE_STATUS.INCOMPLETE, placeholder: !usable, usable, files: usable ? countSourceFiles(dir) : 0, metadata: null, warnings: [`Template "${value}" copies the ${value}/ demo site directly; this is deprecated. Prefer a template under templates/.`], legacy: true };
  }
  const m = TEMPLATE_REF_RE.exec(value);
  if (!m || value.includes('..')) {
    throw new PlatformError(`Invalid template "${value}". Use the form <business-type>/<template>, for example pet-boarding/modern-01.`, { code: 'INVALID_TEMPLATE', hint: 'Run "mybizgate templates" to list the template library.' });
  }
  const dir = path.join(root, m[1], m[2]);
  if (!isDir(dir)) {
    const all = discoverAllTemplates({ root }).map((t) => t.ref);
    const sameCategory = all.filter((r) => r.startsWith(`${m[1]}/`));
    const hint = sameCategory.length ? `Templates for ${m[1]}: ${sameCategory.join(', ')}` : all.length ? `Available templates: ${all.join(', ')}` : `No templates found in ${root}`;
    throw new PlatformError(`Unknown template "${value}" (no directory ${dir}).`, { code: 'INVALID_TEMPLATE', hint });
  }
  return describeTemplate(value, dir);
}

export function templateStatusText(t) {
  if (t.builtin) return 'built-in';
  if (t.status === TEMPLATE_STATUS.READY) return `ready, ${t.files} source file(s)${t.version ? `, v${t.version}` : ''}`;
  if (t.status === TEMPLATE_STATUS.PLACEHOLDER) return 'placeholder, no website source yet';
  return `incomplete, ${t.files} file(s) but no index.html`;
}

export const PLACEHOLDER_WARNING = (ref) => `Template ${ref} currently contains no website source files.`;
export const PLACEHOLDER_STOP_LINES = [
  'Selected template is currently a placeholder template.',
  'Client website source cannot be generated until the template is populated.',
];
