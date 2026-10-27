import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockCPanelProvider } from '../src/cpanel.mjs';
import { MockGitHubProvider } from '../src/github.mjs';
import { newClient, normalizeInput, planFor, writeProjectFiles } from '../src/provision.mjs';
import { hostingPlan, ensureSubdomain, ensureCustomDomain, ensureDedicatedFtp } from '../src/hosting.mjs';
import { buildSiteConfig, validateSiteConfig, loadEnv, naming } from '../src/config.mjs';
import { setQuiet } from '../src/utils.mjs';

setQuiet(true);
const env = loadEnv({ HOME: os.tmpdir(), MYBIZGATE_GH_CONFIG_DIR: path.join(os.tmpdir(), 'gh-x') });

test('normalizeInput validates and fills defaults', () => {
  const i = normalizeInput({ name: ' Paw Haven ', slug: 'pawhaven', template: 'petgate' }, env);
  assert.equal(i.name, 'Paw Haven');
  assert.equal(i.domainType, 'subdomain');
  assert.equal(i.visibility, 'private');
  assert.equal(i.ftpAccount, 'dedicated');
  assert.throws(() => normalizeInput({ name: 'X', slug: 'bad slug' }, env), /slug/i);
  assert.throws(() => normalizeInput({ name: 'X', slug: 'x', domainType: 'custom' }, env), /Custom domain/);
  assert.throws(() => normalizeInput({ name: 'X', slug: 'x', template: 'wordpress' }, env), /template/i);
});

test('plan lists hosting steps per domain mode', () => {
  const sub = validateSiteConfig(buildSiteConfig({ name: 'A', slug: 'aaa', template: 'blank', domainType: 'subdomain', env }));
  assert.ok(hostingPlan(sub, env).some((s) => s.id === 'subdomain'));
  const custom = validateSiteConfig(buildSiteConfig({ name: 'A', slug: 'aaa', template: 'blank', domainType: 'custom', customDomain: 'aaa.com.my', dnsMode: 'awedns', env }));
  const ids = hostingPlan(custom, env).map((s) => s.id);
  assert.deepEqual(ids, ['staging', 'custom-domain', 'delegation', 'ftp', 'autossl']);
  const ext = validateSiteConfig(buildSiteConfig({ name: 'A', slug: 'aaa', template: 'blank', domainType: 'custom', customDomain: 'aaa.com.my', dnsMode: 'external', env }));
  assert.ok(hostingPlan(ext, env).some((s) => s.id === 'external-dns'));
  assert.ok(planFor(sub, env).length >= 8);
});

test('dry run never calls mutating provider methods', async () => {
  const cpanel = new MockCPanelProvider();
  const github = new MockGitHubProvider();
  const r = await newClient({ name: 'Dry Run Co', slug: 'dry-run-co', template: 'blank' }, { env, cpanel, github, apply: false });
  assert.equal(r.dryRun, true);
  assert.deepEqual(cpanel.state.calls, []);
  assert.deepEqual(github.state.calls, []);
  assert.equal(fs.existsSync(naming.clientDir('dry-run-co')), false);
});

test('hosting steps are idempotent and honour dry-run', async () => {
  const cpanel = new MockCPanelProvider({ subdomains: ['existing.mybizgate.com'] });
  const dry = await ensureSubdomain(cpanel, { host: 'new.mybizgate.com', label: 'new', dir: 'public_html/clients/new/', apply: false });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(cpanel.state.calls, []);
  const created = await ensureSubdomain(cpanel, { host: 'new.mybizgate.com', label: 'new', dir: 'public_html/clients/new/', apply: true });
  assert.equal(created.created, true);
  const again = await ensureSubdomain(cpanel, { host: 'new.mybizgate.com', label: 'new', dir: 'public_html/clients/new/', apply: true });
  assert.equal(again.created, false);
  assert.equal(cpanel.state.calls.filter((c) => c[0] === 'createSubdomain').length, 1);
  const addon = await ensureCustomDomain(cpanel, { domain: 'client.com.my', label: 'client', dir: 'public_html/clients/client/', apply: true });
  assert.equal(addon.created, true);
  const ftp = await ensureDedicatedFtp(cpanel, { slug: 'new', dir: 'public_html/clients/new/', apply: true, env });
  assert.equal(ftp.mode, 'dedicated');
  assert.equal(ftp.login, 'deploy-new@mybizgate.com');
  assert.ok(ftp.password && ftp.password.length >= 20);
  const ftp2 = await ensureDedicatedFtp(cpanel, { slug: 'new', dir: 'public_html/clients/new/', apply: true, env });
  assert.ok(cpanel.state.calls.some((c) => c[0] === 'setFtpPassword'));
  assert.notEqual(ftp2.password, ftp.password);
});

test('project files are generated from config', () => {
  const cfg = validateSiteConfig(buildSiteConfig({ name: 'Blank Co', slug: 'blank-co', template: 'blank', env }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-proj-'));
  writeProjectFiles(cfg, dir, { env });
  for (const f of ['site.config.yml', '.gitignore', 'README.md', '.github/workflows/deploy.yml', 'index.html', 'style.css', 'script.js']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const wf = fs.readFileSync(path.join(dir, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(wf, /uses: mybizgate\/mybizgate-platform\/\.github\/workflows\/static-site-deploy\.yml@v\d+\.\d+\.\d+\n/, 'workflow is pinned to a platform release, never @main');
  assert.match(wf, /platform_ref: v\d+\.\d+\.\d+\n/);
  assert.doesNotMatch(wf, /dangerous-clean-slate: true/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'site.config.yml'), 'utf8'), /password|token/i);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /Blank Co/);
  fs.rmSync(dir, { recursive: true, force: true });
});
