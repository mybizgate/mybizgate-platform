import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSlug, validateHostname, validateCustomDomain, validateDeployDir, naming, parseSiteConfig, buildSiteConfig,
  serializeSiteConfig, validateSiteConfig, resolveServerDir, loadEnv,
} from '../src/config.mjs';

const env = loadEnv({ HOME: '/tmp' });

test('slug validation accepts kebab-case and rejects unsafe values', () => {
  assert.equal(validateSlug('pawhaven'), 'pawhaven');
  assert.equal(validateSlug('paw-haven-2'), 'paw-haven-2');
  for (const bad of ['', 'Paw', 'paw haven', 'paw_haven', '-paw', 'paw-', 'paw--haven', '../etc', 'a;rm -rf', 'www', 'petgate', 'a'.repeat(41)]) {
    assert.throws(() => validateSlug(bad), new RegExp('slug', 'i'), `should reject ${JSON.stringify(bad)}`);
  }
});

test('domain validation', () => {
  assert.equal(validateHostname('Pawhaven.COM.MY'), 'pawhaven.com.my');
  for (const bad of ['', 'paw haven.com', 'http://x.com', 'x.com/path', 'x..com', '-x.com', 'localhost', 'a@b.com', 'x.com;ls', 'xn--abc.com']) {
    assert.throws(() => validateHostname(bad), `should reject ${bad}`);
  }
  assert.throws(() => validateCustomDomain('foo.mybizgate.com', env), /subdomain/);
  assert.equal(validateCustomDomain('pawhaven.com.my', env), 'pawhaven.com.my');
});

