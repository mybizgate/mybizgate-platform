// Environment configuration, input validation, naming conventions and
// site.config.yml handling. Pure logic lives here so it is easy to unit test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { PlatformError, exists } from './utils.mjs';

export const PLATFORM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_DIR = path.resolve(PLATFORM_DIR, '..');
export const CLIENTS_DIR = path.join(WORKSPACE_DIR, 'clients');

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const RESERVED_SLUGS = new Set([
  'www', 'mail', 'ftp', 'cpanel', 'webmail', 'webdisk', 'whm', 'ns1', 'ns2', 'api', 'admin', 'autodiscover',
  'autoconfig', 'cpcontacts', 'cpcalendars', 'localhost', 'mybizgate', 'site', 'clients', 'client', 'stg', 'staging',
  'petgate', 'autogate', 'beautygate', 'dentalgate', 'supplygate',
]);

export const TEMPLATES = ['blank', 'petgate', 'autogate', 'beautygate', 'dentalgate', 'supplygate'];
export const DOMAIN_TYPES = ['subdomain', 'custom'];
export const DNS_MODES = ['awedns', 'external'];
export const SITE_KINDS = ['client', 'demo', 'corporate'];
export const VISIBILITIES = ['private', 'public'];

export const CORPORATE_REPO = 'mybizgate-site';
export const DEMO_SITES = ['petgate', 'autogate', 'beautygate', 'dentalgate', 'supplygate'];

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
export function loadEnv(env = process.env) {
  const cfg = {
    cpanelHost: env.CPANEL_HOST || 'baboon.awedns.com',
    cpanelUser: env.CPANEL_USER || 'mybizgat',
    cpanelToken: env.CPANEL_TOKEN || '',
    cpanelPort: Number(env.CPANEL_PORT || 2083),
    ftpServer: env.FTP_SERVER || env.CPANEL_HOST || 'baboon.awedns.com',
    ftpUsername: env.FTP_USERNAME || '',
    ftpPassword: env.FTP_PASSWORD || '',
    githubOwner: env.GITHUB_OWNER || 'mybizgate',
    githubSshHost: env.GITHUB_SSH_HOST || 'github-mybizgate',
    platformRepo: env.MYBIZGATE_PLATFORM_REPO || 'mybizgate-platform',
    platformRef: env.MYBIZGATE_PLATFORM_REF || 'main',
    baseDomain: env.MYBIZGATE_BASE_DOMAIN || 'mybizgate.com',
    nameservers: (env.MYBIZGATE_NAMESERVERS || 'ns1.awedns.com,ns2.awedns.com').split(',').map((s) => s.trim()).filter(Boolean),
    ghConfigDir: env.MYBIZGATE_GH_CONFIG_DIR || path.join(env.HOME || '', '.config', 'gh-mybizgate'),
    ghToken: env.MYBIZGATE_GH_TOKEN || '',
    integration: env.MYBIZGATE_INTEGRATION_TEST === '1',
  };
  return cfg;
}

