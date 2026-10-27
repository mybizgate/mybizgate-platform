// Filesystem helpers and a small glob matcher for exclude/preserve patterns.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_EXCLUDES = [
  '.git', '.github', '.gitignore', '.gitattributes', '.editorconfig', '.mybizgate', '.vscode', '.idea',
  'node_modules', 'dist', 'docs', 'tests', 'test', 'screenshots', 'build-report.json',
  'README.md', 'README.txt', 'readme.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'CHANGELOG.md',
  'site.config.yml', 'site.config.example.yml', '.mybizgate.local.yml', 'template.yml', 'package.json', 'package-lock.json',
  '.env', '.env.*', '*.log', '.ftp-deploy-sync-state.json', '.DS_Store', 'Thumbs.db', '*.psd', '*.xcf', '*.sketch', '*.fig',
  '.htpasswd', '*.pem', '*.key', 'id_rsa*', '*.bak', '*.orig', '*.swp', '*~',
];

export const RUNTIME_FILES_NEVER_EXCLUDED = ['.htaccess', 'robots.txt', 'sitemap.xml', 'site.webmanifest', 'manifest.json', 'favicon.ico', '.well-known'];

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** Match a posix relative path against a pattern (no slash => matches basename or any path segment prefix). */
export function matchesPattern(relPath, pattern) {
  const p = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  if (!p) return false;
  const re = globToRegExp(p);
  if (p.includes('/')) {
    return re.test(relPath) || relPath.startsWith(`${p}/`);
  }
  const segments = relPath.split('/');
  return segments.some((s) => re.test(s));
}

export function isExcluded(relPath, patterns) {
  const base = path.posix.basename(relPath);
  if (RUNTIME_FILES_NEVER_EXCLUDED.includes(base) || relPath.startsWith('.well-known/')) return false;
  return patterns.some((p) => matchesPattern(relPath, p));
}

export function walk(root, { exclude = [] } = {}) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (isExcluded(rel, exclude)) continue;
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(root);
  return out.sort();
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
export function readText(p) { return fs.readFileSync(p, 'utf8'); }
export function writeText(p, text) { ensureDir(path.dirname(p)); fs.writeFileSync(p, text); }
export function fileSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }
export function fmt(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`; }
