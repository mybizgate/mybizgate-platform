// New-client provisioning flow: validate -> plan -> (apply) create project, Git,
// GitHub, hosting, secrets, build, push, deploy, DNS, SSL, health.
// Every step is idempotent and progress is stored in <client>/.mybizgate/state.json
// so a partial run can be resumed with --resume.
//
// Two entry modes share this file: the interactive wizard (`wizard()`, used when no --name is
// given) and the CLI argument mode. Both feed `newClient()`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { log, PlatformError, exists, readJson, writeJson, commandExists } from './utils.mjs';
import {
  loadEnv, naming, validateSlug, validateBusinessName, validateDomainType, validateDnsMode, validateVisibility,
  validateCustomDomain, validateProjectType, buildSiteConfig, serializeSiteConfig, loadSiteConfig, DOMAIN_TYPES, DNS_MODES, VISIBILITIES,
  WORKSPACE_DIR, PLATFORM_DIR, SITE_CONFIG_FILE, validateSiteConfig, validatePlatformRef, PLATFORM_VERSION,
  BUSINESS_FIELDS, normalizeWhatsapp, validateEmail, validateFreeText, validatePhone, validateSocial, normalizeBusinessInfo, validateImagesFolder,
} from './config.mjs';
import {
  templatesDir, discoverCategories, discoverTemplates, resolveTemplate, templateStatusText, humanize,
  TEMPLATE_COPY_EXCLUDES, BLANK_TEMPLATE, PLACEHOLDER_WARNING, PLACEHOLDER_STOP_LINES,
} from './templates.mjs';
import { buildContext, personalizeProject, scanResidue, residuePatternsFor, formatResidue, missingRequiredContent, deriveShortName, deriveLocality } from './personalize.mjs';
import { createConsoleIo } from './prompt.mjs';

// Local-only provisioning input (machine paths); never committed, never built, never deployed.
export const LOCAL_CONFIG_FILE = '.mybizgate.local.yml';
import * as git from './git.mjs';
import { hostingPlan, ensureSubdomain, ensureCustomDomain, ensureDedicatedFtp, sharedFtp } from './hosting.mjs';
import { checkDns, waitForDns, waitForDelegation, hostingIp, dnsInstructions, checkDelegation } from './dns.mjs';
import { ensureAutoSSL, waitForHttps } from './ssl.mjs';
import { qaDist, waitForHealthy, healthCheck } from './verify.mjs';
import { buildWithEngine } from './build.mjs';

const TEMPLATE_DIR = path.join(PLATFORM_DIR, 'templates', 'static-site');
const COPY_EXCLUDES = ['.git', 'dist', 'node_modules', '.github', '.ftp-deploy-sync-state.json', '.env', '.env.*', '*.log', 'site.config.yml', 'README.md', 'README.txt', 'AGENTS.md', '.mybizgate', '.mybizgate-build-report.json', '.lighthouse', '.screenshots', '.DS_Store'];

export const WIZARD_TITLE = 'MyBizgate - Multi Tenancy SaaS Wizard';
const RULE = '='.repeat(56);
const THIN_RULE = '-'.repeat(56);
export const DOMAIN_TYPE_LABELS = { subdomain: 'MyBizGate Subdomain', custom: 'Client Custom Domain' };
export const PROJECT_TYPE_LABELS = { client: 'Client Website', demo: 'Demo Website' };
const DNS_MODE_LABELS = { external: 'External DNS (client keeps their nameservers; A-record instructions are generated)', awedns: 'AweDNS nameservers (client points the domain at ns1/ns2.awedns.com)' };
export const MODES = [{ id: 'dry-run', label: 'Dry Run' }, { id: 'apply', label: 'Apply / Provision' }];

export function suggestSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------
export function wizardHeader() {
  return `${RULE}\n        ${WIZARD_TITLE}\n${RULE}\n`;
}

/**
 * Run the interactive wizard. `initial` holds values already given on the command line (they are
 * not asked again). Returns the raw input for `newClient()` plus `apply` (chosen mode) and the
 * display names used in the summary. Nothing is created here.
 */
