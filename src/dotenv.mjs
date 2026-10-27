// Workspace .env discovery and loading.
//
// The MyBizGate workspace root (the directory that contains platform/, the Gate
// demos and clients/) holds a single, gitignored .env file. Every CLI command
// loads it automatically so `source .env` is no longer required. The file may
// be written in POSIX (`KEY=value`, `export KEY=value`) or Fish
// (`set -gx KEY "value"`) syntax. Variables already exported in the shell
// always take precedence over the file. Values are never logged; callers only
// receive variable names for reporting.
import fs from 'node:fs';
import path from 'node:path';
import { registerSecret } from './utils.mjs';

export const DOTENV_FILE = '.env';
export const WORKSPACE_ENV_VAR = 'MYBIZGATE_WORKSPACE_DIR';
export const DOTENV_ENV_VAR = 'MYBIZGATE_DOTENV';
export const DOTENV_TRACE_VAR = 'MYBIZGATE_DOTENV_TRACE';
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', 'none']);
const SECRET_KEY_RE = /(TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_KEY|API_KEY)$/i;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// A workspace root is a directory whose platform/ folder contains the CLI.
export function isWorkspaceRoot(dir) {
  return isDir(dir) && isFile(path.join(dir, 'platform', 'src', 'cli.mjs')) && isFile(path.join(dir, 'platform', 'package.json'));
}

// Resolution order:
//   1. $MYBIZGATE_WORKSPACE_DIR when it points at a workspace root
//   2. the parent directory of the platform checkout (the normal layout)
//   3. walking up from the current directory (platform symlinked elsewhere)
export function findWorkspaceRoot({ platformDir, cwd = process.cwd(), env = process.env } = {}) {
  const override = env[WORKSPACE_ENV_VAR];
  if (override) {
    const dir = path.resolve(override);
    if (isWorkspaceRoot(dir)) return dir;
  }
  if (platformDir) {
    const parent = path.resolve(platformDir, '..');
    if (isWorkspaceRoot(parent)) return parent;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    if (isWorkspaceRoot(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return platformDir ? path.resolve(platformDir, '..') : null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
function expand(value, lookup) {
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, braced, bare) => {
    const v = lookup(braced || bare);
    return v == null ? '' : String(v);
  });
}

// Parse one value expression (the part after `=` or after the Fish variable name).
// Returns the expanded string. Supports "double" (escapes + $VAR), 'single' (literal),
// bare words (stop at an unquoted ` #` comment) and concatenations such as "$HOME"/x.
function parseValue(raw, lookup) {
  let out = '';
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      let buf = '';
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$\n'.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
        buf += s[i];
        i += 1;
      }
      i += 1; // closing quote (tolerate a missing one)
      out += expand(buf, lookup);
    } else if (ch === "'") {
      let buf = '';
      i += 1;
      while (i < s.length && s[i] !== "'") { buf += s[i]; i += 1; }
      i += 1;
      out += buf;
    } else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      break; // trailing comment
    } else if (/\s/.test(ch)) {
      // Whitespace outside quotes: in POSIX it ends the value, in Fish it separates list
      // items. Treat the remainder as a comment/extra words and stop.
      break;
    } else {
      let buf = '';
      while (i < s.length && !/[\s"']/.test(s[i])) {
        if (s[i] === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
        buf += s[i];
        i += 1;
      }
      out += expand(buf, lookup);
    }
  }
  return out;
}

// Parse .env text into { name: value }. `lookup(name)` resolves $VAR references;
// it receives both previously parsed names and the surrounding environment.
export function parseEnvFile(text, { env = {} } = {}) {
  const values = {};
  const lookup = (name) => (env[name] != null ? env[name] : values[name]);
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let name;
    let rawValue;
    let m;
    if ((m = /^set\s+((?:-[A-Za-z]+\s+)*)([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/.exec(line))) {
      // Fish: set -gx NAME value   (any flags accepted; `-e` erases, which we ignore)
      if (/-[A-Za-z]*e/.test(m[1])) continue;
      name = m[2];
      rawValue = m[3] || '';
    } else if ((m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line))) {
      // POSIX: NAME=value / export NAME=value
      name = m[1];
      rawValue = m[2];
    } else {
      continue; // unknown syntax (e.g. shell commands); ignore silently
    }
    if (!NAME_RE.test(name)) continue;
    values[name] = parseValue(rawValue, lookup);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
let lastState = { file: null, found: false, disabled: false, loaded: [], overridden: [] };
export function dotenvState() { return { ...lastState, loaded: [...lastState.loaded], overridden: [...lastState.overridden] }; }

// Resolve which .env file applies. $MYBIZGATE_DOTENV may name a file explicitly
// or disable loading with 0/false/off.
export function resolveDotenvFile({ workspaceDir, env = process.env } = {}) {
  const override = env[DOTENV_ENV_VAR];
  if (override != null && override !== '') {
    if (DISABLED_VALUES.has(override.trim().toLowerCase())) return { file: null, disabled: true };
    return { file: path.resolve(override), disabled: false };
  }
  return { file: workspaceDir ? path.join(workspaceDir, DOTENV_FILE) : null, disabled: false };
}

// Load the workspace .env into `env` (process.env by default). Existing variables
// win: a name that is already set and non-empty is left untouched and reported in
// `overridden`. Returns names only, never values.
export function loadDotenv({ workspaceDir, platformDir, env = process.env, file } = {}) {
  const root = workspaceDir || findWorkspaceRoot({ platformDir, env });
  const target = file ? { file: path.resolve(file), disabled: false } : resolveDotenvFile({ workspaceDir: root, env });
  const state = { workspaceDir: root, file: target.file, found: false, disabled: target.disabled, loaded: [], overridden: [] };
  if (target.disabled || !target.file || !isFile(target.file)) { lastState = state; return dotenvState(); }
  let text;
  try { text = fs.readFileSync(target.file, 'utf8'); } catch { lastState = state; return dotenvState(); }
  state.found = true;
  const parsed = parseEnvFile(text, { env });
  for (const [name, value] of Object.entries(parsed)) {
    if (env[name] != null && env[name] !== '') { state.overridden.push(name); continue; }
    env[name] = value;
    state.loaded.push(name);
    if (SECRET_KEY_RE.test(name)) registerSecret(value);
  }
  lastState = state;
  return dotenvState();
}

// One-line, value-free description for logs and `mybizgate env`.
export function describeDotenv(state = lastState) {
  if (state.disabled) return `.env loading disabled via ${DOTENV_ENV_VAR}`;
  if (!state.file) return 'no workspace root found; .env not loaded';
  if (!state.found) return `${state.file} not found (shell environment only)`;
  const parts = [`${state.loaded.length} variable(s) loaded from ${state.file}`];
  if (state.loaded.length) parts.push(`loaded: ${state.loaded.join(', ')}`);
  if (state.overridden.length) parts.push(`already set in shell (kept): ${state.overridden.join(', ')}`);
  return parts.join('; ');
}
