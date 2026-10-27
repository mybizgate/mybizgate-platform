// New-client provisioning flow: validate -> plan -> (apply) create project, Git,
// GitHub, hosting, secrets, build, push, deploy, DNS, SSL, health.
// Every step is idempotent and progress is stored in <client>/.mybizgate/state.json
// so a partial run can be resumed with --resume.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { log, PlatformError, exists, readJson, writeJson, run, commandExists } from './utils.mjs';
import {
  loadEnv, naming, validateSlug, validateBusinessName, validateTemplate, validateDomainType, validateDnsMode, validateVisibility,
  validateCustomDomain, buildSiteConfig, serializeSiteConfig, loadSiteConfig, TEMPLATES, DOMAIN_TYPES, DNS_MODES, VISIBILITIES,
  WORKSPACE_DIR, PLATFORM_DIR, CLIENTS_DIR, SITE_CONFIG_FILE, validateSiteConfig,
} from './config.mjs';
import * as git from './git.mjs';
import { hostingPlan, ensureSubdomain, ensureCustomDomain, ensureDedicatedFtp, sharedFtp } from './hosting.mjs';
import { checkDns, waitForDns, waitForDelegation, hostingIp, dnsInstructions, checkDelegation } from './dns.mjs';
import { ensureAutoSSL, waitForHttps } from './ssl.mjs';
import { qaDist, waitForHealthy, healthCheck } from './verify.mjs';
import { buildWithEngine } from './build.mjs';

const TEMPLATE_DIR = path.join(PLATFORM_DIR, 'templates', 'static-site');
const COPY_EXCLUDES = ['.git', 'dist', 'node_modules', '.github', '.ftp-deploy-sync-state.json', '.env', '.env.*', '*.log', 'site.config.yml', 'README.md', 'README.txt', 'AGENTS.md', '.mybizgate', '.mybizgate-build-report.json', '.lighthouse', '.screenshots', '.DS_Store'];

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------
export async function wizard(initial = {}, env = loadEnv()) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label, def, validate) => {
    for (;;) {
      const answer = (await rl.question(`${label}${def ? ` [${def}]` : ''}: `)).trim() || def || '';
      try { return validate ? validate(answer) : answer; } catch (err) { log.fail(err.message); }
    }
  };
  try {
    const out = { ...initial };
    out.name = out.name || await ask('Business name', '', validateBusinessName);
    const suggested = out.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    out.slug = out.slug || await ask('Slug', suggested, validateSlug);
    out.template = out.template || await ask(`Template (${TEMPLATES.join('/')})`, 'blank', validateTemplate);
    out.domainType = out.domainType || await ask(`Domain type (${DOMAIN_TYPES.join('/')})`, 'subdomain', validateDomainType);
    out.visibility = out.visibility || await ask(`Repository visibility (${VISIBILITIES.join('/')})`, 'private', validateVisibility);
    if (out.domainType === 'custom') {
      out.domain = out.domain || await ask('Custom domain (e.g. pawhaven.com.my)', '', (v) => validateCustomDomain(v, env));
      out.dnsMode = out.dnsMode || await ask(`DNS mode (${DNS_MODES.join('/')})`, 'external', validateDnsMode);
    }
    return out;
  } finally {
    rl.close();
  }
}