export async function wizard(initial = {}, env = loadEnv(), { io = createConsoleIo(), templatesRoot = templatesDir() } = {}) {
  const say = (s = '') => io.write(`${s}\n`);
  const status = (tag, s) => io.write(`${tag} ${s}\n`);
  const section = (title) => { say(title); say(''); };

  // Ask a free-text question. Shows "<label>:" then a "> " prompt; re-asks on validation errors.
  const askText = async (label, { def = '', validate, optional = false, hint } = {}) => {
    for (;;) {
      say(`${label}${hint ? ` (${hint})` : ''}:`);
      let answer = await io.question('> ');
      if (!answer && def) answer = def;
      if (!answer && optional) { say(''); return ''; }
      try { const v = validate ? validate(answer) : answer; say(''); return v; } catch (err) { status('[FAIL]', err.message); if (err.hint) status('[INFO]', err.hint); say(''); }
    }
  };
  // Numbered menu; accepts the number or the item id. Returns the chosen item.
  const askMenu = async (title, items, { prompt = 'Select', def } = {}) => {
    for (;;) {
      say(title);
      say('');
      items.forEach((it, i) => say(`[${i + 1}] ${it.label}`));
      say('');
      say(`${prompt}${def ? ` [${def}]` : ''}:`);
      const raw = (await io.question('> ')) || (def ? String(def) : '');
      const n = Number(raw);
      let chosen = Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : items.find((it) => it.id === raw);
      if (chosen) { say(''); return chosen; }
      status('[FAIL]', `Invalid selection "${raw}". Enter a number between 1 and ${items.length}.`);
      say('');
    }
  };

  try {
    const out = { ...initial };
    io.write(wizardHeader());
    say('');

    // ---- Project type and identity ------------------------------------------
    if (!out.projectType) {
      const chosen = await askMenu('Project Type', Object.entries(PROJECT_TYPE_LABELS).map(([id, label]) => ({ id, label })), { prompt: 'Create as', def: 1 });
      out.projectType = chosen.id;
    } else {
      validateProjectType(out.projectType);
      say(`Project Type: ${PROJECT_TYPE_LABELS[out.projectType]}`); say('');
    }
    const isDemo = out.projectType === 'demo';
    section(isDemo ? 'Demo Information' : 'Client Information');
    if (!out.name) out.name = await askText('Business Name', { validate: validateBusinessName });
    else { say(`Business Name: ${out.name}`); say(''); }
    if (!out.slug) {
      const suggested = suggestSlug(out.name);
      say('Suggested slug:'); say(suggested || '(none)'); say('');
      out.slug = await askText(isDemo ? 'Demo slug' : 'Client slug', { def: suggested, validate: validateSlug, hint: suggested ? 'Enter to accept the suggestion' : 'lowercase letters, digits and hyphens' });
    } else { validateSlug(out.slug); say(`${isDemo ? 'Demo' : 'Client'} slug: ${out.slug}`); say(''); }
    if (!out.shortName) {
      const derived = deriveShortName(out.name);
      out.shortName = await askText('Short name shown in menus and WhatsApp greetings', { def: derived, optional: true, validate: (v) => validateFreeText(v, { label: 'Short name', max: 60 }), hint: `Enter for "${derived}"` });
    }

    // ---- Business type / template (discovered from templates/) --------------
    let template = null;
    if (out.template) {
      template = resolveTemplate(out.template, { root: templatesRoot });
      say(`Template: ${template.ref} (${template.name})`); say('');
    } else {
      for (;;) {
        const categories = discoverCategories({ root: templatesRoot });
        if (!categories.length) {
          throw new PlatformError(`No business types found in ${templatesRoot}.`, { code: 'NO_TEMPLATES', hint: 'Create templates/<business-type>/<template>/ (a .gitkeep is enough for a placeholder), or pass --template blank on the command line.' });
        }
        const category = await askMenu('Available Business Types', categories.map((c) => ({ id: c.id, label: c.name, category: c })), { prompt: 'Select business type' });
        const templates = discoverTemplates(category.id, { root: templatesRoot });
        if (!templates.length) { status('[WARN]', `No templates found under ${path.relative(WORKSPACE_DIR, category.category.dir) || category.category.dir}/. Choose another business type.`); say(''); continue; }
        const chosen = await askMenu(`${category.label} Templates`, templates.map((t) => ({ id: t.folder, label: t.name, template: t })), { prompt: 'Select template' });
        template = chosen.template;
        break;
      }
    }
    for (const w of template.warnings) status('[WARN]', w);
    if (template.usable) status('[ OK ]', `Template ${template.ref}: ${templateStatusText(template)}`);
    else status('[WARN]', PLACEHOLDER_WARNING(template.ref));
    say('');
    out.template = template.ref;
    out.businessType = template.categoryName;

    // ---- Domain -------------------------------------------------------------
    if (isDemo) {
      if (out.domainType && out.domainType !== 'subdomain') throw new PlatformError('Demo projects support the MyBizGate subdomain only.', { code: 'INVALID_DOMAIN_TYPE' });
      out.domainType = 'subdomain';
      say(`Demo Domain: ${naming.subdomainHost(out.slug, env)}`); say('');
    } else if (!out.domainType) {
      const d = await askMenu('Domain Type', DOMAIN_TYPES.map((t, i) => ({ id: t, label: DOMAIN_TYPE_LABELS[t] })), { def: 1 });
      out.domainType = d.id;
    } else validateDomainType(out.domainType);
    if (!isDemo && out.domainType === 'subdomain') {
      say(`Domain: ${naming.subdomainHost(out.slug, env)}`); say('');
    } else if (!isDemo) {
      if (!out.domain) out.domain = await askText('Custom domain', { validate: (v) => validateCustomDomain(v, env), hint: 'e.g. pawhaven.com.my' });
      if (!out.dnsMode) { const m = await askMenu('DNS Mode', ['external', 'awedns'].filter((t) => DNS_MODES.includes(t)).map((t) => ({ id: t, label: DNS_MODE_LABELS[t] })), { def: 1 }); out.dnsMode = m.id; }
      else validateDnsMode(out.dnsMode);
      say(`Domain: ${out.domain} (staging: ${naming.stagingHost(out.slug, env)}, dns_mode=${out.dnsMode})`); say('');
    }
    if (out.visibility) validateVisibility(out.visibility);

    // ---- Business information -----------------------------------------------
    section('Business Information');
    const fieldValidators = {
      whatsapp: (v) => { const w = normalizeWhatsapp(v); if (w.changed) status('[INFO]', `WhatsApp "${w.original}" normalised to ${w.value}${w.note ? ` (${w.note})` : ''}`); return w.value; },
      email: validateEmail,
      address: (v) => validateFreeText(v, { label: 'Address', required: true }),
      phone: validatePhone,
      opening_hours: (v) => validateFreeText(v, { label: 'Opening hours', max: 200 }),
      facebook: (v) => validateSocial(v, { label: 'Facebook' }),
      instagram: (v) => validateSocial(v, { label: 'Instagram' }),
      tiktok: (v) => validateSocial(v, { label: 'TikTok' }),
    };
    const inputKey = { opening_hours: 'openingHours' };
    for (const f of BUSINESS_FIELDS) {
      const key = inputKey[f.key] || f.key;
      if (out[key]) out[key] = fieldValidators[f.key](out[key]);
      else out[key] = await askText(f.label, { validate: fieldValidators[f.key], optional: !f.required, hint: f.required ? undefined : 'optional, Enter to skip' });
      if (f.key === 'address' && !out.locality) {
        const derived = deriveLocality(out.address);
        out.locality = await askText('Area / city shown on the website', { def: derived, optional: true, validate: (v) => validateFreeText(v, { label: 'Locality', max: 80 }), hint: derived ? `Enter for "${derived}"` : 'optional' });
      }
    }

    // ---- Project images -----------------------------------------------------
    section(isDemo ? 'Demo Images' : 'Client Images');
    if (out.images == null) out.images = await askText(isDemo ? 'Demo images folder' : 'Client images folder', { optional: true, hint: 'optional, e.g. /home/jul/Downloads/pawhaven' });
    const images = validateImagesFolder(out.images);
    if (!images.path) status('[INFO]', `No ${isDemo ? 'demo' : 'client'} image folder supplied.`);
    else if (!images.exists) status('[WARN]', `Images folder ${images.path} does not exist yet; recorded locally in ${LOCAL_CONFIG_FILE} (never committed).`);
    else status('[ OK ]', `${images.images} image file(s) found in ${images.path} (recorded locally in ${LOCAL_CONFIG_FILE}, never committed)`);
    say('');

    // ---- Mode ---------------------------------------------------------------
    if (out.apply === true) { status('[INFO]', 'Mode: Apply / Provision (--apply given on the command line)'); say(''); }
    else {
      const mode = await askMenu('Mode', MODES, { def: 1 });
      out.apply = mode.id === 'apply';
    }
    return out;
  } finally {
    io.close();
  }
}

