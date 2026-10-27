import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, loadDotenv, findWorkspaceRoot, isWorkspaceRoot, resolveDotenvFile, describeDotenv, DOTENV_ENV_VAR, WORKSPACE_ENV_VAR, DOTENV_TRACE_VAR } from '../src/dotenv.mjs';
import { redact } from '../src/utils.mjs';

const execFileAsync = promisify(execFile);
const PLATFORM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPERS = ['mybizgate', 'new-client.sh', 'migrate-site.sh', 'rollback.sh', 'site-status.sh'];
const FAKE_TOKEN = 'FAKETOKEN-abc123-DO-NOT-PRINT';

function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Build a fake workspace: <root>/platform is a symlink to the real platform checkout
// so the CLI and its dependencies resolve, while the .env lives in the temp root.
function fakeWorkspace(envText) {
  const root = tmpdir('mbg-ws-');
  fs.symlinkSync(PLATFORM_DIR, path.join(root, 'platform'));
  if (envText != null) fs.writeFileSync(path.join(root, '.env'), envText);
  return root;
}

// Minimal environment for subprocesses: no inherited MyBizGate variables.
function cleanEnv(extra = {}) {
  const base = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS']) if (process.env[k]) base[k] = process.env[k];
  return { ...base, ...extra };
}

test('parseEnvFile understands POSIX, export and Fish syntax', () => {
  const text = [
    '# comment line',
    '',
    'PLAIN=value',
    'export EXPORTED=exported-value',
    'set -gx FISH "fish value"',
    'set -x FISH_X single',
    "set -gx SINGLE 'literal $HOME'",
    'DOUBLE="quoted # not a comment"',
    'TRAILING=value # a comment',
    'EMPTY=',
    'SPACED = spaced',
    'ESCAPED="a \\"quote\\" and \\\\ backslash"',
    'set -e ERASED',
    'this is not an assignment',
    'echo hi',
  ].join('\n');
  const v = parseEnvFile(text, { env: { HOME: '/home/x' } });
  assert.equal(v.PLAIN, 'value');
  assert.equal(v.EXPORTED, 'exported-value');
  assert.equal(v.FISH, 'fish value');
  assert.equal(v.FISH_X, 'single');
  assert.equal(v.SINGLE, 'literal $HOME');
  assert.equal(v.DOUBLE, 'quoted # not a comment');
  assert.equal(v.TRAILING, 'value');
  assert.equal(v.EMPTY, '');
  assert.equal(v.SPACED, 'spaced');
  assert.equal(v.ESCAPED, 'a "quote" and \\ backslash');
  assert.ok(!('ERASED' in v));
  assert.ok(!('this' in v));
  assert.ok(!('echo' in v));
});

test('parseEnvFile expands $VAR and ${VAR} from the environment and earlier lines', () => {
  const text = 'set -gx GH_CONFIG_DIR "$HOME/.config/gh-mybizgate"\nBASE=/srv\nSUB=${BASE}/sites\nUNQUOTED=$BASE/x\nMISSING="$NOPE"\n';
  const v = parseEnvFile(text, { env: { HOME: '/home/jul' } });
  assert.equal(v.GH_CONFIG_DIR, '/home/jul/.config/gh-mybizgate');
  assert.equal(v.SUB, '/srv/sites');
  assert.equal(v.UNQUOTED, '/srv/x');
  assert.equal(v.MISSING, '');
});

test('parseEnvFile: the surrounding environment wins when expanding a name defined in the file', () => {
  const v = parseEnvFile('BASE=/from-file\nSUB=$BASE/x\n', { env: { BASE: '/from-shell' } });
  assert.equal(v.SUB, '/from-shell/x');
});

test('parseEnvFile tolerates CRLF line endings', () => {
  const v = parseEnvFile('A=1\r\nset -gx B "two"\r\n');
  assert.deepEqual(v, { A: '1', B: 'two' });
});

test('findWorkspaceRoot prefers the override, then the platform parent, then walks up from cwd', () => {
  const root = fakeWorkspace('');
  assert.ok(isWorkspaceRoot(root));
  assert.ok(!isWorkspaceRoot(path.join(root, 'nope')));
  // override
  assert.equal(findWorkspaceRoot({ platformDir: '/nonexistent/platform', cwd: '/', env: { [WORKSPACE_ENV_VAR]: root } }), root);
  // invalid override is ignored, platform parent is used
  assert.equal(findWorkspaceRoot({ platformDir: path.join(root, 'platform'), cwd: '/', env: { [WORKSPACE_ENV_VAR]: '/nonexistent' } }), root);
  // walk up from cwd
  const nested = path.join(root, 'clients', 'client-x', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findWorkspaceRoot({ platformDir: '/nonexistent/platform', cwd: nested, env: {} }), root);
  // nothing found: fall back to the platform parent
  assert.equal(findWorkspaceRoot({ platformDir: '/nonexistent/platform', cwd: os.tmpdir(), env: {} }), '/nonexistent');
  // The real checkout is a workspace too.
  assert.equal(findWorkspaceRoot({ platformDir: PLATFORM_DIR, env: {} }), path.resolve(PLATFORM_DIR, '..'));
});