export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N]: `)).trim()); } finally { rl.close(); }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
export function statePath(clientDir) { return path.join(clientDir, '.mybizgate', 'state.json'); }
export function loadState(clientDir) { return readJson(statePath(clientDir), null); }
export function saveState(clientDir, state) { state.updatedAt = new Date().toISOString(); writeJson(statePath(clientDir), state); }

// ---------------------------------------------------------------------------
// Input -> config
// ---------------------------------------------------------------------------
export function normalizeInput(input, env = loadEnv()) {
  const name = validateBusinessName(input.name);
  const slug = validateSlug(input.slug);
  const template = validateTemplate(input.template || 'blank');
  const domainType = validateDomainType(input.domainType || 'subdomain');
  const visibility = validateVisibility(input.visibility || 'private');
  let customDomain; let dnsMode;
  if (domainType === 'custom') {
    customDomain = validateCustomDomain(input.domain, env);
    dnsMode = validateDnsMode(input.dnsMode || 'external');
  }
  const ftpAccount = input.ftpAccount === 'shared' ? 'shared' : 'dedicated';
  return { name, slug, template, domainType, visibility, customDomain, dnsMode, ftpAccount };
}

export function planFor(cfg, env = loadEnv()) {
  const slug = cfg.client.slug;
  const repo = cfg.github.repo;
  const lines = [];
  lines.push({ id: 'project', text: `Create ${path.relative(WORKSPACE_DIR, naming.clientDir(slug))}/ from template "${cfg.template.type}"` });
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

// ---------------------------------------------------------------------------
// Template copy
// ---------------------------------------------------------------------------
function copyTemplate(template, dest) {
  const { walk } = { walk: walkSync };
  if (template === 'blank') {
    fs.mkdirSync(dest, { recursive: true });
    return 0;
  }
  const src = path.join(WORKSPACE_DIR, template);
  if (!exists(path.join(src, 'index.html'))) throw new PlatformError(`Template source ${src} has no index.html.`);
  const files = walk(src, COPY_EXCLUDES);
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
    <a class="cta" href="https://wa.me/60123456789?text=Hello%20${encodeURIComponent(cfg.client.name)}">WhatsApp us</a>
  </main>
  <script src="script.js?v=__BUILD_VERSION__" defer></script>
</body>
</html>
`;
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function writeProjectFiles(cfg, clientDir, { env = loadEnv() } = {}) {
  fs.mkdirSync(clientDir, { recursive: true });
  const write = (rel, content) => { const p = path.join(clientDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  write(SITE_CONFIG_FILE, serializeSiteConfig(cfg));
  write('.gitignore', fs.readFileSync(path.join(TEMPLATE_DIR, '.gitignore'), 'utf8'));
  write('.github/workflows/deploy.yml', fs.readFileSync(path.join(TEMPLATE_DIR, '.github', 'workflows', 'deploy.yml'), 'utf8').replace('mybizgate/mybizgate-platform/', `${env.githubOwner}/${env.platformRepo}/`).replace('@main', `@${env.platformRef}`));
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

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
export async function newClient(rawInput, { env = loadEnv(), cpanel, github, apply = false, resume = false, yes = false } = {}) {
  const resumeSlug = rawInput.slug;
  let cfg; let clientDir; let state;

  if (resume) {
    validateSlug(resumeSlug);
    clientDir = naming.clientDir(resumeSlug);
    if (!exists(clientDir)) throw new PlatformError(`Cannot resume: ${clientDir} does not exist.`);
    cfg = loadSiteConfig(clientDir);
    state = loadState(clientDir) || { slug: resumeSlug, steps: {} };
    log.info(`Resuming provisioning of ${cfg.client.name} (${resumeSlug}) from ${statePath(clientDir)}`);
  } else {
    const input = normalizeInput(rawInput, env);
    cfg = validateSiteConfig(buildSiteConfig({ ...input, kind: 'client', env }));
    clientDir = naming.clientDir(cfg.client.slug);
    state = loadState(clientDir) || { slug: cfg.client.slug, createdAt: new Date().toISOString(), steps: {} };
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
  if (!cpanel.configured) log.warn('cPanel API not configured (CPANEL_TOKEN missing); hosting steps cannot run.');
  else log.ok('cPanel API configured');
  const ghAuth = ghAvailable ? await github.authStatus() : { ok: false, message: 'gh missing' };
  if (ghAuth.ok) log.ok(`GitHub CLI authenticated as ${ghAuth.login}`); else log.warn(`GitHub CLI not authenticated for ${env.githubOwner}: ${ghAuth.message}`);
  if (!exists(path.join(PLATFORM_DIR, 'build', 'node_modules'))) log.warn('Build engine dependencies missing; run: npm --prefix platform/build ci');

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

  // ---- Plan -------------------------------------------------------------------
  log.raw('');
  log.raw(`PLAN for ${cfg.client.name} (${slug})`);
  for (const p of planFor(cfg, env)) log.plan(`${done(p.id) ? '[done] ' : ''}${p.text}`);
  log.raw('');
  log.raw(serializeSiteConfig(cfg));
  if (!apply) {
    log.dry('Dry run only. Nothing was created. Re-run with --apply to provision.');
    return { cfg, clientDir, dryRun: true };
  }
  if (!yes && process.stdin.isTTY) {
    if (!(await confirm('Apply this plan?'))) { log.info('Aborted by user.'); return { cfg, clientDir, aborted: true }; }
  }
  if (!ghAuth.ok) throw new PlatformError('GitHub authentication is required for --apply.', { hint: github.requireAuthHint ? github.requireAuthHint() : 'Run gh auth login' });
  cpanel.requireConfigured();

  // ---- 1. Project files -------------------------------------------------------
  log.step('Create client project');
  if (!done('project')) {
    const count = copyTemplate(cfg.template.type, clientDir);
    writeProjectFiles(cfg, clientDir, { env });
    mark('project', { template: cfg.template.type, files: count });
    log.ok(`Project created at ${clientDir} (${count} template files)`);
  } else log.skip('Project already created');

  // ---- 2. Git -------------------------------------------------------------------
  log.step('Initialise Git');
  if (!(await git.isRepo(clientDir))) {
    await git.init(clientDir, { defaultBranch: 'main' });
    await git.setLocalIdentity(clientDir, await git.resolveIdentity(env));
  }
  await git.addAll(clientDir);
  const sha = await git.commit(clientDir, `Initial ${cfg.client.name} site from ${cfg.template.type} template`);
  if (!(await git.branchExists(clientDir, 'deploy'))) await git.createBranch(clientDir, 'deploy', 'main');
  mark('git', { initialCommit: sha || (steps.git && steps.git.initialCommit) });
  log.ok(`Git ready (main, deploy)${sha ? ` commit ${sha}` : ''}`);

  // ---- 3. GitHub repository ---------------------------------------------------------
  log.step('GitHub repository');
  if (!ghRepo) {
    ghRepo = await github.createRepo({ name: repo, visibility: cfg.github.visibility, description: `${cfg.client.name} - MyBizGate website` });
    log.ok(`Created ${env.githubOwner}/${repo}`);
  } else log.skip(`Repository ${env.githubOwner}/${repo} exists`);
  await git.setRemote(clientDir, naming.sshRemote(repo, env));
  mark('github', { repo: `${env.githubOwner}/${repo}`, url: ghRepo && ghRepo.url });

  // ---- 4. Hosting ------------------------------------------------------------------
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

  // ---- 5. GitHub variables and secrets ------------------------------------------------
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

  // ---- 6. Local build + QA ---------------------------------------------------------------
  log.step('Local production build');
  const build = await buildWithEngine(clientDir, { version: await git.headSha(clientDir), staging: cfg.domain.type === 'custom' });
  const qa = await qaDist(path.join(clientDir, 'dist'));
  if (!qa.ok) throw new PlatformError(`QA failed: ${qa.errors.join('; ')}`);
  mark('build', { distBytes: build.distBytes });
  log.ok(`Build PASS (${qa.files} files, ${qa.checked} local references verified)`);

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
