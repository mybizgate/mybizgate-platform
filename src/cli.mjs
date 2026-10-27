#!/usr/bin/env node
// MyBizGate platform CLI. Thin Bash wrappers in platform/bin call this file.
import fs from 'node:fs';
import path from 'node:path';
import { log, PlatformError, parseArgs, exists, commandExists, run, redact, timestamp, formatBytes, dirSize, readJson } from './utils.mjs';
import {
  loadEnv, envStatus, naming, WORKSPACE_DIR, PLATFORM_DIR, CLIENTS_DIR, SITE_CONFIG_FILE, CORPORATE_REPO, DEMO_SITES,
  loadSiteConfig, validateSiteConfig, buildSiteConfig, serializeSiteConfig, resolveSiteDir, inferSiteKind, resolveServerDir, validateDeployDir, validateSlug, TEMPLATES,
} from './config.mjs';
import { CPanelProvider, MockCPanelProvider } from './cpanel.mjs';
import { GitHubProvider, MockGitHubProvider } from './github.mjs';
import * as git from './git.mjs';
import { checkDns, resolveNs, hostingIp, dnsInstructions, checkDelegation } from './dns.mjs';
import { checkHttps } from './ssl.mjs';
import { qaDist, healthCheck, waitForHealthy, assertHealthy } from './verify.mjs';
import { buildWithEngine, summarizeReport } from './build.mjs';
import { newClient, wizard, confirm, writeProjectFiles } from './provision.mjs';

const HELP = `MyBizGate platform CLI

Usage: mybizgate <command> [options]

Commands:
  doctor                         Check tools, authentication, cPanel API, DNS, AutoSSL and FTP config
  build <site> [--out dir] [--version id] [--staging] [--report file]
                                 Build an optimised dist/ for a site directory, slug or site name
  qa <dist-dir>                  Validate a built dist/ directory
  new-client [options]           Provision a new client (interactive when no --name is given)
      --name "Business" --slug slug --template petgate --domain-type subdomain|custom
      [--domain example.com.my] [--dns-mode awedns|external] [--visibility private|public]
      [--ftp-account dedicated|shared] [--apply] [--resume] [--yes] [--mock]
  site-status <site|slug>        Show local, GitHub, hosting, DNS and HTTPS status
  verify <site|slug> | --url URL [--identity text] [--expect-version id] [--wait seconds]
                                 Production health check
  migrate-existing <site> [--apply]
                                 Migrate an existing site repo (petgate, mybizgate-site, ...) to the platform
  rollback <site|slug> [--to tag] [--apply]
                                 Roll the deploy branch back to a release tag (prod-*) and redeploy
  dns-instructions <slug>        Regenerate dns-instructions.txt for a custom-domain client
  publish-platform [--apply]     Create/push the mybizgate-platform GitHub repository
  resolve-target <site> --repo owner/name [--github-output file]
                                 (CI) validate deployment target from site.config.yml / inputs
  templates                      List available templates

All commands that change GitHub, cPanel, Git remotes or production are DRY RUN unless --apply is given.
`;

