// Shared utilities: structured logging, secret redaction, safe process execution,
// bounded polling and small filesystem helpers.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------
const SECRET_ENV_KEYS = ['CPANEL_TOKEN', 'FTP_PASSWORD', 'GH_TOKEN', 'GITHUB_TOKEN', 'MYBIZGATE_GH_TOKEN'];
const registeredSecrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) registeredSecrets.add(value);
}

export function knownSecrets(env = process.env) {
  const values = new Set(registeredSecrets);
  for (const key of SECRET_ENV_KEYS) {
    const v = env[key];
    if (typeof v === 'string' && v.length >= 6) values.add(v);
  }
  return values;
}

export function redact(input, env = process.env) {
  if (input == null) return input;
  let text = typeof input === 'string' ? input : (input instanceof Error ? `${input.message}` : String(input));
  for (const secret of knownSecrets(env)) {
    if (secret) text = text.split(secret).join('<redacted>');
  }
  // Redact cPanel token headers and FTP-style credential URLs defensively.
  text = text.replace(/(Authorization:\s*cpanel\s+[^:\s]+:)[^\s'"]+/gi, '$1<redacted>');
  text = text.replace(/(cpanel_token|ftp_password|password|token)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi, (m, k, sep, v) => (v.length >= 8 && !/^<redacted>$/.test(v) ? `${k}${sep}<redacted>` : m));
  text = text.replace(/(ftps?:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1<redacted>@');
  return text;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
let quiet = false;
export function setQuiet(v) { quiet = Boolean(v); }

function emit(tag, msg, stream = process.stdout) {
  if (quiet && stream === process.stdout) return;
  stream.write(`${tag} ${redact(msg)}\n`);
}
export const log = {
  check: (m) => emit('[CHECK]', m),
  ok: (m) => emit('[ OK ]', m),
  plan: (m) => emit('[PLAN]', m),
  info: (m) => emit('[INFO]', m),
  warn: (m) => emit('[WARN]', m, process.stderr),
  fail: (m) => emit('[FAIL]', m, process.stderr),
  skip: (m) => emit('[SKIP]', m),
  step: (m) => emit('[STEP]', m),
  dry: (m) => emit('[DRY ]', m),
  raw: (m) => { if (!quiet) process.stdout.write(`${redact(m)}\n`); },
};

export class PlatformError extends Error {
  constructor(message, { hint, code = 'PLATFORM_ERROR', cause } = {}) {
    super(redact(message));
    this.name = 'PlatformError';
    this.hint = hint ? redact(hint) : undefined;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Process execution (argument arrays only; never shell strings)
// ---------------------------------------------------------------------------
export async function run(cmd, args = [], { cwd, env, input, allowFailure = false, timeoutMs = 120000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      ...(input != null ? {} : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PlatformError(`Command not found: ${cmd}`, { code: 'ENOENT', hint: `Install ${cmd} and make sure it is on PATH.` });
    }
    const result = { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout || '', stderr: err.stderr || '' };
    if (allowFailure) return result;
    throw new PlatformError(`Command failed (${result.code}): ${cmd} ${args.map(shortArg).join(' ')}\n${result.stderr || result.stdout}`.trim(), { code: 'CMD_FAILED' });
  }
}

// Run with stdin input (used for `gh secret set` so secrets never appear in argv).
export function runWithInput(cmd, args, input, { cwd, env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(new PlatformError(`Failed to start ${cmd}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0 || allowFailure) return resolve({ code, stdout, stderr });
      reject(new PlatformError(`Command failed (${code}): ${cmd} ${args.map(shortArg).join(' ')}\n${stderr || stdout}`.trim(), { code: 'CMD_FAILED' }));
    });
    child.stdin.end(input);
  });
}

function shortArg(a) {
  const s = String(a);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

export async function commandExists(cmd) {
  const r = await run('sh', ['-c', 'command -v "$1"', 'sh', cmd], { allowFailure: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function poll({ label, fn, intervalMs = 10000, timeoutMs = 300000, onTick }) {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const result = await fn(attempt);
    if (result && result.done) return result.value;
    if (onTick) onTick(attempt, result);
    if (Date.now() - started > timeoutMs) {
      throw new PlatformError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${label}`, {
        code: 'TIMEOUT',
        hint: result && result.hint ? result.hint : 'Re-run the command later; completed steps are skipped automatically.',
      });
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Filesystem / formatting helpers
// ---------------------------------------------------------------------------
export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function dirSize(dir) {
  let total = 0;
  if (!exists(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      total += dirSize(p);
    } else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

export function randomPassword(length = 28) {
  // Letters, digits and a few symbols that are safe for cPanel FTP passwords and GitHub secrets.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length * 2));
  let out = '';
  for (const b of bytes) {
    if (out.length >= length) break;
    if (b < alphabet.length * 3) out += alphabet[b % alphabet.length];
  }
  while (out.length < length) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function parseArgs(argv, { booleans = [], aliases = {} } = {}) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { opts._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      key = aliases[key] || key;
      if (key.startsWith('no-') && booleans.includes(key.slice(3))) { opts[camel(key.slice(3))] = false; continue; }
      if (eq !== -1) { opts[camel(key)] = a.slice(eq + 1); continue; }
      if (booleans.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) { opts[camel(key)] = true; continue; }
      opts[camel(key)] = argv[i + 1];
      i += 1;
    } else opts._.push(a);
  }
  return opts;
}
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
