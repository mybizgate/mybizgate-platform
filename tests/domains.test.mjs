// Parent domains (mybizgate.com / niagova.com) and the client/demo naming they drive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockCPanelProvider } from '../src/cpanel.mjs';
import { MockGitHubProvider } from '../src/github.mjs';
import { acceptDryRun, expectedResult, newClient, normalizeInput, wizard } from '../src/provision.mjs';
import { ensureSubdomain, ensureDedicatedFtp } from '../src/hosting.mjs';
import { buildSiteConfig, validateSiteConfig, validateCustomDomain, validateParentDomain, validateSlug, loadEnv, naming } from '../src/config.mjs';
import { createScriptedIo } from '../src/prompt.mjs';
import { setQuiet } from '../src/utils.mjs';

setQuiet(true);
const env = loadEnv({ HOME: os.tmpdir(), MYBIZGATE_GH_CONFIG_DIR: path.join(os.tmpdir(), 'gh-x') });

test('both parent domains are offered and mybizgate.com stays the default and hosting domain', () => {
  assert.deepEqual(env.baseDomains, ['mybizgate.com', 'niagova.com']);
  assert.equal(env.baseDomain, 'mybizgate.com');
  assert.equal(env.hostingDomain, 'mybizgate.com');
  assert.equal(validateParentDomain('niagova.com', env), 'niagova.com');
  assert.throws(() => validateParentDomain('example.com', env), /Unknown parent domain/);
});

test('client and demo resources follow the naming rules on either parent', () => {
  const site = (kind, parentDomain) => validateSiteConfig(buildSiteConfig({ name: 'LZ Hub', slug: 'lzhub', template: 'blank', kind, parentDomain, visibility: 'private', env }));
  const client = site('client', 'niagova.com');
  assert.equal(client.domain.primary, 'lzhub.niagova.com');
  assert.equal(client.site.production_url, 'https://lzhub.niagova.com');
  assert.equal(client.github.repo, 'client-lzhub');
  assert.equal(client.hosting.deploy_dir, 'public_html/clients/lzhub/');
  assert.match(naming.projectDir('client', 'lzhub'), /\/clients\/client-lzhub$/);
  const demo = site('demo', 'mybizgate.com');
  assert.equal(demo.domain.primary, 'demo-lzhub.mybizgate.com');
  assert.equal(demo.github.repo, 'demo-lzhub');
  assert.equal(demo.hosting.deploy_dir, 'public_html/demo/lzhub/');
  assert.match(naming.projectDir('demo', 'lzhub'), /\/demo\/demo-lzhub$/);
  assert.equal(site('demo', 'niagova.com').domain.primary, 'demo-lzhub.niagova.com');
});

test('legacy Gate demos keep their <slug>.<parent> host', () => {
  const cfg = buildSiteConfig({ name: 'PetGate', slug: 'petgate', template: 'blank', kind: 'demo', legacyDemo: true, env });
  assert.equal(cfg.domain.primary, 'petgate.mybizgate.com');
});

test('a custom-domain client without a parent choice gets staging on the default domain', () => {
  const cfg = buildSiteConfig({ name: 'A', slug: 'aaa', template: 'blank', domainType: 'custom', customDomain: 'aaa.com.my', env });
  assert.equal(cfg.domain.staging, 'stg-aaa.mybizgate.com');
});

test('the subdomain is created on the parent taken from the host, not the default', async () => {
  const cpanel = new MockCPanelProvider();
  const r = await ensureSubdomain(cpanel, { host: 'demo-lzhub.niagova.com', dir: 'public_html/demo/lzhub/', apply: true });
  assert.equal(r.created, true);
  assert.deepEqual(cpanel.state.subdomains, ['demo-lzhub.niagova.com']);
  assert.deepEqual(cpanel.state.calls, [['createSubdomain', 'demo-lzhub', 'public_html/demo/lzhub/']]);
});