test('resolveDotenvFile honours MYBIZGATE_DOTENV as a path or a disable switch', () => {
  assert.deepEqual(resolveDotenvFile({ workspaceDir: '/ws', env: {} }), { file: '/ws/.env', disabled: false });
  assert.deepEqual(resolveDotenvFile({ workspaceDir: '/ws', env: { [DOTENV_ENV_VAR]: '/else/.env' } }), { file: '/else/.env', disabled: false });
  for (const off of ['0', 'false', 'OFF', 'no']) assert.equal(resolveDotenvFile({ workspaceDir: '/ws', env: { [DOTENV_ENV_VAR]: off } }).disabled, true);
});

test('loadDotenv loads into the given env, keeps existing exported values and reports names only', () => {
  const root = fakeWorkspace(`set -gx CPANEL_TOKEN "${FAKE_TOKEN}"\nCPANEL_HOST=file.example\nFTP_USERNAME=file-user\n`);
  const env = { HOME: '/home/x', CPANEL_HOST: 'shell.example' };
  const st = loadDotenv({ workspaceDir: root, env });
  assert.equal(st.found, true);
  assert.equal(st.file, path.join(root, '.env'));
  assert.deepEqual(st.loaded, ['CPANEL_TOKEN', 'FTP_USERNAME']);
  assert.deepEqual(st.overridden, ['CPANEL_HOST']);
  assert.equal(env.CPANEL_HOST, 'shell.example', 'exported variables take precedence over .env');
  assert.equal(env.CPANEL_TOKEN, FAKE_TOKEN);
  assert.equal(env.FTP_USERNAME, 'file-user');
  const text = describeDotenv(st);
  assert.match(text, /CPANEL_TOKEN/);
  assert.ok(!text.includes(FAKE_TOKEN), 'description must never contain values');
  assert.ok(!JSON.stringify(st).includes(FAKE_TOKEN), 'state must never contain values');
  // Secrets read from .env are registered for redaction.
  assert.equal(redact(`token ${FAKE_TOKEN}`, {}), 'token <redacted>');
});

test('loadDotenv is a no-op when the file is missing or loading is disabled', () => {
  const root = fakeWorkspace(null);
  const env = { HOME: '/home/x' };
  const missing = loadDotenv({ workspaceDir: root, env });
  assert.equal(missing.found, false);
  assert.deepEqual(env, { HOME: '/home/x' });
  assert.match(describeDotenv(missing), /not found/);
  fs.writeFileSync(path.join(root, '.env'), 'CPANEL_USER=someone\n');
  const disabled = loadDotenv({ workspaceDir: root, env: { ...env, [DOTENV_ENV_VAR]: '0' } });
  assert.equal(disabled.disabled, true);
  assert.deepEqual(disabled.loaded, []);
  const explicit = tmpdir('mbg-env-');
  fs.writeFileSync(path.join(explicit, 'custom.env'), 'CPANEL_USER=custom\n');
  const env2 = { [DOTENV_ENV_VAR]: path.join(explicit, 'custom.env') };
  loadDotenv({ workspaceDir: root, env: env2 });
  assert.equal(env2.CPANEL_USER, 'custom');
});

test('every wrapper script loads the workspace .env before running the CLI', async () => {
  const root = fakeWorkspace(`set -gx CPANEL_TOKEN "${FAKE_TOKEN}"\nset -gx CPANEL_USER "fileuser"\n`);
  for (const wrapper of WRAPPERS) {
    const bin = path.join(root, 'platform', 'bin', wrapper);
    const r = await execFileAsync(bin, ['--help'], { env: cleanEnv({ [WORKSPACE_ENV_VAR]: root, [DOTENV_TRACE_VAR]: '1' }), cwd: os.tmpdir() });
    assert.match(r.stdout, /\.env: 2 variable\(s\) loaded from .*\.env; loaded: CPANEL_TOKEN, CPANEL_USER/, `${wrapper} should load .env`);
    assert.match(r.stdout, /Usage: mybizgate/, `${wrapper} --help should still print help`);
    assert.ok(!r.stdout.includes(FAKE_TOKEN) && !r.stderr.includes(FAKE_TOKEN), `${wrapper} must not print secret values`);
  }
});

test('mybizgate env reports sources without values and respects shell precedence', async () => {
  const root = fakeWorkspace(`CPANEL_TOKEN=${FAKE_TOKEN}\nCPANEL_USER=fileuser\nEXTRA_NAME=1\n`);
  const bin = path.join(root, 'platform', 'bin', 'mybizgate');
  const r = await execFileAsync(bin, ['env'], { env: cleanEnv({ [WORKSPACE_ENV_VAR]: root, CPANEL_USER: 'shelluser' }), cwd: os.tmpdir() });
  assert.match(r.stdout, /\.env file:\s+.*\.env \(loaded\)/);
  assert.match(r.stdout, /CPANEL_TOKEN\s+set \(\.env\)/);
  assert.match(r.stdout, /CPANEL_USER\s+set \(shell, overrides \.env\)/);
  assert.match(r.stdout, /FTP_PASSWORD\s+unset/);
  assert.match(r.stdout, /Other names in \.env: EXTRA_NAME/);
  assert.ok(!r.stdout.includes(FAKE_TOKEN) && !r.stdout.includes('fileuser') && !r.stdout.includes('shelluser'), 'env output must contain names only');
});

test('.env stays gitignored in the platform and in every generated site', () => {
  for (const file of [path.join(PLATFORM_DIR, '.gitignore'), path.join(PLATFORM_DIR, 'templates', 'static-site', '.gitignore')]) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim());
    assert.ok(lines.includes('.env'), `${file} must ignore .env`);
    assert.ok(lines.includes('.env.*'), `${file} must ignore .env.*`);
  }
});