test('deployment directory validation enforces the safety rules', () => {
  assert.equal(validateDeployDir('public_html/clients/pawhaven/', { kind: 'client', slug: 'pawhaven' }), 'public_html/clients/pawhaven/');
  assert.equal(validateDeployDir('public_html/clients/pawhaven', { kind: 'client', slug: 'pawhaven' }), 'public_html/clients/pawhaven/');
  assert.equal(validateDeployDir('public_html/demo/pawhaven/', { kind: 'demo', slug: 'pawhaven' }), 'public_html/demo/pawhaven/');
  assert.equal(validateDeployDir('public_html/site-petgate/', { kind: 'demo', slug: 'petgate' }), 'public_html/site-petgate/', 'legacy Gate demo paths remain valid');
  assert.equal(validateDeployDir('public_html/', { kind: 'corporate', repo: 'mybizgate-site' }), 'public_html/');
  for (const bad of ['', '/', '.', '..', 'public_html/', 'public_html/../x/', 'public_html/clients/../pawhaven/', 'public_html/clients/other/', 'public_html/site-petgate/', 'clients/pawhaven/', '/public_html/clients/pawhaven/', 'public_html/clients/paw haven/']) {
    assert.throws(() => validateDeployDir(bad, { kind: 'client', slug: 'pawhaven' }), `client should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => validateDeployDir('public_html/', { kind: 'demo', slug: 'petgate' }), /corporate/);
  assert.throws(() => validateDeployDir('public_html/demo/other/', { kind: 'demo', slug: 'pawhaven' }), /slug/);
  assert.throws(() => validateDeployDir('public_html/', { kind: 'corporate', repo: 'client-pawhaven' }), /Only mybizgate-site/);
  assert.throws(() => validateDeployDir('public_html/clients/x/', { kind: 'corporate', repo: 'mybizgate-site' }));
});

test('naming conventions derive everything from the slug', () => {
  assert.equal(naming.repoName('pawhaven'), 'client-pawhaven');
  assert.equal(naming.clientDirName('pawhaven'), 'client-pawhaven');
  assert.match(naming.clientDir('pawhaven'), /\/clients\/client-pawhaven$/);
  assert.equal(naming.deployDir('pawhaven'), 'public_html/clients/pawhaven/');
  assert.equal(naming.demoRepoName('pawhaven'), 'demo-pawhaven');
  assert.match(naming.demoDir('pawhaven'), /\/demo\/demo-pawhaven$/);
  assert.equal(naming.demoDeployDir('pawhaven'), 'public_html/demo/pawhaven/');
  assert.equal(naming.projectRepoName('demo', 'pawhaven'), 'demo-pawhaven');
  assert.equal(naming.subdomainHost('pawhaven', env), 'pawhaven.mybizgate.com');
  assert.equal(naming.stagingHost('pawhaven', env), 'stg-pawhaven.mybizgate.com');
  assert.equal(naming.sshRemote('client-pawhaven', env), 'git@github-mybizgate:mybizgate/client-pawhaven.git');
  assert.equal(naming.ftpLogin('pawhaven', env), 'deploy-pawhaven@mybizgate.com');
  assert.match(naming.releaseTag('abcd1234', new Date(2026, 9, 27, 15, 4)), /^prod-20261027-1504-abcd1234$/);
});

test('site config builds, serialises and parses for subdomain clients', () => {
  const cfg = buildSiteConfig({ name: 'Paw Haven Cat Hotel', slug: 'pawhaven', template: 'petgate', domainType: 'subdomain', env });
  const text = serializeSiteConfig(cfg);
  assert.match(text, /slug: pawhaven/);
  const parsed = parseSiteConfig(text);
  assert.equal(parsed.domain.primary, 'pawhaven.mybizgate.com');
  assert.equal(parsed.hosting.deploy_dir, 'public_html/clients/pawhaven/');
  assert.equal(parsed.site.production_url, 'https://pawhaven.mybizgate.com');
  assert.equal(parsed.site.environment, 'production');
  assert.equal(parsed.github.repo, 'client-pawhaven');
  assert.equal(resolveServerDir(parsed), './');
  parsed.hosting.ftp_account = 'shared';
  assert.equal(resolveServerDir(parsed), 'public_html/clients/pawhaven/');
});

test('site config for custom domains requires staging and starts in staging mode', () => {
  const cfg = buildSiteConfig({ name: 'Paw Haven', slug: 'pawhaven', template: 'petgate', domainType: 'custom', customDomain: 'pawhaven.com.my', dnsMode: 'external', env });
  assert.equal(cfg.domain.staging, 'stg-pawhaven.mybizgate.com');
  assert.equal(cfg.site.environment, 'staging');
  assert.equal(cfg.site.staging_url, 'https://stg-pawhaven.mybizgate.com');
  const text = serializeSiteConfig(cfg);
  const parsed = parseSiteConfig(text);
  assert.equal(parsed.domain.dns_mode, 'external');
  assert.throws(() => validateSiteConfig({ ...parsed, domain: { type: 'custom', primary: 'pawhaven.com.my' } }), /staging/);
});

test('config parsing rejects unsafe deploy directories and bad yaml', () => {
  assert.throws(() => parseSiteConfig('client: [\n'), /parse/i);
  assert.throws(() => parseSiteConfig('client:\n  name: X\n  slug: x\ndomain:\n  primary: x.mybizgate.com\nhosting:\n  deploy_dir: public_html/\n'), /public_html/);
  assert.throws(() => parseSiteConfig('client:\n  name: X\n  slug: x\ndomain:\n  primary: x.mybizgate.com\nhosting:\n  deploy_dir: public_html/clients/y/\n'), /slug/);
});

test('demo and corporate configs', () => {
  const demo = validateSiteConfig(buildSiteConfig({ name: 'Paw Haven Demo', slug: 'pawhaven', template: 'petgate', kind: 'demo', visibility: 'public', env }));
  assert.equal(demo.hosting.deploy_dir, 'public_html/demo/pawhaven/');
  assert.equal(demo.github.repo, 'demo-pawhaven');
  assert.equal(demo.github.visibility, 'public');
  assert.equal(demo.hosting.ftp_account, 'dedicated');
  const legacyDemo = validateSiteConfig(buildSiteConfig({ name: 'PetGate', slug: 'petgate', template: 'petgate', kind: 'demo', legacyDemo: true, env }));
  assert.equal(legacyDemo.hosting.deploy_dir, 'public_html/site-petgate/');
  assert.equal(legacyDemo.github.repo, 'site-petgate');
  const corp = validateSiteConfig(buildSiteConfig({ name: 'MyBizGate', slug: 'mybizgate', template: 'blank', kind: 'corporate', env }), { repo: 'mybizgate-site' });
  assert.equal(corp.hosting.deploy_dir, 'public_html/');
  assert.throws(() => validateSiteConfig(buildSiteConfig({ name: 'MyBizGate', slug: 'mybizgate', template: 'blank', kind: 'corporate', env }), { repo: 'client-evil' }));
});