function makeProviders(opts, env) {
  if (opts.mock) {
    return { cpanel: new MockCPanelProvider(), github: new MockGitHubProvider() };
  }
  return { cpanel: new CPanelProvider(env), github: new GitHubProvider(env) };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function cmdDoctor(opts, env) {
  let failures = 0;
  const check = async (label, fn, { required = true } = {}) => {
    log.check(label);
    try {
      const r = await fn();
      if (r && r.warn) log.warn(`${label}: ${r.warn}`); else log.ok(`${label}: ${r && r.detail ? r.detail : 'ok'}`);
      if (r && r.warn && required) failures += 1;
    } catch (err) {
      (required ? log.fail : log.warn)(`${label}: ${err.message}`);
      if (err.hint) log.info(err.hint);
      if (required) failures += 1;
    }
  };
  const version = async (cmd, args = ['--version']) => (await run(cmd, args)).stdout.trim().split('\n')[0];
  for (const tool of ['git', 'npm', 'curl', 'jq', 'ssh']) {
    await check(tool, async () => ({ detail: tool === 'ssh' ? (await run('ssh', ['-V'], { allowFailure: true })).stderr.trim() : await version(tool) }));
  }
  await check('node >= 22', async () => { const v = process.versions.node; if (Number(v.split('.')[0]) < 22) throw new PlatformError(`node ${v} is too old`); return { detail: `v${v}` }; });
  await check('gh', async () => ({ detail: await version('gh') }));
  await check('dig or equivalent', async () => {
    for (const t of ['dig', 'host', 'resolvectl', 'nslookup']) if (await commandExists(t)) return { detail: t };
    return { detail: 'using Node.js resolver' };
  }, { required: false });
  await check('Build engine dependencies', async () => { if (!exists(path.join(PLATFORM_DIR, 'build', 'node_modules'))) throw new PlatformError('not installed', { hint: `npm --prefix ${path.join(PLATFORM_DIR, 'build')} ci` }); return { detail: 'installed' }; });
  const github = new GitHubProvider(env);
  await check(`GitHub authentication (${env.githubOwner})`, async () => {
    const s = await github.authStatus();
    if (!s.ok) throw new PlatformError(s.message, { hint: github.requireAuthHint() });
    if (s.login && s.login.toLowerCase() !== env.githubOwner.toLowerCase()) return { warn: `logged in as ${s.login}, expected ${env.githubOwner}` };
    return { detail: `logged in as ${s.login} (${s.scopes || 'scopes n/a'})` };
  });
  await check(`GitHub SSH alias ${env.githubSshHost}`, async () => {
    const r = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', `git@${env.githubSshHost}`], { allowFailure: true });
    const text = `${r.stdout}${r.stderr}`;
    const m = /Hi ([^!]+)!/.exec(text);
    if (!m) throw new PlatformError(text.trim().split('\n')[0] || 'no response');
    return { detail: `authenticated as ${m[1]}` };
  });
  const cpanel = new CPanelProvider(env);
  await check('cPanel API', async () => {
    const d = await cpanel.listDomains();
    return { detail: `${env.cpanelUser}@${env.cpanelHost}: main ${d.main}, ${d.subdomains.length} subdomains, ${d.addons.length} addon domains` };
  });
  await check(`DNS authority for ${env.baseDomain}`, async () => {
    const ns = await resolveNs(env.baseDomain);
    if (!Array.isArray(ns)) throw new PlatformError(`NS lookup failed: ${ns.error}`);
    const ok = env.nameservers.every((n) => ns.includes(n));
    if (!ok) return { warn: `nameservers are ${ns.join(', ')} (expected ${env.nameservers.join(', ')})` };
    const ip = await hostingIp(env.baseDomain);
    return { detail: `${ns.join(', ')} -> ${ip}` };
  });
  await check('AutoSSL', async () => {
    if (!cpanel.configured) throw new PlatformError('cPanel not configured');
    const r = await cpanel.checkAutoSSL(env.baseDomain);
    const problems = (await cpanel.uapi('SSL', 'get_autossl_problems').catch(() => [])) || [];
    return { detail: `${env.baseDomain} ${r.covered ? `covered (expires ${r.expires})` : 'NOT covered'}; ${problems.length} problem(s)${problems.length ? `: ${problems.map((p) => `${p.domain}: ${p.problem}`).join('; ')}` : ''}` };
  }, { required: false });
  await check('FTP config', async () => {
    const st = envStatus();
    const parts = [`FTP_SERVER=${env.ftpServer}`, `FTP_USERNAME ${st.FTP_USERNAME ? 'set' : 'not set'}`, `FTP_PASSWORD ${st.FTP_PASSWORD ? 'set' : 'not set'}`];
    if (!st.FTP_USERNAME || !st.FTP_PASSWORD) return { warn: `${parts.join(', ')} (shared credential unavailable; dedicated FTP accounts will be used for clients)` };
    return { detail: parts.join(', ') };
  }, { required: false });
  log.raw('');
  log.raw(`Environment: ${Object.entries(envStatus()).map(([k, v]) => `${k}=${v ? 'set' : 'unset'}`).join('  ')}`);
  if (failures) { log.fail(`doctor found ${failures} problem(s)`); return 1; }
  log.ok('doctor: all required checks passed');
  return 0;
}

// ---------------------------------------------------------------------------
// build / qa / resolve-target
// ---------------------------------------------------------------------------
async function cmdBuild(opts) {
  const siteDir = resolveSiteDir(opts._[0]);
  const report = await buildWithEngine(siteDir, { out: opts.out, version: opts.version, staging: Boolean(opts.staging), productionUrl: opts.productionUrl, report: opts.report });
  const s = summarizeReport(report);
  log.ok(`Build summary: source ${s.source} -> dist ${s.dist}; HTML ${s.html}; CSS ${s.css}; JS ${s.js}; images ${s.images}`);
  return 0;
}

async function cmdQa(opts) {
  const dist = path.resolve(opts._[0] || 'dist');
  const r = await qaDist(dist);
  for (const w of r.warnings) log.warn(w);
  for (const e of r.errors) log.fail(e);
  if (!r.ok) { log.fail(`QA failed for ${dist}`); return 1; }
  log.ok(`QA passed: ${r.files} files, ${r.checked} local references verified, ${r.warnings.length} warning(s)`);
  return 0;
}

async function cmdResolveTarget(opts, env) {
  const siteDir = path.resolve(opts._[0] || '.');
  const repo = opts.repo || process.env.GITHUB_REPOSITORY || '';
  const repoName = repo.split('/').pop();
  const cfg = loadSiteConfig(siteDir, { repo: repoName });
  const inputs = { deployDir: process.env.INPUT_DEPLOY_DIR || '', siteDomain: process.env.INPUT_SITE_DOMAIN || '', siteName: process.env.INPUT_SITE_NAME || '', environment: process.env.INPUT_ENVIRONMENT || '' };
  let deployDir = cfg.hosting.deploy_dir;
  if (inputs.deployDir) {
    deployDir = validateDeployDir(inputs.deployDir, { kind: cfg.site.kind, slug: cfg.client.slug, repo: repoName });
    if (deployDir !== cfg.hosting.deploy_dir) throw new PlatformError(`DEPLOY_DIR variable (${deployDir}) does not match site.config.yml (${cfg.hosting.deploy_dir}); refusing.`);
  }
  if (cfg.site.kind === 'corporate' && repoName !== CORPORATE_REPO) throw new PlatformError(`Repository ${repo} may not deploy to public_html/.`);
  if (cfg.site.kind !== 'corporate' && deployDir === 'public_html/') throw new PlatformError('Refusing to deploy to public_html/.');
  if (cfg.site.kind === 'client' && repo && env.githubOwner && !repo.toLowerCase().startsWith(`${env.githubOwner.toLowerCase()}/client-`)) {
    log.warn(`Repository ${repo} does not follow the client-<slug> convention.`);
  }
  const environment = inputs.environment && inputs.environment !== 'production' ? inputs.environment : cfg.site.environment || 'production';
  if (!['production', 'staging'].includes(environment)) throw new PlatformError(`Unknown environment ${environment}`);
  const verifyDomain = environment === 'staging' && cfg.domain.staging ? cfg.domain.staging : (inputs.siteDomain || cfg.domain.primary);
  const out = {
    kind: cfg.site.kind,
    slug: cfg.client.slug,
    deploy_dir: deployDir,
    server_dir: resolveServerDir({ ...cfg, hosting: { ...cfg.hosting, deploy_dir: deployDir } }),
    site_domain: inputs.siteDomain || cfg.domain.primary,
    verify_domain: verifyDomain,
    site_name: inputs.siteName || cfg.site.identity || cfg.client.name,
    environment,
    qa_lighthouse: String(Boolean(cfg.qa.lighthouse)),
    qa_browser_smoke: String(Boolean(cfg.qa.browser_smoke)),
    qa_screenshots: String(Boolean(cfg.qa.screenshots)),
  };
  for (const [k, v] of Object.entries(out)) log.ok(`${k}=${v}`);
  if (opts.githubOutput) fs.appendFileSync(opts.githubOutput, `${Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// new-client
// ---------------------------------------------------------------------------
async function cmdNewClient(opts, env) {
  const { cpanel, github } = makeProviders(opts, env);
  let input = {
    name: opts.name, slug: opts.slug, template: opts.template, domainType: opts.domainType, domain: opts.domain, dnsMode: opts.dnsMode,
    visibility: opts.visibility, ftpAccount: opts.ftpAccount, dnsWaitMinutes: opts.dnsWait,
  };
  const resume = Boolean(opts.resume);
  if (!resume && !input.name) {
    if (!process.stdin.isTTY) throw new PlatformError('No --name given and no interactive terminal available.', { hint: 'Pass --name, --slug, --template and --domain-type for non-interactive use.' });
    input = await wizard(input, env);
  }
  if (!resume && !input.slug) throw new PlatformError('--slug is required.');
  const r = await newClient(input, { env, cpanel, github, apply: Boolean(opts.apply), resume, yes: Boolean(opts.yes) });
  return r && (r.aborted ? 1 : 0);
}

// ---------------------------------------------------------------------------
// site-status / verify / dns-instructions
// ---------------------------------------------------------------------------
async function cmdSiteStatus(opts, env) {
  const siteDir = resolveSiteDir(opts._[0]);
  const { cpanel, github } = makeProviders(opts, env);
  log.raw(`Site: ${siteDir}`);
  let cfg = null;
  try { cfg = loadSiteConfig(siteDir); } catch (err) { log.warn(err.message); }
  if (await git.isRepo(siteDir)) {
    log.ok(`Git: branch ${await git.currentBranch(siteDir)}, ${(await git.isClean(siteDir)) ? 'clean' : 'UNCOMMITTED CHANGES'}, remote ${await git.remoteUrl(siteDir) || 'none'}`);
    log.ok(`Branches: ${(await git.localBranches(siteDir)).join(', ')}`);
    const t = await git.tags(siteDir, 'prod-*');
    log.ok(`Release tags: ${t.slice(0, 5).join(', ') || 'none'}`);
    for (const l of await git.recentLog(siteDir, 3)) log.info(`  ${l}`);
  } else log.warn('Not a Git repository');
  if (!cfg) return 1;
  log.ok(`Config: ${cfg.client.name} (${cfg.client.slug}) kind=${cfg.site.kind} domain=${cfg.domain.primary} deploy_dir=${cfg.hosting.deploy_dir} ftp=${cfg.hosting.ftp_account}`);
  const auth = (await github.available()) ? await github.authStatus() : { ok: false };
  if (auth.ok) {
    const repo = await github.repoExists(cfg.github.repo);
    log.ok(`GitHub: ${repo ? `${repo.url || cfg.github.repo} (${repo.visibility}, default ${repo.defaultBranchRef && repo.defaultBranchRef.name})` : 'repository not found'}`);
    const runs = await github.listRuns(cfg.github.repo, { branch: 'deploy', limit: 1 });
    if (runs[0]) log.ok(`Last deploy run: ${runs[0].status}/${runs[0].conclusion} ${runs[0].createdAt} ${runs[0].url}`);
    const vars = await github.listVariables(cfg.github.repo);
    log.ok(`Variables: ${vars.map((v) => `${v.name}=${v.value}`).join(', ') || 'none'}; secrets: ${(await github.listSecrets(cfg.github.repo)).join(', ') || 'none'}`);
  } else log.warn('GitHub: gh not authenticated for MyBizGate (skipped)');
  if (cpanel.configured) {
    for (const h of [cfg.domain.primary, cfg.domain.staging].filter(Boolean)) {
      const d = await cpanel.findDomain(h);
      log[d ? 'ok' : 'warn'](`cPanel ${h}: ${d ? `${d.kind} -> ${d.documentroot}` : 'not found'}`);
    }
    if (cfg.hosting.ftp_account === 'dedicated') log.ok(`FTP ${naming.ftpLogin(cfg.client.slug, env)}: ${(await cpanel.ftpAccountExists(naming.ftpLogin(cfg.client.slug, env))) ? 'exists' : 'missing'}`);
    const ssl = await cpanel.checkAutoSSL(cfg.domain.primary);
    log[ssl.covered ? 'ok' : 'warn'](`AutoSSL ${cfg.domain.primary}: ${ssl.covered ? `covered until ${ssl.expires}` : 'not covered'}`);
  } else log.warn('cPanel: not configured (skipped)');
  const ip = await hostingIp(env.baseDomain);
  for (const h of [cfg.domain.primary, cfg.domain.staging].filter(Boolean)) {
    const d = await checkDns(h, ip ? [ip] : []);
    log[d.state === 'DNS OK' ? 'ok' : 'warn'](`DNS ${h}: ${d.state} (${d.resolved.join(', ') || d.error || 'no answer'})`);
    const s = await checkHttps(`https://${h}/`, { method: 'HEAD' });
    log[s.status && !s.tlsError ? 'ok' : 'warn'](`HTTPS ${h}: ${s.status ? `status ${s.status}` : s.error}${s.cert ? ` cert ${s.cert.subject} (${s.cert.issuer}) until ${s.cert.validTo}` : ''}`);
  }
  return 0;
}

async function cmdVerify(opts, env) {
  let url = opts.url; let identity = opts.identity;
  if (!url) {
    const siteDir = resolveSiteDir(opts._[0]);
    const cfg = loadSiteConfig(siteDir);
    url = opts.staging ? cfg.site.staging_url : cfg.site.production_url;
    identity = identity || cfg.site.identity;
  }
  const args = { url, identity, expectedVersion: opts.expectVersion };
  const r = opts.wait ? await waitForHealthy(args, { timeoutMs: Number(opts.wait) * 1000, intervalMs: 20000 }) : await healthCheck(args);
  assertHealthy(r);
  log.ok(`Production health PASS for ${url}`);
  return 0;
}

async function cmdDnsInstructions(opts, env) {
  const slug = validateSlug(opts._[0]);
  const dir = naming.clientDir(slug);
  const cfg = loadSiteConfig(dir);
  if (cfg.domain.type !== 'custom') throw new PlatformError(`${slug} uses a MyBizGate subdomain; no DNS instructions needed.`);
  const ip = await hostingIp(env.baseDomain);
  const text = dnsInstructions({ domain: cfg.domain.primary, ip: ip || 'unknown', mode: cfg.domain.dns_mode, nameservers: env.nameservers, stagingHost: cfg.domain.staging, slug });
  fs.writeFileSync(path.join(dir, 'dns-instructions.txt'), text);
  log.raw(text);
  log.ok(`Written to ${path.join(dir, 'dns-instructions.txt')}`);
  return 0;
}

// ---------------------------------------------------------------------------
// migrate-existing
// ---------------------------------------------------------------------------
const PROTECTED_PUBLIC_HTML = ['.well-known', 'cgi-bin', 'site-petgate', 'site-autogate', 'site-beautygate', 'site-dentalgate', 'site-supplygate', 'clients'];

async function cmdMigrateExisting(opts, env) {
  const siteDir = resolveSiteDir(opts._[0]);
  const base = path.basename(siteDir);
  const kind = inferSiteKind(siteDir);
  if (kind === 'client') throw new PlatformError('migrate-existing is for demo sites and mybizgate-site; clients are created with new-client.');
  const apply = Boolean(opts.apply);
  const { cpanel, github } = makeProviders(opts, env);
  const slug = kind === 'corporate' ? 'mybizgate' : base;
  const name = kind === 'corporate' ? 'MyBizGate' : `${base.charAt(0).toUpperCase()}${base.slice(1, -4)}Gate`;
  const identity = opts.identity || (kind === 'corporate' ? 'MyBizGate' : name);

  // 1. Inspect
  log.step(`Inspect ${base}`);
  if (!(await git.isRepo(siteDir))) throw new PlatformError(`${siteDir} is not a Git repository.`);
  const remote = await git.remoteUrl(siteDir);
  const branches = await git.localBranches(siteDir);
  const remoteBranches = await git.remoteBranches(siteDir);
  const branch = await git.currentBranch(siteDir);
  const head = await git.headSha(siteDir);
  const dirty = await git.status(siteDir);
  const workflowPath = path.join(siteDir, '.github', 'workflows', 'deploy.yml');
  const oldWorkflow = exists(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : '';
  const oldDeployDir = (/server-dir:\s*(\S+)/.exec(oldWorkflow) || [])[1] || null;
  log.ok(`remote ${remote}`);
  log.ok(`branches local [${branches.join(', ')}] remote [${remoteBranches.join(', ')}] current ${branch}@${head}`);
  log.ok(`current workflow: ${exists(workflowPath) ? workflowPath : 'none'}; deployment directory ${oldDeployDir || 'unknown'}`);
  if (dirty.length) { log.warn(`Working tree has ${dirty.length} uncommitted change(s):`); for (const d of dirty) log.warn(`  ${d}`); if (apply) throw new PlatformError('Commit or stash changes before migrating.'); }
  else log.ok('working tree clean');
  if (!remote || !remote.includes(env.githubSshHost)) log.warn(`Remote does not use the ${env.githubSshHost} SSH alias`);
  const repoName = remote ? remote.replace(/\.git$/, '').split('/').pop() : null;

  // 2. Config
  const cfg = validateSiteConfig({
    ...buildSiteConfig({ name, slug, template: base === CORPORATE_REPO ? 'blank' : base, kind, env }),
    github: { repo: repoName, visibility: 'public' },
    site: { kind, environment: 'production', production_url: kind === 'corporate' ? `https://${env.baseDomain}` : `https://${slug}.${env.baseDomain}`, identity },
  }, { repo: repoName });
  if (oldDeployDir && oldDeployDir !== cfg.hosting.deploy_dir) throw new PlatformError(`Existing workflow deploys to ${oldDeployDir} but the platform rule gives ${cfg.hosting.deploy_dir}; refusing.`);
  const tag = `pre-platform-migration-${timestamp()}`;
  const existingPre = await git.tags(siteDir, 'pre-platform-migration-*');

  // Pre-migration record
  const recordDir = path.join(PLATFORM_DIR, 'docs', 'migrations');
  const record = [`# Pre-migration record: ${base}`, '', `Date: ${new Date().toISOString()}`, `Remote: ${remote}`, `Branch: ${branch} @ ${head}`, `Local branches: ${branches.join(', ')}`, `Remote branches: ${remoteBranches.join(', ')}`, `Deployment directory: ${oldDeployDir || 'unknown'}`, `Recovery tag: ${existingPre[0] || tag}`, '', '## Previous workflow (.github/workflows/deploy.yml)', '', '```yaml', oldWorkflow.trim(), '```', ''].join('\n');

  log.raw('');
  log.plan(`Record pre-migration state in ${path.join(recordDir, `${base}.md`)}`);
  log.plan(`Create recovery tag ${existingPre[0] ? `(exists: ${existingPre[0]})` : tag} on ${branch}@${head} and push it`);
  if (!branches.includes('main')) log.plan('Create main branch from deploy (development branch was missing)');
  log.plan(`Write ${SITE_CONFIG_FILE} (kind=${kind}, deploy_dir=${cfg.hosting.deploy_dir}), .gitignore, minimal caller workflow`);
  log.plan(`Set GitHub variables SITE_NAME=${name} SITE_DOMAIN=${cfg.domain.primary} DEPLOY_DIR=${cfg.hosting.deploy_dir} on ${env.githubOwner}/${repoName}; keep existing FTP_* secrets`);
  log.plan('Run local optimised build + QA');
  log.plan('Commit on main, push main, fast-forward deploy, push deploy (GitHub Actions deploys dist/)');
  log.plan(`Verify ${cfg.site.production_url} (DNS, HTTPS, identity "${identity}", CSS/JS/image)`);
  if (kind === 'corporate') log.plan(`Protect public_html/ entries: ${PROTECTED_PUBLIC_HTML.join(', ')} (checked before and after deployment)`);
  log.raw('');
  log.raw(serializeSiteConfig(cfg));
  if (!apply) { log.dry('Dry run. Re-run with --apply to migrate.'); return 0; }

  // Preconditions for apply
  await github.requireAuth();
  const platformRepo = await github.repoExists(env.platformRepo);
  if (!platformRepo) throw new PlatformError(`GitHub repository ${env.githubOwner}/${env.platformRepo} does not exist; the caller workflow needs it.`, { hint: 'Run: ./platform/bin/mybizgate publish-platform --apply' });
  const secrets = await github.listSecrets(repoName);
  const missing = ['FTP_SERVER', 'FTP_USERNAME', 'FTP_PASSWORD'].filter((s) => !secrets.includes(s));
  if (missing.length) throw new PlatformError(`Repository ${repoName} is missing secrets: ${missing.join(', ')}`);
  cpanel.requireConfigured();
  let beforeListing = null;
  if (kind === 'corporate') {
    beforeListing = await cpanel.listFiles('public_html');
    const names = new Set((beforeListing || []).map((f) => f.name));
    for (const p of PROTECTED_PUBLIC_HTML) log[names.has(p) ? 'ok' : 'warn'](`public_html/${p} ${names.has(p) ? 'present' : 'not present'}`);
    try {
      const state = await cpanel.uapi('Fileman', 'get_file_content', { dir: 'public_html', file: '.ftp-deploy-sync-state.json' });
      const tracked = Object.keys(JSON.parse(state.content || '{}').data || {});
      const bad = tracked.filter((f) => PROTECTED_PUBLIC_HTML.some((p) => f === p || f.startsWith(`${p}/`)));
      if (bad.length) throw new PlatformError(`FTP sync state tracks protected paths (${bad.slice(0, 5).join(', ')}); a deploy could delete them. Aborting.`);
      log.ok(`FTP sync state tracks ${tracked.length} paths, none inside protected directories`);
    } catch (err) { if (err instanceof PlatformError && /protected paths/.test(err.message)) throw err; log.warn(`Could not inspect FTP sync state: ${err.message}`); }
  }
  const liveBefore = await checkHttps(cfg.site.production_url);
  const liveBeforeBytes = liveBefore.body ? Buffer.byteLength(liveBefore.body) : 0;

  // 3. Recovery tag
  log.step('Recovery tag');
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, `${base}.md`), record);
  if (!existingPre.length) { await git.createTag(siteDir, tag, `Recovery point before MyBizGate platform migration (${oldDeployDir || 'unknown dir'})`); await git.push(siteDir, `refs/tags/${tag}`); log.ok(`Tag ${tag} pushed`); }
  else log.skip(`Recovery tag already exists: ${existingPre[0]}`);

  // 4. Branches
  if (!branches.includes('main')) { await git.createBranch(siteDir, 'main', 'deploy'); log.ok('Created main from deploy'); }
  await git.checkout(siteDir, 'main');
  if (remoteBranches.includes('main')) { const ab = await git.aheadBehind(siteDir, 'main', 'origin/main'); if (ab && ab.behind) throw new PlatformError('Local main is behind origin/main; pull first.'); }
  if (branches.includes('deploy') && (await git.aheadBehind(siteDir, 'main', 'deploy') || {}).behind) {
    await git.mergeFastForward(siteDir, 'main', 'deploy');
    log.ok('Fast-forwarded main to deploy');
  }

  // 5. Files
  log.step('Platform files');
  writeMigrationFiles(siteDir, cfg, env);
  log.ok(`Wrote ${SITE_CONFIG_FILE}, .gitignore, .github/workflows/deploy.yml`);

  // 6. Build
  log.step('Local build + QA');
  const report = await buildWithEngine(siteDir, { version: await git.headSha(siteDir) });
  const qa = await qaDist(path.join(siteDir, 'dist'));
  if (!qa.ok) throw new PlatformError(`QA failed: ${qa.errors.join('; ')}`);
  const s = summarizeReport(report);
  log.ok(`Build PASS: source ${s.source} -> dist ${s.dist}; images ${s.images}`);

  // 7. GitHub variables
  log.step('GitHub variables');
  await github.setVariable(repoName, 'SITE_NAME', name);
  await github.setVariable(repoName, 'SITE_DOMAIN', cfg.domain.primary);
  await github.setVariable(repoName, 'DEPLOY_DIR', cfg.hosting.deploy_dir);
  log.ok('SITE_NAME, SITE_DOMAIN, DEPLOY_DIR set');

  // 8. Commit + push
  log.step('Commit and push');
  await git.addAll(siteDir);
  const sha = await git.commit(siteDir, `${base}: migrate to MyBizGate platform build and shared deployment`);
  await git.push(siteDir, 'main', { setUpstream: true });
  await git.mergeFastForward(siteDir, 'deploy', 'main');
  await git.push(siteDir, 'deploy', { setUpstream: true });
  const deploySha = await git.headSha(siteDir, { ref: 'deploy' });
  log.ok(`Pushed main and deploy (${deploySha})`);
  try { await github.setDefaultBranch(repoName, 'main'); } catch (err) { log.warn(`default branch: ${err.message}`); }

  // 9. Monitor + verify
  log.step('Deployment');
  await github.waitForRun(repoName, { sha: deploySha, branch: 'deploy', timeoutMs: 20 * 60 * 1000 });
  const health = await waitForHealthy({ url: cfg.site.production_url, identity, expectedVersion: deploySha }, { timeoutMs: 5 * 60 * 1000 });
  assertHealthy(health);
  if (kind === 'corporate') {
    const after = await cpanel.listFiles('public_html');
    const names = new Set((after || []).map((f) => f.name));
    const lost = PROTECTED_PUBLIC_HTML.filter((p) => beforeListing && beforeListing.some((f) => f.name === p) && !names.has(p));
    if (lost.length) throw new PlatformError(`Protected directories missing after deployment: ${lost.join(', ')}. Restore from backup immediately.`);
    log.ok('Protected public_html directories intact after deployment');
  }
  const liveAfter = await checkHttps(cfg.site.production_url);
  log.raw('');
  log.raw(`MIGRATION COMPLETE: ${base}`);
  log.raw(`Production: ${cfg.site.production_url}`);
  log.raw(`Homepage bytes: ${formatBytes(liveBeforeBytes)} -> ${formatBytes(liveAfter.body ? Buffer.byteLength(liveAfter.body) : 0)}`);
  log.raw(`Local size: source ${s.source} -> dist ${s.dist} (HTML ${s.html}; CSS ${s.css}; JS ${s.js}; images ${s.images})`);
  log.raw(`Recovery tag: ${existingPre[0] || tag}   Rollback: ./platform/bin/rollback.sh ${base}`);
  return 0;
}