export function envStatus(env = process.env) {
  const keys = ['CPANEL_HOST', 'CPANEL_USER', 'CPANEL_TOKEN', 'FTP_SERVER', 'FTP_USERNAME', 'FTP_PASSWORD', 'GITHUB_OWNER', 'GITHUB_SSH_HOST'];
  return Object.fromEntries(keys.map((k) => [k, Boolean(env[k])]));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function validateSlug(slug) {
  if (typeof slug !== 'string' || !slug) throw new PlatformError('Slug is required.', { code: 'INVALID_SLUG' });
  if (slug.length > 40) throw new PlatformError('Slug must be 40 characters or fewer.', { code: 'INVALID_SLUG' });
  if (!SLUG_RE.test(slug)) {
    throw new PlatformError(`Invalid slug "${slug}". Use lowercase letters, digits and single hyphens (example: paw-haven).`, { code: 'INVALID_SLUG' });
  }
  if (RESERVED_SLUGS.has(slug)) throw new PlatformError(`Slug "${slug}" is reserved.`, { code: 'INVALID_SLUG' });
  return slug;
}

export function validateHostname(host, { label = 'Domain' } = {}) {
  if (typeof host !== 'string' || !host) throw new PlatformError(`${label} is required.`, { code: 'INVALID_DOMAIN' });
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (/[\s/\\:@#?&=;'"`$<>|(){}[\]*,!]/.test(h) || h.includes('..')) {
    throw new PlatformError(`${label} "${host}" contains unsafe characters.`, { code: 'INVALID_DOMAIN' });
  }
  if (!HOSTNAME_RE.test(h)) throw new PlatformError(`${label} "${host}" is not a valid hostname.`, { code: 'INVALID_DOMAIN' });
  if (h.startsWith('xn--')) throw new PlatformError(`${label} "${host}": punycode domains are not supported yet.`, { code: 'INVALID_DOMAIN' });
  return h;
}

export function validateCustomDomain(host, env = loadEnv()) {
  const h = validateHostname(host, { label: 'Custom domain' });
  if (h === env.baseDomain || h.endsWith(`.${env.baseDomain}`)) {
    throw new PlatformError(`Custom domain "${h}" is inside ${env.baseDomain}; use domain type "subdomain" instead.`, { code: 'INVALID_DOMAIN' });
  }
  return h;
}

export function validateBusinessName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new PlatformError('Business name is required.', { code: 'INVALID_NAME' });
  const n = name.trim();
  if (n.length > 120) throw new PlatformError('Business name must be 120 characters or fewer.', { code: 'INVALID_NAME' });
  if (/[\x00-\x1f<>`$\\]/.test(n)) throw new PlatformError('Business name contains unsafe characters.', { code: 'INVALID_NAME' });
  return n;
}

export function validateTemplate(t) {
  if (!TEMPLATES.includes(t)) throw new PlatformError(`Unknown template "${t}". Choose one of: ${TEMPLATES.join(', ')}.`, { code: 'INVALID_TEMPLATE' });
  return t;
}

export function validateDomainType(t) {
  if (!DOMAIN_TYPES.includes(t)) throw new PlatformError(`Unknown domain type "${t}". Choose one of: ${DOMAIN_TYPES.join(', ')}.`, { code: 'INVALID_DOMAIN_TYPE' });
  return t;
}

export function validateDnsMode(m) {
  if (!DNS_MODES.includes(m)) throw new PlatformError(`Unknown DNS mode "${m}". Choose one of: ${DNS_MODES.join(', ')}.`, { code: 'INVALID_DNS_MODE' });
  return m;
}

export function validateVisibility(v) {
  if (!VISIBILITIES.includes(v)) throw new PlatformError(`Unknown visibility "${v}". Choose one of: ${VISIBILITIES.join(', ')}.`, { code: 'INVALID_VISIBILITY' });
  return v;
}

// ---------------------------------------------------------------------------
// Deployment directory rules (the central safety rule of the platform)
// ---------------------------------------------------------------------------
const CLIENT_DIR_RE = /^public_html\/clients\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/;
const DEMO_DIR_RE = /^public_html\/site-([a-z0-9]+(?:-[a-z0-9]+)*)\/$/;

export function normalizeDeployDir(dir) {
  if (typeof dir !== 'string') return '';
  let d = dir.trim().replace(/\\/g, '/');
  if (d.startsWith('./')) d = d.slice(2);
  if (d && !d.endsWith('/')) d += '/';
  return d;
}

/**
 * Validate a deployment directory for a given site kind and slug.
 * Throws PlatformError when the path would be unsafe.
 */
export function validateDeployDir(dir, { kind, slug, repo } = {}) {
  const d = normalizeDeployDir(dir);
  const forbidden = ['', '/', './', '.', '..', '../'];
  if (forbidden.includes(d) || forbidden.includes(dir)) {
    throw new PlatformError(`Deployment directory "${dir}" is empty or a root path; refusing.`, { code: 'UNSAFE_DEPLOY_DIR' });
  }
  if (d.includes('../') || d.includes('/./') || d.startsWith('/') || /[\s\0'"`$<>|;&*?\\]/.test(d)) {
    throw new PlatformError(`Deployment directory "${dir}" contains traversal or unsafe characters; refusing.`, { code: 'UNSAFE_DEPLOY_DIR' });
  }
  if (!d.startsWith('public_html/')) {
    throw new PlatformError(`Deployment directory "${dir}" must be inside public_html/.`, { code: 'UNSAFE_DEPLOY_DIR' });
  }
  if (!SITE_KINDS.includes(kind)) throw new PlatformError(`Unknown site kind "${kind}".`, { code: 'INVALID_KIND' });

  if (kind === 'corporate') {
    if (d !== 'public_html/') throw new PlatformError(`Corporate site must deploy to public_html/ (got "${dir}").`, { code: 'UNSAFE_DEPLOY_DIR' });
    if (repo && repo !== CORPORATE_REPO && repo !== `mybizgate/${CORPORATE_REPO}`) {
      throw new PlatformError(`Only ${CORPORATE_REPO} may deploy to public_html/ (repository "${repo}" refused).`, { code: 'UNSAFE_DEPLOY_DIR' });
    }
    return d;
  }
  if (d === 'public_html/') {
    throw new PlatformError(`Refusing to deploy a ${kind} site to public_html/ (that is the corporate website root).`, { code: 'UNSAFE_DEPLOY_DIR' });
  }
  if (kind === 'demo') {
    const m = DEMO_DIR_RE.exec(d);
    if (!m) throw new PlatformError(`Demo sites must deploy to public_html/site-<slug>/ (got "${dir}").`, { code: 'UNSAFE_DEPLOY_DIR' });
    if (slug && m[1] !== slug) throw new PlatformError(`Demo deploy dir "${dir}" does not match slug "${slug}".`, { code: 'UNSAFE_DEPLOY_DIR' });
    return d;
  }
  const m = CLIENT_DIR_RE.exec(d);
  if (!m) throw new PlatformError(`Client sites must deploy to public_html/clients/<slug>/ (got "${dir}").`, { code: 'UNSAFE_DEPLOY_DIR' });
  if (slug && m[1] !== slug) throw new PlatformError(`Client deploy dir "${dir}" does not match slug "${slug}".`, { code: 'UNSAFE_DEPLOY_DIR' });
  return d;
}

// ---------------------------------------------------------------------------
// Naming conventions (slug is the permanent identity)
// ---------------------------------------------------------------------------
export const naming = {
  repoName: (slug) => `client-${slug}`,
  clientDirName: (slug) => `client-${slug}`,
  clientDir: (slug) => path.join(CLIENTS_DIR, `client-${slug}`),
  deployDir: (slug) => `public_html/clients/${slug}/`,
  demoDeployDir: (slug) => `public_html/site-${slug}/`,
  subdomainHost: (slug, env = loadEnv()) => `${slug}.${env.baseDomain}`,
  stagingHost: (slug, env = loadEnv()) => `stg-${slug}.${env.baseDomain}`,
  ftpUser: (slug) => `deploy-${slug}`,
  ftpLogin: (slug, env = loadEnv()) => `deploy-${slug}@${env.baseDomain}`,
  sshRemote: (repo, env = loadEnv()) => `git@${env.githubSshHost}:${env.githubOwner}/${repo}.git`,
  productionUrl: (host) => `https://${host}`,
  releaseTag: (shortSha, date = new Date()) => {
    const p = (n) => String(n).padStart(2, '0');
    return `prod-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}-${shortSha}`;
  },
};

// ---------------------------------------------------------------------------
// site.config.yml
// ---------------------------------------------------------------------------
export const SITE_CONFIG_FILE = 'site.config.yml';

export function defaultBuildConfig() {
  return {
    exclude: [],
    images: { convert: true, quality: 82, max_width: 1920, preserve: [] },
    cache_bust: true,
  };
}

export function buildSiteConfig({ name, slug, template, kind = 'client', domainType = 'subdomain', customDomain, dnsMode, visibility = 'private', ftpAccount = 'dedicated', env = loadEnv() }) {
  const cfg = {
    client: { name, slug },
    template: { type: template },
    domain: {},
    hosting: {},
    site: {},
    build: defaultBuildConfig(),
    qa: { lighthouse: false, browser_smoke: false, screenshots: false },
    github: { repo: kind === 'client' ? naming.repoName(slug) : undefined, visibility },
  };
  if (kind === 'client') {
    cfg.hosting.deploy_dir = naming.deployDir(slug);
    cfg.hosting.ftp_account = ftpAccount;
    if (domainType === 'subdomain') {
      cfg.domain = { type: 'subdomain', primary: naming.subdomainHost(slug, env) };
    } else {
      cfg.domain = { type: 'custom', primary: customDomain, staging: naming.stagingHost(slug, env), dns_mode: dnsMode || 'external' };
    }
  } else if (kind === 'demo') {
    cfg.hosting.deploy_dir = naming.demoDeployDir(slug);
    cfg.hosting.ftp_account = 'shared';
    cfg.domain = { type: 'subdomain', primary: naming.subdomainHost(slug, env) };
    cfg.github.repo = `site-${slug}`;
  } else {
    cfg.hosting.deploy_dir = 'public_html/';
    cfg.hosting.ftp_account = 'shared';
    cfg.domain = { type: 'custom', primary: env.baseDomain, dns_mode: 'awedns' };
    cfg.github.repo = CORPORATE_REPO;
  }
  cfg.site = { kind, environment: 'production', production_url: naming.productionUrl(cfg.domain.primary), identity: name };
  if (cfg.domain.staging) { cfg.site.staging_url = naming.productionUrl(cfg.domain.staging); cfg.site.environment = 'staging'; }
  return cfg;
}

export function serializeSiteConfig(cfg) {
  const header = '# MyBizGate site configuration. The slug is the permanent identity; the domain may change later.\n';
  return header + yaml.dump(JSON.parse(JSON.stringify(cfg)), { lineWidth: 100, noRefs: true, sortKeys: false });
}

export function parseSiteConfig(text, { source = SITE_CONFIG_FILE } = {}) {
  let data;
  try {
    data = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new PlatformError(`Could not parse ${source}: ${err.message}`, { code: 'INVALID_CONFIG' });
  }
  if (!data || typeof data !== 'object') throw new PlatformError(`${source} is empty or not a mapping.`, { code: 'INVALID_CONFIG' });
  return validateSiteConfig(data, { source });
}

export function validateSiteConfig(data, { source = SITE_CONFIG_FILE, repo } = {}) {
  const cfg = JSON.parse(JSON.stringify(data));
  const fail = (m) => { throw new PlatformError(`${source}: ${m}`, { code: 'INVALID_CONFIG' }); };
  if (!cfg.client || typeof cfg.client !== 'object') fail('missing "client" section.');
  cfg.client.name = validateBusinessName(cfg.client.name);
  cfg.client.slug = validateSlugForConfig(cfg.client.slug);
  cfg.site = cfg.site || {};
  cfg.site.kind = cfg.site.kind || 'client';
  if (!SITE_KINDS.includes(cfg.site.kind)) fail(`site.kind must be one of ${SITE_KINDS.join(', ')}.`);
  cfg.template = cfg.template || { type: 'blank' };
  if (!cfg.template.type) fail('template.type is required.');
  if (!cfg.domain || typeof cfg.domain !== 'object') fail('missing "domain" section.');
  cfg.domain.type = cfg.domain.type || 'subdomain';
  validateDomainType(cfg.domain.type);
  cfg.domain.primary = validateHostname(cfg.domain.primary, { label: 'domain.primary' });
  if (cfg.domain.type === 'custom') {
    cfg.domain.dns_mode = cfg.domain.dns_mode || 'external';
    validateDnsMode(cfg.domain.dns_mode);
    if (cfg.site.kind === 'client') {
      if (!cfg.domain.staging) fail('domain.staging is required for custom-domain clients (stg-<slug>.mybizgate.com).');
      cfg.domain.staging = validateHostname(cfg.domain.staging, { label: 'domain.staging' });
    }
  }
  if (!cfg.hosting || typeof cfg.hosting !== 'object') fail('missing "hosting" section.');
  cfg.hosting.deploy_dir = validateDeployDir(cfg.hosting.deploy_dir, { kind: cfg.site.kind, slug: cfg.client.slug, repo });
  cfg.hosting.ftp_account = cfg.hosting.ftp_account || (cfg.site.kind === 'client' ? 'dedicated' : 'shared');
  if (!['dedicated', 'shared'].includes(cfg.hosting.ftp_account)) fail('hosting.ftp_account must be "dedicated" or "shared".');
  cfg.site.production_url = cfg.site.production_url || naming.productionUrl(cfg.domain.primary);
  if (!/^https:\/\/[a-z0-9.-]+\/?$/.test(cfg.site.production_url)) fail('site.production_url must be an https:// origin.');
  cfg.site.identity = cfg.site.identity || cfg.client.name;
  cfg.site.environment = cfg.site.environment || 'production';
  if (!['production', 'staging'].includes(cfg.site.environment)) fail('site.environment must be "production" or "staging".');
  if (cfg.domain.staging) cfg.site.staging_url = cfg.site.staging_url || naming.productionUrl(cfg.domain.staging);
  cfg.build = { ...defaultBuildConfig(), ...(cfg.build || {}) };
  cfg.build.images = { ...defaultBuildConfig().images, ...((cfg.build && cfg.build.images) || {}) };
  cfg.build.exclude = Array.isArray(cfg.build.exclude) ? cfg.build.exclude : [];
  cfg.build.images.preserve = Array.isArray(cfg.build.images.preserve) ? cfg.build.images.preserve : [];
  cfg.qa = { lighthouse: false, browser_smoke: false, screenshots: false, ...(cfg.qa || {}) };
  cfg.github = cfg.github || {};
  if (!cfg.github.repo) {
    cfg.github.repo = cfg.site.kind === 'client' ? naming.repoName(cfg.client.slug) : cfg.site.kind === 'demo' ? `site-${cfg.client.slug}` : CORPORATE_REPO;
  }
  return cfg;
}

function validateSlugForConfig(slug) {
  // Demo/corporate slugs are allowed to use reserved names (petgate, mybizgate).
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new PlatformError(`client.slug "${slug}" is invalid.`, { code: 'INVALID_SLUG' });
  return slug;
}

export function siteConfigPath(siteDir) {
  return path.join(siteDir, SITE_CONFIG_FILE);
}

export function loadSiteConfig(siteDir, { repo } = {}) {
  const p = siteConfigPath(siteDir);
  if (!exists(p)) throw new PlatformError(`No ${SITE_CONFIG_FILE} found in ${siteDir}.`, { code: 'NO_CONFIG', hint: 'Run "mybizgate migrate-existing <site>" or create the file from platform/templates/static-site/site.config.example.yml.' });
  return parseSiteConfig(fs.readFileSync(p, 'utf8'), { source: p });
}

/** Resolve the FTP server-dir for the deploy action from hosting config. */
export function resolveServerDir(cfg) {
  if (cfg.hosting.ftp_account === 'dedicated') return './';
  return cfg.hosting.deploy_dir;
}

/** Resolve a site directory from a slug, a known site name, or a path. */
export function resolveSiteDir(ref) {
  if (!ref) throw new PlatformError('Site reference required (slug, site name or path).');
  const candidates = [
    path.resolve(ref),
    path.join(WORKSPACE_DIR, ref),
    path.join(CLIENTS_DIR, ref),
    path.join(CLIENTS_DIR, `client-${ref}`),
  ];
  for (const c of candidates) {
    if (exists(path.join(c, 'index.html')) || exists(path.join(c, SITE_CONFIG_FILE))) return c;
  }
  throw new PlatformError(`Could not find a site for "${ref}".`, { hint: `Looked in: ${candidates.join(', ')}` });
}

export function inferSiteKind(siteDir) {
  const base = path.basename(siteDir);
  if (base === CORPORATE_REPO) return 'corporate';
  if (DEMO_SITES.includes(base)) return 'demo';
  return 'client';
}
