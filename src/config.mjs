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

// The platform's own version (package.json). New client workflows are pinned to the matching
// release tag (vX.Y.Z) so a change on platform main never reaches a client until it is upgraded.
export const PLATFORM_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(PLATFORM_DIR, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })();
export const PLATFORM_RELEASE_REF = `v${PLATFORM_VERSION}`;
export const PLATFORM_REF_RE = /^(?:v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|main|[0-9a-f]{7,40})$/;

export function validatePlatformRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new PlatformError('platform_ref is required.', { code: 'INVALID_PLATFORM_REF' });
  const r = ref.trim();
  if (!PLATFORM_REF_RE.test(r)) throw new PlatformError(`platform_ref "${ref}" is invalid. Use a release tag such as ${PLATFORM_RELEASE_REF} (or a commit SHA).`, { code: 'INVALID_PLATFORM_REF' });
  return r;
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const RESERVED_SLUGS = new Set([
  'www', 'mail', 'ftp', 'cpanel', 'webmail', 'webdisk', 'whm', 'ns1', 'ns2', 'api', 'admin', 'autodiscover',
  'autoconfig', 'cpcontacts', 'cpcalendars', 'localhost', 'mybizgate', 'site', 'clients', 'client', 'stg', 'staging',
  'petgate', 'autogate', 'beautygate', 'dentalgate', 'supplygate',
]);

// Legacy template names accepted for CLI compatibility ("blank" is the built-in starter; the demo
// names copy a Gate demo and are deprecated). The template library in templates/ is discovered
// dynamically by src/templates.mjs and is the normal way to choose a template.
export const TEMPLATES = ['blank', 'petgate', 'autogate', 'beautygate', 'dentalgate', 'supplygate'];
export const TEMPLATE_ID_RE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
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
    platformRef: env.MYBIZGATE_PLATFORM_REF || PLATFORM_RELEASE_REF,
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

// Template identity as stored in site.config.yml: "blank", a legacy demo name, or
// "<business-type>/<template>" from the template library.
export function validateTemplateId(id) {
  if (typeof id !== 'string' || !id.trim()) throw new PlatformError('template.id is required.', { code: 'INVALID_TEMPLATE' });
  const v = id.trim();
  if (v.includes('..') || !TEMPLATE_ID_RE.test(v)) throw new PlatformError(`template.id "${id}" is invalid (expected <business-type>/<template>).`, { code: 'INVALID_TEMPLATE' });
  return v;
}