test('FTP logins stay on the hosting domain and a demo never reuses a client account', async () => {
  const cpanel = new MockCPanelProvider();
  const client = await ensureDedicatedFtp(cpanel, { slug: 'lzhub', dir: 'public_html/clients/lzhub/', apply: true, env });
  const demo = await ensureDedicatedFtp(cpanel, { slug: 'lzhub', kind: 'demo', dir: 'public_html/demo/lzhub/', apply: true, env });
  assert.equal(client.login, 'deploy-lzhub@mybizgate.com');
  assert.equal(demo.login, 'deploy-demo-lzhub@mybizgate.com');
  assert.equal(cpanel.state.calls.filter((c) => c[0] === 'setFtpPassword').length, 0, 'the client password must not be rotated');
  const niagovaEnv = loadEnv({ HOME: os.tmpdir(), MYBIZGATE_BASE_DOMAIN: 'niagova.com' });
  assert.equal(naming.ftpLogin('lzhub', niagovaEnv), 'deploy-lzhub@mybizgate.com');
});

test('hosts inside any parent domain are refused as custom domains; niagova is a reserved slug', () => {
  assert.throws(() => validateCustomDomain('x.niagova.com', env), /inside niagova\.com/);
  assert.throws(() => validateCustomDomain('niagova.com', env), /inside niagova\.com/);
  assert.equal(validateCustomDomain('pawhaven.com.my', env), 'pawhaven.com.my');
  assert.throws(() => validateSlug('niagova'), /reserved/);
});

test('input: unknown parents and demo- slugs are refused; a client may reuse a demo slug', () => {
  assert.throws(() => normalizeInput({ name: 'X', slug: 'xx', parentDomain: 'example.com' }, env), /Unknown parent domain/);
  assert.throws(() => normalizeInput({ name: 'X', slug: 'demo-xx', projectType: 'demo' }, env), /added automatically \(use "xx"\)/);
  assert.equal(normalizeInput({ name: 'X', slug: 'demo-xx' }, env).slug, 'demo-xx');
});

test('wizard: a client on a subdomain picks the parent; a demo slug suggestion drops demo-', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-dom-'));
  fs.mkdirSync(path.join(root, 'beauty', 'modern-01'), { recursive: true });
  fs.writeFileSync(path.join(root, 'beauty', 'modern-01', 'index.html'), '<h1>x</h1>');
  const rest = ['+60123456789', 'a@b.my', 'KL', '', '', '', '', '', '', '', ''];
  const client = createScriptedIo(['1', 'LZ Hub', 'lzhub', '', '1', '1', '1', '2', ...rest]);
  const c = await wizard({}, env, { io: client, templatesRoot: root });
  assert.match(client.text, /Parent Domain\n\n\[1\] mybizgate\.com\n\[2\] niagova\.com\n\nSelect \[1\]:/);
  assert.match(client.text, /Domain: lzhub\.niagova\.com/);
  assert.equal(c.parentDomain, 'niagova.com');
  const demo = createScriptedIo(['2', 'Demo Auto Spa', '', '', '1', '1', '', ...rest]);
  const d = await wizard({}, env, { io: demo, templatesRoot: root });
  assert.equal(d.slug, 'auto-spa');
  assert.match(demo.text, /Demo Domain: demo-auto-spa\.mybizgate\.com/);
});

test('apply stops before any change when the parent domain cannot resolve the new subdomain', async () => {
  const cpanel = new MockCPanelProvider({ undelegated: ['niagova.com'] });
  const github = new MockGitHubProvider();
  const input = { name: 'Blocked Co', slug: 'blocked-parent-zz', template: 'blank', parentDomain: 'niagova.com' };
  const dry = await newClient(input, { env, cpanel, github, apply: false });
  assert.match(dry.dnsProblem.message, /blocked-parent-zz\.niagova\.com will not resolve/);
  await assert.rejects(newClient(input, { env, cpanel, github, apply: true, yes: true }), (err) => err.code === 'PARENT_DOMAIN_NOT_READY' && /A record/.test(err.hint));
  assert.deepEqual(cpanel.state.calls, []);
  assert.deepEqual(github.state.calls, []);
  assert.equal(fs.existsSync(naming.clientDir(input.slug)), false);
});