function writeMigrationFiles(siteDir, cfg, env) {
  const tpl = path.join(PLATFORM_DIR, 'templates', 'static-site');
  fs.writeFileSync(path.join(siteDir, SITE_CONFIG_FILE), serializeSiteConfig(cfg));
  const gi = path.join(siteDir, '.gitignore');
  const wanted = fs.readFileSync(path.join(tpl, '.gitignore'), 'utf8');
  if (!exists(gi)) fs.writeFileSync(gi, wanted);
  else {
    const have = fs.readFileSync(gi, 'utf8');
    const add = wanted.split('\n').filter((l) => l && !l.startsWith('#') && !have.split('\n').includes(l));
    if (add.length) fs.writeFileSync(gi, `${have.trimEnd()}\n\n# MyBizGate platform\n${add.join('\n')}\n`);
  }
  fs.mkdirSync(path.join(siteDir, '.github', 'workflows'), { recursive: true });
  const wf = fs.readFileSync(path.join(tpl, '.github', 'workflows', 'deploy.yml'), 'utf8').replace('mybizgate/mybizgate-platform/', `${env.githubOwner}/${env.platformRepo}/`).replace('@main', `@${env.platformRef}`);
  fs.writeFileSync(path.join(siteDir, '.github', 'workflows', 'deploy.yml'), wf);
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------
async function cmdRollback(opts, env) {
  const siteDir = resolveSiteDir(opts._[0]);
  const apply = Boolean(opts.apply);
  if (!(await git.isRepo(siteDir))) throw new PlatformError(`${siteDir} is not a Git repository.`);
  await git.fetch(siteDir);
  const prod = await git.tags(siteDir, 'prod-*');
  const recovery = await git.tags(siteDir, 'pre-platform-migration-*');
  log.raw(`Release tags (newest first): ${prod.slice(0, 10).join(', ') || 'none'}`);
  if (recovery.length) log.raw(`Recovery tags: ${recovery.join(', ')}`);
  const deployHead = await git.headSha(siteDir, { ref: 'deploy' });
  const current = prod.find((t) => t.endsWith(`-${deployHead}`));
  let target = opts.to;
  if (!target) {
    const candidates = prod.filter((t) => t !== current);
    target = candidates[0];
  }
  if (!target) throw new PlatformError('No rollback target. Pass --to <tag> (prod-* or pre-platform-migration-*).');
  if (!(await git.tagExists(siteDir, target))) throw new PlatformError(`Tag ${target} not found.`);
  const targetSha = await git.headSha(siteDir, { ref: `${target}^{commit}` });
  log.plan(`Roll deploy branch (${deployHead}${current ? `, ${current}` : ''}) back to ${target} (${targetSha}) with a new commit, push deploy and redeploy`);
  if (!apply) { log.dry('Dry run. Re-run with --apply to roll back.'); return 0; }
  if (!(await git.isClean(siteDir))) throw new PlatformError('Working tree is not clean.');
  if (!opts.yes && !(await confirm(`Roll back ${path.basename(siteDir)} production to ${target}?`))) { log.info('Aborted.'); return 1; }
  const before = await git.currentBranch(siteDir);
  await git.checkout(siteDir, 'deploy');
  try {
    await git.restoreTreeFrom(siteDir, targetSha);
    const sha = await git.commit(siteDir, `Rollback production to ${target}`);
    if (!sha) { log.info('deploy already matches the target; pushing to trigger redeploy'); await run('git', ['commit', '--allow-empty', '-q', '-m', `Redeploy ${target}`], { cwd: siteDir }); }
    await git.push(siteDir, 'deploy');
    log.ok(`deploy rolled back to ${target} and pushed`);
  } finally { if (before && before !== 'deploy') await git.checkout(siteDir, before); }
  const { github } = makeProviders(opts, env);
  const cfg = loadSiteConfig(siteDir);
  if ((await github.available()) && (await github.authStatus()).ok) {
    await github.waitForRun(cfg.github.repo, { sha: await git.headSha(siteDir, { ref: 'deploy' }), branch: 'deploy' });
    const h = await waitForHealthy({ url: cfg.site.production_url, identity: cfg.site.identity }, { timeoutMs: 5 * 60 * 1000 });
    assertHealthy(h);
  } else log.warn('gh not authenticated; monitor the deployment on GitHub manually.');
  log.info('main was not changed. Fix forward on main, then fast-forward deploy.');
  return 0;
}

// ---------------------------------------------------------------------------
// publish-platform
// ---------------------------------------------------------------------------
async function cmdPublishPlatform(opts, env) {
  const apply = Boolean(opts.apply);
  const { github } = makeProviders(opts, env);
  const dir = PLATFORM_DIR;
  const remote = naming.sshRemote(env.platformRepo, env);
  log.plan(`Ensure ${dir} is a Git repository with branch main`);
  log.plan(`Create public GitHub repository ${env.githubOwner}/${env.platformRepo} (reusable workflow must be reachable by site repositories)`);
  log.plan(`Set remote ${remote} and push main`);
  if (!apply) { log.dry('Dry run. Re-run with --apply.'); return 0; }
  await github.requireAuth();
  if (!(await git.isRepo(dir))) { await git.init(dir); await git.setLocalIdentity(dir, await git.resolveIdentity(env)); }
  await git.addAll(dir);
  const sha = await git.commit(dir, 'Platform update');
  if (sha) log.ok(`Committed ${sha}`); else log.skip('Nothing to commit');
  let repo = await github.repoExists(env.platformRepo);
  if (!repo) { repo = await github.createRepo({ name: env.platformRepo, visibility: 'public', description: 'MyBizGate website provisioning, build and deployment platform' }); log.ok(`Created ${repo.url}`); }
  else log.skip(`Repository exists: ${repo.url}`);
  await git.setRemote(dir, remote);
  await git.push(dir, 'main', { setUpstream: true });
  log.ok(`Pushed main to ${remote}`);
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
export async function main(argv) {
  const [command, ...rest] = argv;
  const opts = parseArgs(rest, { booleans: ['apply', 'resume', 'yes', 'mock', 'staging', 'help'], aliases: { y: 'yes' } });
  const env = loadEnv();
  if (!command || command === 'help' || command === '--help' || opts.help) { process.stdout.write(HELP); return 0; }
  switch (command) {
    case 'doctor': return cmdDoctor(opts, env);
    case 'build': return cmdBuild(opts, env);
    case 'qa': return cmdQa(opts, env);
    case 'resolve-target': return cmdResolveTarget(opts, env);
    case 'new-client': return cmdNewClient(opts, env);
    case 'site-status': return cmdSiteStatus(opts, env);
    case 'verify': return cmdVerify(opts, env);
    case 'migrate-existing': return cmdMigrateExisting(opts, env);
    case 'rollback': return cmdRollback(opts, env);
    case 'dns-instructions': return cmdDnsInstructions(opts, env);
    case 'publish-platform': return cmdPublishPlatform(opts, env);
    case 'templates': for (const t of TEMPLATES) log.raw(t); return 0;
    default: throw new PlatformError(`Unknown command "${command}".`, { hint: 'Run: mybizgate help' });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((err) => {
    log.fail(err instanceof PlatformError ? err.message : redact(err.stack || err.message));
    if (err.hint) log.info(err.hint);
    process.exit(1);
  });
}