// ---------------------------------------------------------------------------
// Business information (wizard section "Business Information")
// ---------------------------------------------------------------------------
export const BUSINESS_FIELDS = [
  { key: 'whatsapp', label: 'WhatsApp', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'address', label: 'Address', required: true },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'opening_hours', label: 'Opening Hours', required: false },
  { key: 'facebook', label: 'Facebook', required: false },
  { key: 'instagram', label: 'Instagram', required: false },
  { key: 'tiktok', label: 'TikTok', required: false },
];
const DEFAULT_COUNTRY_CODE = '60'; // Malaysia
const E164_RE = /^\+[1-9]\d{7,14}$/;
const UNSAFE_TEXT_RE = /[\x00-\x1f<>`$\\]/;

/**
 * Normalise a WhatsApp number to E.164 (+60123456789). Local Malaysian forms such as
 * "012-345 6789" or "60123456789" are converted; the returned `note` explains any change so the
 * caller can report it. Values that cannot be normalised unambiguously throw.
 */
export function normalizeWhatsapp(raw, { countryCode = DEFAULT_COUNTRY_CODE } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new PlatformError('WhatsApp number is required.', { code: 'INVALID_WHATSAPP' });
  const original = raw.trim();
  let v = original.replace(/^(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?/i, '');
  v = v.replace(/[\s().-]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  let note = null;
  if (v.startsWith('+')) {
    // already international
  } else if (/^0\d+$/.test(v)) {
    v = `+${countryCode}${v.slice(1)}`;
    note = `interpreted as a Malaysian number (+${countryCode})`;
  } else if (new RegExp(`^${countryCode}\\d+$`).test(v)) {
    v = `+${v}`;
  } else if (/^\d+$/.test(v)) {
    throw new PlatformError(`WhatsApp number "${original}" is ambiguous. Use the international form, e.g. +60123456789.`, { code: 'INVALID_WHATSAPP' });
  }
  if (!E164_RE.test(v)) throw new PlatformError(`WhatsApp number "${original}" is not valid. Use the international form, e.g. +60123456789.`, { code: 'INVALID_WHATSAPP' });
  return { value: v, changed: v !== original, note, original };
}

export function validateEmail(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new PlatformError('Email is required.', { code: 'INVALID_EMAIL' });
  const v = raw.trim();
  if (v.length > 254 || !/^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(v)) {
    throw new PlatformError(`Email "${raw}" is not a valid address.`, { code: 'INVALID_EMAIL' });
  }
  return v;
}

export function validateFreeText(raw, { label = 'Value', required = false, max = 300 } = {}) {
  const v = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!v) { if (required) throw new PlatformError(`${label} is required.`, { code: 'INVALID_INPUT' }); return ''; }
  if (v.length > max) throw new PlatformError(`${label} must be ${max} characters or fewer.`, { code: 'INVALID_INPUT' });
  if (UNSAFE_TEXT_RE.test(v)) throw new PlatformError(`${label} contains unsafe characters.`, { code: 'INVALID_INPUT' });
  return v;
}

export function validatePhone(raw) {
  const v = validateFreeText(raw, { label: 'Phone', max: 40 });
  if (v && !/^\+?[\d\s().-]{6,}$/.test(v)) throw new PlatformError(`Phone "${raw}" is not a valid number.`, { code: 'INVALID_INPUT' });
  return v;
}

// Social links: a full URL or a handle (with or without @); stored as given, trimmed.
export function validateSocial(raw, { label = 'Social link' } = {}) {
  const v = validateFreeText(raw, { label, max: 200 });
  if (v && /\s/.test(v)) throw new PlatformError(`${label} must be a URL or a handle without spaces.`, { code: 'INVALID_INPUT' });
  if (v && /^https?:\/\//i.test(v)) { try { new URL(v); } catch { throw new PlatformError(`${label} "${raw}" is not a valid URL.`, { code: 'INVALID_INPUT' }); } }
  return v;
}

/**
 * Validate the business-information fields. Required fields are only enforced when
 * `requireContact` is true (the interactive wizard); CLI automation may omit them.
 * Returns { business, notes } where notes describe normalisations (never silent).
 */
export function normalizeBusinessInfo(input = {}, { requireContact = false } = {}) {
  const business = {};
  const notes = [];
  const has = (k) => typeof input[k] === 'string' && input[k].trim() !== '';
  if (has('whatsapp') || requireContact) {
    const w = normalizeWhatsapp(input.whatsapp);
    business.whatsapp = w.value;
    if (w.changed) notes.push(`WhatsApp "${w.original}" normalised to ${w.value}${w.note ? ` (${w.note})` : ''}`);
  }
  if (has('email') || requireContact) business.email = validateEmail(input.email);
  if (has('address') || requireContact) business.address = validateFreeText(input.address, { label: 'Address', required: requireContact, max: 300 });
  if (has('phone')) business.phone = validatePhone(input.phone);
  if (has('openingHours') || has('opening_hours')) business.opening_hours = validateFreeText(input.openingHours || input.opening_hours, { label: 'Opening hours', max: 200 });
  for (const k of ['facebook', 'instagram', 'tiktok']) if (has(k)) business[k] = validateSocial(input[k], { label: k.charAt(0).toUpperCase() + k.slice(1) });
  // Presentation fields used by templates (all optional; templates derive defaults otherwise).
  const text = (camel, snake, label, max) => { if (has(camel) || has(snake)) business[snake] = validateFreeText(input[camel] || input[snake], { label, max }); };
  text('shortName', 'short_name', 'Short name', 60);
  text('locality', 'locality', 'Locality', 80);
  text('seoTitle', 'seo_title', 'SEO title', 120);
  text('seoDescription', 'seo_description', 'SEO description', 320);
  return { business, notes };
}

export function validateImagesFolder(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return { path: null, exists: false, images: 0 };
  const p = path.resolve(v.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  if (/[\x00-\x1f]/.test(p)) throw new PlatformError('Images folder path contains unsafe characters.', { code: 'INVALID_INPUT' });
  let stat = null;
  try { stat = fs.statSync(p); } catch { stat = null; }
  if (!stat) return { path: p, exists: false, images: 0 };
  if (!stat.isDirectory()) throw new PlatformError(`Images folder ${p} is not a directory.`, { code: 'INVALID_INPUT' });
  const images = fs.readdirSync(p).filter((f) => /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(f)).length;
  return { path: p, exists: true, images };
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

export function buildSiteConfig({ name, slug, template, templateVersion = null, business, platformRef, kind = 'client', domainType = 'subdomain', customDomain, dnsMode, visibility = 'private', ftpAccount = 'dedicated', env = loadEnv() }) {
  const cfg = {
    client: { name, slug },
    template: { id: validateTemplateId(template), version: templateVersion || null },
    platform_ref: validatePlatformRef(platformRef || env.platformRef),
    domain: {},
    business: business && Object.keys(business).length ? { ...business } : undefined,
    hosting: {},
    site: {},
    build: defaultBuildConfig(),
    qa: { lighthouse: false, browser_smoke: false, screenshots: false },
    github: { repo: kind === 'client' ? naming.repoName(slug) : undefined, visibility },
  };
  if (!cfg.business) delete cfg.business;
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
  // template.id is the library reference (<business-type>/<template>); older configs used
  // template.type with a demo name. Both are accepted and template.id is always populated.
  cfg.template = cfg.template || { id: 'blank' };
  if (typeof cfg.template !== 'object') fail('"template" must be a mapping.');
  if (!cfg.template.id && !cfg.template.type) fail('template.id is required.');
  cfg.template.id = validateTemplateId(cfg.template.id || cfg.template.type);
  if (cfg.template.type && cfg.template.type !== cfg.template.id) fail(`template.type (${cfg.template.type}) and template.id (${cfg.template.id}) disagree.`);
  if (cfg.template.version != null && (typeof cfg.template.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cfg.template.version))) fail(`template.version "${cfg.template.version}" is not a valid semantic version.`);
  if (cfg.template.version == null) cfg.template.version = null;
  if (cfg.business != null) {
    if (typeof cfg.business !== 'object' || Array.isArray(cfg.business)) fail('"business" must be a mapping.');
    const { business } = normalizeBusinessInfo({ ...cfg.business, openingHours: cfg.business.opening_hours });
    cfg.business = business;
  }
  if (cfg.platform_ref != null) cfg.platform_ref = validatePlatformRef(cfg.platform_ref);
  // Local machine paths never belong in a committed config; they live in .mybizgate.local.yml.
  if (cfg.assets && typeof cfg.assets === 'object' && cfg.assets.images_source) {
    fail('assets.images_source is a local path and must not be committed; move it to .mybizgate.local.yml (gitignored).');
  }
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