test('the dry-run result block lists the URL, repo, local folder and FTP folder', () => {
  const block = (input) => expectedResult(validateSiteConfig(buildSiteConfig({ name: 'LZ Hub', slug: 'lzhub', template: 'blank', env, ...input })), env);
  const client = block({ parentDomain: 'niagova.com' });
  assert.match(client, /Website URL +: https:\/\/lzhub\.niagova\.com\n/);
  assert.match(client, /GitHub Repo +: mybizgate\/client-lzhub\n/);
  assert.match(client, /Local Folder +: .*\/clients\/client-lzhub\n/);
  assert.match(client, /FTP Folder +: \/public_html\/clients\/lzhub\/\n/);
  assert.doesNotMatch(client, /Staging URL/);
  const demo = block({ kind: 'demo', visibility: 'public' });
  assert.match(demo, /Website URL +: https:\/\/demo-lzhub\.mybizgate\.com\n/);
  assert.match(demo, /GitHub Repo +: mybizgate\/demo-lzhub\n/);
  assert.match(demo, /Local Folder +: .*\/demo\/demo-lzhub\n/);
  assert.match(demo, /FTP Folder +: \/public_html\/demo\/lzhub\/\n/);
  const custom = block({ domainType: 'custom', customDomain: 'lzhub.com.my' });
  assert.match(custom, /Website URL +: https:\/\/lzhub\.com\.my\nStaging URL +: https:\/\/stg-lzhub\.mybizgate\.com\n/);
});

test('accepting a dry run applies the same answers; declining or a blocker changes nothing', async () => {
  const input = { name: 'Accept Co', slug: 'accept-dry-zz', template: 'blank', parentDomain: 'niagova.com' };
  const run = async (answers, providerOptions) => {
    const cpanel = new MockCPanelProvider(providerOptions);
    const github = new MockGitHubProvider();
    github.refExists = async () => false; // stops Apply at its first remote check, before anything is created
    const dry = await newClient(input, { env, cpanel, github, apply: false });
    const io = createScriptedIo(answers);
    return { dry, io, cpanel, github, accept: () => acceptDryRun(dry, input, { io, env, cpanel, github }) };
  };

  const declined = await run(['n']);
  assert.equal(await declined.accept(), declined.dry);
  assert.deepEqual(declined.cpanel.state.calls, []);

  const empty = await run(['']);
  assert.equal(await empty.accept(), empty.dry, 'the default answer is No');
  assert.match(empty.io.text, /Apply these settings now\? \[y\/N\]: /);

  const blocked = await run(['y'], { undelegated: ['niagova.com'] });
  assert.equal(await blocked.accept(), blocked.dry);
  assert.equal(blocked.io.queue.length, 1, 'a blocked dry run does not offer Apply');

  const accepted = await run(['y']);
  await assert.rejects(accepted.accept(), (err) => err.code === 'PLATFORM_REF_MISSING', 'y runs the real Apply path with no second question');
  assert.equal(accepted.io.queue.length, 0);
  assert.equal(fs.existsSync(naming.clientDir(input.slug)), false);
});

test('apply stops when the parent domain is not on the cPanel account', async () => {
  const cpanel = new MockCPanelProvider({ addons: [] });
  const r = await newClient({ name: 'No Addon', slug: 'no-addon-zz', template: 'blank', parentDomain: 'niagova.com' }, { env, cpanel, github: new MockGitHubProvider(), apply: false });
  assert.match(r.dnsProblem.message, /niagova\.com is not on the cPanel account/);
});