export async function confirm(question, { io } = {}) {
  const useIo = io || (process.stdin.isTTY ? createConsoleIo() : null);
  if (!useIo) return false;
  try {
    const answer = await useIo.question(`${question} [y/N]: `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    if (!io) useIo.close();
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
export function statePath(clientDir) { return path.join(clientDir, '.mybizgate', 'state.json'); }
export function loadState(clientDir) { return readJson(statePath(clientDir), null); }
export function saveState(clientDir, state) { state.updatedAt = new Date().toISOString(); writeJson(statePath(clientDir), state); }

function resolveProvisioningDir(slug, projectType) {
  if (projectType) return naming.projectDir(validateProjectType(projectType), slug);
  const matches = ['client', 'demo']
    .map((kind) => ({ kind, dir: naming.projectDir(kind, slug) }))
    .filter(({ dir }) => exists(dir));
  if (matches.length === 1) return matches[0].dir;
  if (matches.length > 1) throw new PlatformError(`Both client and demo projects exist for slug "${slug}".`, { hint: 'Re-run with --project-type client or --project-type demo.' });
  return naming.clientDir(slug);
}

// ---------------------------------------------------------------------------
// Input -> config
// ---------------------------------------------------------------------------
export function normalizeInput(input, env = loadEnv(), { templatesRoot = templatesDir(), requireContact = false } = {}) {
  const name = validateBusinessName(input.name);
  const slug = validateSlug(input.slug);
  const projectType = validateProjectType(input.projectType || 'client');
  const templateRecord = resolveTemplate(input.template || BLANK_TEMPLATE, { root: templatesRoot });
  const domainType = validateDomainType(input.domainType || 'subdomain');
  if (projectType === 'demo' && domainType !== 'subdomain') throw new PlatformError('Demo projects support the MyBizGate subdomain only.', { code: 'INVALID_DOMAIN_TYPE' });
  const visibility = validateVisibility(input.visibility || (projectType === 'demo' ? 'public' : 'private'));
  let customDomain; let dnsMode;
  if (domainType === 'custom') {
    customDomain = validateCustomDomain(input.domain, env);
    dnsMode = validateDnsMode(input.dnsMode || 'external');
  }
  const ftpAccount = input.ftpAccount === 'shared' ? 'shared' : 'dedicated';
  const { business, notes } = normalizeBusinessInfo(input, { requireContact });
  const images = validateImagesFolder(input.images);
  const platformRef = validatePlatformRef(input.platformRef || env.platformRef);
  return {
    name, slug, projectType, template: templateRecord.ref, templateRecord, templateVersion: templateRecord.version, businessType: input.businessType || templateRecord.categoryName,
    domainType, visibility, customDomain, dnsMode, ftpAccount, business, businessNotes: notes, platformRef,
    // Local-only input: kept out of site.config.yml on purpose (machine path).
    images, local: { images_source: images.path },
  };
}

// The caller workflow for a site, pinned to a platform release so platform main never
// reaches a client until it is upgraded deliberately (mybizgate platform-ref --set).
export function renderCallerWorkflow(env = loadEnv(), ref = env.platformRef) {
  const r = validatePlatformRef(ref);
  return fs.readFileSync(path.join(TEMPLATE_DIR, '.github', 'workflows', 'deploy.yml'), 'utf8')
    .replace('mybizgate/mybizgate-platform/', `${env.githubOwner}/${env.platformRepo}/`)
    .replaceAll('{{PLATFORM_REF}}', r);
}

export function readPlatformRef(siteDir) {
  const p = path.join(siteDir, '.github', 'workflows', 'deploy.yml');
  if (!exists(p)) return null;
  const m = /static-site-deploy\.yml@(\S+)/.exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1] : null;
}

export function writeLocalConfig(clientDir, local = {}) {
  const data = Object.fromEntries(Object.entries(local).filter(([, v]) => v != null && v !== ''));
  if (!Object.keys(data).length) return null;
  const p = path.join(clientDir, LOCAL_CONFIG_FILE);
  const header = '# Local provisioning input for this machine only. Gitignored, never built or deployed.\n# Safe to delete. Paths here are not portable between machines.\n';
  fs.writeFileSync(p, header + yaml.dump({ ...data, platform_version: PLATFORM_VERSION, updated_at: new Date().toISOString() }, { lineWidth: 120 }));
  return p;
}

export function readLocalConfig(clientDir) {
  const p = path.join(clientDir, LOCAL_CONFIG_FILE);
  if (!exists(p)) return {};
  try { const d = yaml.load(fs.readFileSync(p, 'utf8'), { schema: yaml.JSON_SCHEMA }); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}

export function planFor(cfg, env = loadEnv()) {
  const slug = cfg.client.slug;
  const repo = cfg.github.repo;
  const lines = [];
  lines.push({ id: 'project', text: `Create ${path.relative(WORKSPACE_DIR, naming.projectDir(cfg.site.kind, slug))}/ from template "${cfg.template.id}"` });
  lines.push({ id: 'config', text: `Write ${SITE_CONFIG_FILE}, .gitignore, README.md and the minimal deploy workflow` });
  lines.push({ id: 'git', text: 'Initialise Git with branches main (development) and deploy (production)' });
  lines.push({ id: 'github', text: `Create GitHub repository ${env.githubOwner}/${repo} (${cfg.github.visibility}) and set remote ${naming.sshRemote(repo, env)}` });
  for (const s of hostingPlan(cfg, env)) lines.push(s);
  lines.push({ id: 'variables', text: `Set GitHub variables SITE_NAME, SITE_DOMAIN, DEPLOY_DIR=${cfg.hosting.deploy_dir} and secrets FTP_SERVER, FTP_USERNAME, FTP_PASSWORD` });
  lines.push({ id: 'build', text: 'Run the optimised local build and QA (dist/)' });
  lines.push({ id: 'push', text: 'Push main and deploy; GitHub Actions builds and deploys dist/' });
  lines.push({ id: 'verify', text: `Verify DNS, HTTPS/AutoSSL and production health for ${cfg.site.staging_url || cfg.site.production_url}` });
  return lines;
}

// The block shown before anything is created (wizard and CLI mode alike).
export function clientSummary(cfg, env = loadEnv(), { template, businessType, apply = false, images } = {}) {
  const row = (k, v) => `${k.padEnd(17)}: ${v}`;
  const isDemo = cfg.site.kind === 'demo';
  const lines = [THIN_RULE, `NEW ${isDemo ? 'DEMO' : 'CLIENT'} SUMMARY`, THIN_RULE];
  lines.push(row('Project Type', PROJECT_TYPE_LABELS[cfg.site.kind] || humanize(cfg.site.kind)));
  lines.push(row('Business', cfg.client.name));
  lines.push(row('Slug', cfg.client.slug));
  lines.push(row('Business Type', businessType || (template && template.categoryName) || humanize((cfg.template.id.split('/')[0]) || '')));
  lines.push(row('Template', cfg.template.id + (cfg.template.version ? ` (v${cfg.template.version})` : '')));
  if (template) lines.push(row('Template Status', template.usable ? templateStatusText(template) : 'PLACEHOLDER - no website source yet'));
  lines.push(row('Platform Ref', cfg.platform_ref || '(unpinned)'));
  if (cfg.business && cfg.business.short_name) lines.push(row('Short Name', cfg.business.short_name));
  lines.push(row('Domain Type', DOMAIN_TYPE_LABELS[cfg.domain.type] || cfg.domain.type));
  lines.push(row('Domain', cfg.domain.primary));
  if (cfg.domain.staging) lines.push(row('Staging', cfg.domain.staging));
  if (cfg.domain.dns_mode) lines.push(row('DNS Mode', cfg.domain.dns_mode));
  lines.push(row('GitHub Repo', `${env.githubOwner}/${cfg.github.repo}`));
  lines.push(row('Hosting Directory', cfg.hosting.deploy_dir));
  const b = cfg.business || {};
  lines.push(row('WhatsApp', b.whatsapp || '(not set)'));
  lines.push(row('Email', b.email || '(not set)'));
  if (b.address) lines.push(row('Address', b.address));
  if (b.phone) lines.push(row('Phone', b.phone));
  if (b.opening_hours) lines.push(row('Opening Hours', b.opening_hours));
  for (const k of ['facebook', 'instagram', 'tiktok']) if (b[k]) lines.push(row(k === 'tiktok' ? 'TikTok' : k.charAt(0).toUpperCase() + k.slice(1), b[k]));
  const img = images || null;
  lines.push(row('Images (local)', img && img.path ? `${img.path}${img.exists === false ? ' (not found)' : img.images != null ? ` (${img.images} image file(s))` : ''} -> ${LOCAL_CONFIG_FILE}` : '(none)'));
  lines.push(row('Mode', apply ? 'Apply / Provision' : 'Dry Run'));
  lines.push(THIN_RULE);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Template copy
// ---------------------------------------------------------------------------
export function copyTemplate(template, dest) {
  const record = typeof template === 'string' ? resolveTemplate(template) : template;
  if (record.ref === BLANK_TEMPLATE) {
    fs.mkdirSync(dest, { recursive: true });
    return 0;
  }
  if (!record.usable) throw new PlatformError(`Template ${record.ref} has no website source (${templateStatusText(record)}); refusing to create a broken website.`, { code: 'TEMPLATE_PLACEHOLDER' });
  const src = record.dir;
  if (!exists(path.join(src, 'index.html'))) throw new PlatformError(`Template source ${src} has no index.html.`, { code: 'TEMPLATE_PLACEHOLDER' });
  const files = walkSync(src, [...COPY_EXCLUDES, ...TEMPLATE_COPY_EXCLUDES]);
  for (const rel of files) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
  }
  return files.length;
}

function walkSync(root, excludes) {
  const out = [];
  const matches = (rel) => excludes.some((p) => {
    const base = path.posix.basename(rel);
    if (p.includes('*')) { const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`); return re.test(base); }
    return rel === p || base === p || rel.startsWith(`${p}/`);
  });
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (matches(rel)) continue;
      if (e.isDirectory()) visit(abs); else if (e.isFile()) out.push(rel);
    }
  };
  visit(root);
  return out.sort();
}

function blankIndex(cfg) {
  const wa = (cfg.business && cfg.business.whatsapp ? cfg.business.whatsapp : '+60123456789').replace(/\D/g, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="build-version" content="__BUILD_VERSION__">
  <title>${escapeHtml(cfg.client.name)}</title>
  <meta name="description" content="${escapeHtml(cfg.client.name)} - website by MyBizGate.">
  <link rel="canonical" href="${cfg.site.production_url}/">
  <link rel="stylesheet" href="style.css?v=__BUILD_VERSION__">
</head>
<body>
  <main class="hero">
    <h1>${escapeHtml(cfg.client.name)}</h1>
    <p>Website coming soon. Built with MyBizGate.</p>
    <a class="cta" href="https://wa.me/${wa}?text=Hello%20${encodeURIComponent(cfg.client.name)}">WhatsApp us</a>
  </main>
  <script src="script.js?v=__BUILD_VERSION__" defer></script>
</body>
</html>
`;
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function writeProjectFiles(cfg, clientDir, { env = loadEnv(), local } = {}) {
  fs.mkdirSync(clientDir, { recursive: true });
  const write = (rel, content) => { const p = path.join(clientDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  write(SITE_CONFIG_FILE, serializeSiteConfig(cfg));
  write('.gitignore', fs.readFileSync(path.join(TEMPLATE_DIR, '.gitignore'), 'utf8'));
  write('.github/workflows/deploy.yml', renderCallerWorkflow(env, cfg.platform_ref || env.platformRef));
  if (local) writeLocalConfig(clientDir, local);
  const readme = fs.readFileSync(path.join(TEMPLATE_DIR, 'README.md'), 'utf8')
    .replaceAll('{{SITE_NAME}}', cfg.client.name).replaceAll('{{SLUG}}', cfg.client.slug)
    .replaceAll('{{DEPLOY_DIR}}', cfg.hosting.deploy_dir).replaceAll('{{PRODUCTION_URL}}', cfg.site.production_url);
  write('README.md', readme);
  if (!exists(path.join(clientDir, 'index.html'))) {
    write('index.html', blankIndex(cfg));
    write('style.css', `:root{--brand:#1F5E6E}body{font-family:system-ui,sans-serif;margin:0;color:#1C2A31;background:#FBF7F1}.hero{min-height:100vh;display:grid;place-content:center;text-align:center;padding:24px}.cta{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:999px;background:#25D366;color:#fff;text-decoration:none}.cta:focus-visible{outline:3px solid var(--brand)}\n`);
    write('script.js', `document.addEventListener('DOMContentLoaded', () => {\n  console.log('${cfg.client.slug} ready');\n});\n`);
  }
}

/**
 * Generate a complete, personalised project at `dir` from the template and config.
 * Local only: copies the template source, writes the platform files, applies the business
 * information to every token and scans for residue. Returns what happened; it does not throw on
 * residue so callers (dry run, apply) can decide how to report it.
 */
export function generateClientProject(cfg, dir, { template, env = loadEnv(), local } = {}) {
  const count = copyTemplate(template, dir);
  writeProjectFiles(cfg, dir, { env, local });
  const ctx = buildContext(cfg, template);
  const personalized = personalizeProject(dir, ctx);
  const residue = scanResidue(dir, { patterns: residuePatternsFor(template) });
  return { files: count, context: ctx, personalized, residue };
}

function safeResolveTemplate(id, templatesRoot) {
  try { return resolveTemplate(id, { root: templatesRoot }); } catch (err) {
    return { ref: id, id, name: id, categoryName: humanize(String(id).split('/')[0]), usable: false, placeholder: true, status: 'missing', files: 0, version: null, dir: null, warnings: [err.message], legacy: false };
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
export async function newClient(rawInput, { env = loadEnv(), cpanel, github, apply = false, resume = false, yes = false, io, templatesRoot = templatesDir(), requireContact = false } = {}) {
  const resumeSlug = rawInput.slug;
  let cfg; let clientDir; let state; let tpl; let input = null;

  if (resume) {
    validateSlug(resumeSlug);
    clientDir = resolveProvisioningDir(resumeSlug, rawInput.projectType);
    if (!exists(clientDir)) throw new PlatformError(`Cannot resume: ${clientDir} does not exist.`);
    cfg = loadSiteConfig(clientDir);
    state = loadState(clientDir) || { slug: resumeSlug, steps: {} };
    tpl = safeResolveTemplate(cfg.template.id, templatesRoot);
    log.info(`Resuming provisioning of ${cfg.client.name} (${resumeSlug}) from ${statePath(clientDir)}`);
  } else {
    input = normalizeInput(rawInput, env, { templatesRoot, requireContact });
    tpl = input.templateRecord;
    cfg = validateSiteConfig(buildSiteConfig({ ...input, kind: input.projectType, env }));
    clientDir = naming.projectDir(cfg.site.kind, cfg.client.slug);
    state = loadState(clientDir) || { slug: cfg.client.slug, kind: cfg.site.kind, createdAt: new Date().toISOString(), steps: {} };
  }
  const slug = cfg.client.slug;
  const repo = cfg.github.repo;
  const steps = state.steps;
  const done = (id) => Boolean(steps[id] && steps[id].done);
  const mark = (id, data = {}) => { steps[id] = { ...(steps[id] || {}), ...data, done: true, at: new Date().toISOString() }; if (apply) saveState(clientDir, state); };

  // ---- Validate dependencies and environment --------------------------------
  log.check('Dependencies');
  for (const tool of ['git', 'node']) if (!(await commandExists(tool))) throw new PlatformError(`Missing dependency: ${tool}`);
  const ghAvailable = await github.available();
  if (!ghAvailable) log.warn('GitHub CLI (gh) not found; GitHub steps cannot run.');
  log.ok('git, node present');

  log.check('Environment');
  if (!cpanel.configured) log.warn('cPanel API not configured (CPANEL_TOKEN missing); hosting steps cannot run. Add it to the workspace .env or export it; `mybizgate env` shows what is set.');
  else log.ok('cPanel API configured');
  const ghAuth = ghAvailable ? await github.authStatus() : { ok: false, message: 'gh missing' };
  if (ghAuth.ok) log.ok(`GitHub CLI authenticated as ${ghAuth.login}`); else log.warn(`GitHub CLI not authenticated for ${env.githubOwner}: ${ghAuth.message}`);
  if (!exists(path.join(PLATFORM_DIR, 'build', 'node_modules'))) log.warn('Build engine dependencies missing; run: npm --prefix platform/build ci');

  // ---- Template ---------------------------------------------------------------
  log.check(`Template ${tpl.ref}`);
  for (const w of tpl.warnings || []) log.warn(w);
  if (tpl.usable) log.ok(`${tpl.name} (${templateStatusText(tpl)})`);
  else if (done('project')) log.ok('project files already created; template source no longer required');
  else log.warn(PLACEHOLDER_WARNING(tpl.ref));
  const missingContent = tpl.usable && !done('project') ? missingRequiredContent(tpl, cfg) : [];
  if (missingContent.length) log.warn(`Template ${tpl.ref} requires: ${missingContent.join(', ')}. Pass ${missingContent.map((k) => `--${k.replace(/_/g, '-')}`).join(' ')} (the wizard asks for them).`);
  if (input) {
    for (const n of input.businessNotes) log.info(n);
    if (input.images.path && !input.images.exists) log.warn(`Images folder ${input.images.path} does not exist yet.`);
  }
  log.check(`Platform release ${cfg.platform_ref}`);
  log.ok(`project workflow will be pinned to ${env.githubOwner}/${env.platformRepo}@${cfg.platform_ref}`);

  // ---- Collisions -------------------------------------------------------------
  log.check(`Local folder ${path.relative(WORKSPACE_DIR, clientDir)}`);
  if (exists(clientDir) && !resume && !loadState(clientDir)) {
    throw new PlatformError(`Local folder ${clientDir} already exists and has no provisioning state.`, { hint: 'Choose another slug, or move the folder away, or use --resume if it was created by this tool.' });
  }
  log.ok(exists(clientDir) ? 'exists (provisioning state found, safe steps will be skipped)' : 'free');

  log.check(`GitHub repository ${env.githubOwner}/${repo}`);
  let ghRepo = null;
  if (ghAuth.ok) {
    ghRepo = await github.repoExists(repo);
    if (ghRepo && !done('github') && !resume) {
      const heads = await git.lsRemoteHeads(naming.sshRemote(repo, env));
      if (heads && heads.length) throw new PlatformError(`GitHub repository ${env.githubOwner}/${repo} already exists and is not empty.`, { hint: 'Choose another slug or use --resume if this client was partially provisioned.' });
      log.warn('Repository exists but is empty; it will be reused.');
    } else log.ok(ghRepo ? 'exists (will be reused)' : 'free');
  } else log.warn('skipped (gh not authenticated)');

  const hosts = [cfg.domain.primary, cfg.domain.staging].filter(Boolean);
  if (cpanel.configured) {
    for (const h of hosts) {
      log.check(`cPanel domain ${h}`);
      const d = await cpanel.findDomain(h);
      if (d) {
        const root = d.documentroot || '';
        if (root && !root.replace(/\/$/, '').endsWith(cfg.hosting.deploy_dir.replace(/\/$/, ''))) throw new PlatformError(`Domain ${h} already exists in cPanel pointing at ${root}.`, { code: 'DOMAIN_COLLISION' });
        log.ok('exists with the expected document root (will be reused)');
      } else log.ok('free');
    }
    log.check(`Hosting directory ${cfg.hosting.deploy_dir}`);
    const dirExists = await cpanel.dirExists(cfg.hosting.deploy_dir.replace(/\/$/, ''));
    log.ok(dirExists ? 'exists (will be reused)' : 'does not exist yet (created with the domain)');
  }

  // ---- Summary + plan ---------------------------------------------------------
  log.raw('');
  log.raw(clientSummary(cfg, env, { template: tpl, businessType: input ? input.businessType : undefined, apply, images: input ? input.images : undefined }));
  log.raw('');
  log.raw(`PLAN for ${cfg.client.name} (${slug})`);
  for (const p of planFor(cfg, env)) log.plan(`${done(p.id) ? '[done] ' : ''}${p.text}`);
  log.raw('');
  log.raw(serializeSiteConfig(cfg));
  const templateBlocked = !tpl.usable && !done('project');
  const contentBlocked = missingContent.length > 0;

  // ---- Local preflight: generate + personalise + residue scan in a temp dir ------------
  // Proves the project identity is applied before anything remote exists (both modes).
  let preflight = null;
  if (!templateBlocked && !contentBlocked && !done('project')) {
    log.check('Local preflight (generate, personalise, residue scan)');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mbg-preflight-${slug}-`));
    try {
      const g = generateClientProject(cfg, tmp, { template: tpl, env });
      preflight = { files: g.files, tokens: g.personalized.tokens, residue: g.residue };
      if (g.residue.ok) log.ok(`${g.personalized.files.length} file(s) personalised with ${g.personalized.tokens.length} token(s); no template residue`);
      else { log.fail('Template personalisation incomplete'); for (const l of formatResidue(g.residue.findings)) log.fail(`  ${l}`); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const residueBlocked = Boolean(preflight && !preflight.residue.ok);

  if (!apply) {
    if (templateBlocked) for (const line of PLACEHOLDER_STOP_LINES) log.warn(line);
    if (contentBlocked) log.warn(`Apply would stop: template requires ${missingContent.join(', ')}.`);
    if (residueBlocked) log.warn('Apply would stop before creating production resources: source-template branding remains.');
    log.dry('Dry run only. Nothing was created. Re-run with --apply to provision.');
    return { cfg, clientDir, dryRun: true, template: tpl, templateBlocked, contentBlocked, residueBlocked, preflight };
  }
  // Never create production resources from an empty or badly personalised template.
  if (templateBlocked) {
    throw new PlatformError(PLACEHOLDER_STOP_LINES.join('\n'), { code: 'TEMPLATE_PLACEHOLDER', hint: tpl.dir ? `Populate ${tpl.dir} (index.html, style.css, script.js, images/) or choose another template, then re-run. Nothing was created.` : 'Choose another template or --template blank. Nothing was created.' });
  }
  if (contentBlocked) throw new PlatformError(`Template ${tpl.ref} requires: ${missingContent.join(', ')}.`, { code: 'TEMPLATE_CONTENT_MISSING', hint: 'Provide the missing business information (wizard or --whatsapp/--address/...). Nothing was created.' });
  if (residueBlocked) throw new PlatformError(`Template personalisation incomplete\n${formatResidue(preflight.residue.findings).join('\n')}`, { code: 'TEMPLATE_RESIDUE', hint: 'Fix the template or the client information. Nothing was created.' });
  if (!yes) {
    if (!io && !process.stdin.isTTY) throw new PlatformError('Confirmation required but no interactive terminal is available.', { hint: 'Re-run with --yes to skip the confirmation in automation.' });
    if (!(await confirm('Proceed with provisioning?', { io }))) { log.info('Aborted by user. Nothing was created.'); return { cfg, clientDir, aborted: true }; }
  }
  if (!ghAuth.ok) throw new PlatformError('GitHub authentication is required for --apply.', { hint: github.requireAuthHint ? github.requireAuthHint() : 'Run gh auth login' });
  if (!(await github.refExists(env.platformRepo, cfg.platform_ref))) {
    throw new PlatformError(`Platform release ${env.githubOwner}/${env.platformRepo}@${cfg.platform_ref} is not available on GitHub.`, {
      code: 'PLATFORM_REF_MISSING',
      hint: `Publish and tag ${cfg.platform_ref} in the platform repository before provisioning. Nothing was created.`,
    });
  }
  cpanel.requireConfigured();

  // ---- 1. Project files: generate -> personalise -> residue validation (all local) ----
  log.step(`Create ${cfg.site.kind} project`);
  const existedBefore = exists(clientDir);
  if (!done('project')) {
    let g;
    try {
      g = generateClientProject(cfg, clientDir, { template: tpl, env, local: input ? input.local : undefined });
      if (!g.residue.ok) throw new PlatformError(`Template personalisation incomplete\n${formatResidue(g.residue.findings).join('\n')}`, { code: 'TEMPLATE_RESIDUE', hint: 'Nothing remote was created.' });
    } catch (err) {
      if (!existedBefore) fs.rmSync(clientDir, { recursive: true, force: true }); // keep the slug free
      throw err;
    }
    mark('project', { template: cfg.template.id, templateVersion: cfg.template.version, files: g.files, personalized: g.personalized.files.length, tokens: g.personalized.tokens.length, platformRef: cfg.platform_ref });
    log.ok(`Project created at ${clientDir} (${g.files} template files, ${g.personalized.files.length} personalised, residue scan clean)`);
  } else log.skip('Project already created');

  // ---- 2. Git -------------------------------------------------------------------
  log.step('Initialise Git');
  if (!(await git.isRepo(clientDir))) {
    await git.init(clientDir, { defaultBranch: 'main' });
    await git.setLocalIdentity(clientDir, await git.resolveIdentity(env));
  }
  await git.addAll(clientDir);
  const sha = await git.commit(clientDir, `Initial ${cfg.client.name} site from ${cfg.template.id} template`);
  if (!(await git.branchExists(clientDir, 'deploy'))) await git.createBranch(clientDir, 'deploy', 'main');
  mark('git', { initialCommit: sha || (steps.git && steps.git.initialCommit) });
  log.ok(`Git ready (main, deploy)${sha ? ` commit ${sha}` : ''}`);

  // ---- 3. Local production build + QA (before any remote resource) ----------------------
  log.step('Local production build');
  const build = await buildWithEngine(clientDir, { version: await git.headSha(clientDir), staging: cfg.domain.type === 'custom' });
  const qa = await qaDist(path.join(clientDir, 'dist'));
  if (!qa.ok) throw new PlatformError(`QA failed: ${qa.errors.join('; ')}`, { hint: 'Nothing remote was created. Fix the generated site, then re-run with --resume --apply.' });
  mark('build', { distBytes: build.distBytes });
  log.ok(`Build PASS (${qa.files} files, ${qa.checked} local references verified)`);

  // ---- 4. GitHub repository ---------------------------------------------------------
  log.step('GitHub repository');
  if (!ghRepo) {
    ghRepo = await github.createRepo({ name: repo, visibility: cfg.github.visibility, description: `${cfg.client.name} - MyBizGate website` });
    log.ok(`Created ${env.githubOwner}/${repo}`);
  } else log.skip(`Repository ${env.githubOwner}/${repo} exists`);
  await git.setRemote(clientDir, naming.sshRemote(repo, env));
  mark('github', { repo: `${env.githubOwner}/${repo}`, url: ghRepo && ghRepo.url });

  // ---- 5. Hosting ------------------------------------------------------------------
  log.step('Hosting');
  if (cfg.domain.type === 'subdomain') {
    await ensureSubdomain(cpanel, { host: cfg.domain.primary, label: slug, dir: cfg.hosting.deploy_dir, apply: true });
    mark('subdomain', { host: cfg.domain.primary });
  } else {
    await ensureSubdomain(cpanel, { host: cfg.domain.staging, label: `stg-${slug}`, dir: cfg.hosting.deploy_dir, apply: true });
    mark('staging', { host: cfg.domain.staging });
    await ensureCustomDomain(cpanel, { domain: cfg.domain.primary, label: slug, dir: cfg.hosting.deploy_dir, apply: true });
    mark('custom-domain', { domain: cfg.domain.primary });
  }
  let ftp;
  if (cfg.hosting.ftp_account === 'dedicated') {
    if (done('ftp') && done('secrets')) { ftp = { mode: steps.ftp.mode, login: steps.ftp.login, reuse: true }; log.skip(`FTP account ${ftp.login} already configured`); }
    else { ftp = await ensureDedicatedFtp(cpanel, { slug, dir: cfg.hosting.deploy_dir, apply: true, env }); mark('ftp', { mode: ftp.mode, login: ftp.login, fallback: Boolean(ftp.fallback) }); }
  } else {
    ftp = sharedFtp(env);
    if (ftp.missing) throw new PlatformError('hosting.ftp_account=shared requires FTP_USERNAME and FTP_PASSWORD in the environment.');
    mark('ftp', { mode: 'shared', login: ftp.login });
  }

  // ---- 6. GitHub variables and secrets ------------------------------------------------
  log.step('GitHub variables and secrets');
  await github.setVariable(repo, 'SITE_NAME', cfg.client.name);
  await github.setVariable(repo, 'SITE_DOMAIN', cfg.domain.primary);
  await github.setVariable(repo, 'DEPLOY_DIR', cfg.hosting.deploy_dir);
  if (ftp.password) {
    await github.setSecret(repo, 'FTP_SERVER', ftp.server || env.ftpServer);
    await github.setSecret(repo, 'FTP_USERNAME', ftp.login);
    await github.setSecret(repo, 'FTP_PASSWORD', ftp.password);
    mark('secrets', { names: ['FTP_SERVER', 'FTP_USERNAME', 'FTP_PASSWORD'] });
    log.ok('Variables and secrets configured (password stored only in GitHub)');
  } else {
    const have = await github.listSecrets(repo);
    const missing = ['FTP_SERVER', 'FTP_USERNAME', 'FTP_PASSWORD'].filter((n) => !have.includes(n));
    if (missing.length) throw new PlatformError(`GitHub secrets missing: ${missing.join(', ')}`, { hint: 'Re-run with --resume to rotate the FTP password and store it again.' });
    log.ok('Variables set; existing secrets kept');
  }
  mark('variables');

  // ---- 7. Push ---------------------------------------------------------------------------
  log.step('Push branches');
  await git.push(clientDir, 'main', { setUpstream: true });
  await git.mergeFastForward(clientDir, 'deploy', 'main');
  await git.push(clientDir, 'deploy', { setUpstream: true });
  try { await github.setDefaultBranch(repo, 'main'); } catch (err) { log.warn(`Could not set default branch: ${err.message}`); }
  const deploySha = await git.headSha(clientDir, { ref: 'deploy' });
  mark('push', { deploySha });
  log.ok(`Pushed main and deploy (${deploySha})`);

  // ---- 8. Deployment run -----------------------------------------------------------------------
  log.step('GitHub Actions deployment');
  const runInfo = await github.waitForRun(repo, { sha: deploySha, branch: 'deploy' });
  mark('deploy', { run: runInfo && runInfo.url });

  // ---- 9. DNS / SSL / health ---------------------------------------------------------------------
  const ip = (await cpanel.serverIp()) || (await hostingIp(env.baseDomain));
  const results = { build: 'PASS', deployment: 'PASS', dns: 'PENDING', ssl: 'PENDING', health: 'PENDING' };
  const verifyHost = async (host, { identity }) => {
    await waitForDns(host, ip ? [ip] : [], { timeoutMs: 10 * 60 * 1000, intervalMs: 20000 });
    await ensureAutoSSL(cpanel, host, { apply: true });
    await waitForHttps(host, { timeoutMs: 10 * 60 * 1000, intervalMs: 20000 });
    const h = await waitForHealthy({ url: `https://${host}`, identity }, { timeoutMs: 5 * 60 * 1000 });
    return h;
  };

  log.step('Verify');
  if (cfg.domain.type === 'subdomain') {
    await verifyHost(cfg.domain.primary, { identity: cfg.site.identity });
    results.dns = 'PASS'; results.ssl = 'PASS'; results.health = 'PASS';
    mark('verify', { host: cfg.domain.primary });
  } else {
    // Staging first (always on MyBizGate DNS), then the custom domain.
    await verifyHost(cfg.domain.staging, { identity: cfg.site.identity });
    mark('verify-staging', { host: cfg.domain.staging });
    log.ok(`Staging ready: https://${cfg.domain.staging} (noindex)`);
    const instructions = dnsInstructions({ domain: cfg.domain.primary, ip: ip || 'unknown', mode: cfg.domain.dns_mode, nameservers: env.nameservers, stagingHost: cfg.domain.staging, slug });
    const instrPath = path.join(clientDir, 'dns-instructions.txt');
    fs.writeFileSync(instrPath, instructions);
    log.info(`DNS instructions written to ${instrPath}`);
    let dnsReady = false;
    if (cfg.domain.dns_mode === 'awedns') {
      const d = await checkDelegation(cfg.domain.primary, env.nameservers);
      if (d.state !== 'DELEGATION OK') {
        log.raw(instructions);
        log.warn(`WAITING FOR NAMESERVERS: ${cfg.domain.primary} currently uses ${d.nameservers.join(', ') || 'no answer'}`);
        try { await waitForDelegation(cfg.domain.primary, env.nameservers, { timeoutMs: Number(rawInput.dnsWaitMinutes || 5) * 60 * 1000, intervalMs: 30000 }); dnsReady = true; } catch { dnsReady = false; }
      } else dnsReady = true;
    } else {
      const a = await checkDns(cfg.domain.primary, ip ? [ip] : []);
      if (a.state !== 'DNS OK') {
        log.raw(instructions);
        log.warn(`WAITING FOR DNS: ${cfg.domain.primary} -> ${a.resolved.join(', ') || a.error || 'no answer'} (expected ${ip})`);
        try { await waitForDns(cfg.domain.primary, ip ? [ip] : [], { timeoutMs: Number(rawInput.dnsWaitMinutes || 5) * 60 * 1000, intervalMs: 30000 }); dnsReady = true; } catch { dnsReady = false; }
      } else dnsReady = true;
    }
    if (!dnsReady) {
      results.dns = 'WAITING'; results.ssl = 'WAITING'; results.health = 'STAGING PASS';
      saveState(clientDir, state);
      printSummary(cfg, clientDir, env, results, { waiting: true, slug });
      return { cfg, clientDir, waiting: true };
    }
    // Deploy again in production mode is not required: same dist, same directory.
    // Rebuild without noindex happens on the next deploy push (production_url canonical).
    await ensureAutoSSL(cpanel, cfg.domain.primary, { apply: true });
    await waitForHttps(cfg.domain.primary, { timeoutMs: 10 * 60 * 1000, intervalMs: 20000 });
    const h = await healthCheck({ url: cfg.site.production_url, identity: cfg.site.identity });
    results.dns = 'PASS'; results.ssl = 'PASS'; results.health = h.ok ? 'PASS' : 'FAIL';
    mark('verify', { host: cfg.domain.primary });
    // Promote: production build must drop the staging noindex. Trigger a production deploy run.
    log.step('Promote custom domain to production build');
    await promoteCustomDomain(cfg, clientDir, { github, repo });
  }
  state.completedAt = new Date().toISOString();
  saveState(clientDir, state);
  printSummary(cfg, clientDir, env, results, { slug });
  return { cfg, clientDir, results };
}

async function promoteCustomDomain(cfg, clientDir, { github, repo }) {
  // The shared workflow builds staging (noindex) while site.environment=staging; switch it to production.
  const cfgPath = path.join(clientDir, SITE_CONFIG_FILE);
  const text = fs.readFileSync(cfgPath, 'utf8');
  const updated = text.includes('environment:') ? text.replace(/environment:\s*staging/, 'environment: production') : text.replace(/^site:\n/m, 'site:\n  environment: production\n');
  if (updated !== text) {
    fs.writeFileSync(cfgPath, updated);
    await git.checkout(clientDir, 'main');
    await git.addAll(clientDir);
    const sha = await git.commit(clientDir, `Promote ${cfg.domain.primary} to production`);
    await git.push(clientDir, 'main');
    await git.mergeFastForward(clientDir, 'deploy', 'main');
    await git.push(clientDir, 'deploy');
    if (sha) await github.waitForRun(repo, { sha, branch: 'deploy' });
  }
  log.ok(`Production build live at ${cfg.site.production_url}`);
}

export function printSummary(cfg, clientDir, env, results, { waiting = false, slug } = {}) {
  const lines = [];
  lines.push('');
  lines.push(waiting ? 'CLIENT CREATED (WAITING FOR DNS)' : 'CLIENT CREATED');
  lines.push('');
  const row = (k, v) => { lines.push(`${k}:`); lines.push(`${v}`); lines.push(''); };
  row('Business', cfg.client.name);
  row('Slug', cfg.client.slug);
  row('Local', clientDir);
  row('GitHub', `${env.githubOwner}/${cfg.github.repo}`);
  row('Production', cfg.site.production_url);
  if (cfg.site.staging_url) row('Staging', cfg.site.staging_url);
  row('Document root', cfg.hosting.deploy_dir);
  lines.push('Branches:'); lines.push('main'); lines.push('deploy'); lines.push('');
  row('Build', results.build);
  row('Deployment', results.deployment);
  row('DNS', results.dns);
  row('SSL', results.ssl);
  row('Health', results.health);
  if (waiting) {
    lines.push('Next step: apply the DNS instructions in');
    lines.push(path.join(clientDir, 'dns-instructions.txt'));
    lines.push('then resume with:');
    lines.push(`./platform/bin/mybizgate new-client --slug ${slug} --resume --apply`);
    lines.push('');
  }
  log.raw(lines.join('\n'));
}
