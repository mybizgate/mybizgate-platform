// Hosting provisioning (cPanel): subdomains, staging, custom domains, FTP isolation.
// Every mutating step is idempotent and honours dry-run.
import { log, PlatformError, randomPassword, registerSecret } from './utils.mjs';
import { naming, loadEnv } from './config.mjs';

export function hostingPlan(cfg, env = loadEnv()) {
  const steps = [];
  const slug = cfg.client.slug;
  const dir = cfg.hosting.deploy_dir;
  if (cfg.site.kind === 'corporate') {
    steps.push({ id: 'hosting-existing', text: `Use existing hosting for ${cfg.domain.primary} -> ${dir}` });
    return steps;
  }
  if (cfg.domain.type === 'subdomain') {
    steps.push({ id: 'subdomain', text: `Create subdomain ${cfg.domain.primary} -> ${dir}` });
  } else {
    steps.push({ id: 'staging', text: `Create staging subdomain ${cfg.domain.staging} -> ${dir}` });
    steps.push({ id: 'custom-domain', text: `Bind custom domain ${cfg.domain.primary} -> ${dir} (dns_mode=${cfg.domain.dns_mode})` });
    if (cfg.domain.dns_mode === 'awedns') steps.push({ id: 'delegation', text: `Wait for ${cfg.domain.primary} nameservers -> ${env.nameservers.join(', ')}` });
    else steps.push({ id: 'external-dns', text: `Generate dns-instructions.txt and wait for ${cfg.domain.primary} A record` });
  }
  if (cfg.hosting.ftp_account === 'dedicated') steps.push({ id: 'ftp', text: `Create dedicated FTP account ${naming.ftpLogin(slug, env)} restricted to ${dir}` });
  else steps.push({ id: 'ftp-shared', text: 'Use shared deployment FTP credential (FTP_USERNAME/FTP_PASSWORD from environment)' });
  steps.push({ id: 'autossl', text: `Ensure AutoSSL covers ${cfg.domain.staging || cfg.domain.primary}` });
  return steps;
}

export async function ensureSubdomain(provider, { host, label, dir, apply }) {
  log.check(`Subdomain ${host}`);
  const existing = await provider.findDomain(host);
  if (existing) {
    const root = existing.documentroot || '';
    if (root && !root.replace(/\/$/, '').endsWith(dir.replace(/\/$/, ''))) {
      throw new PlatformError(`Subdomain ${host} already exists with a different document root (${root}); refusing to reuse.`, { code: 'DOMAIN_COLLISION' });
    }
    log.ok(`Subdomain ${host} already exists${root ? ` -> ${root}` : ''}`);
    return { created: false, host };
  }
  if (!apply) { log.dry(`Would create subdomain ${host} -> ${dir}`); return { created: false, host, dryRun: true }; }
  const r = await provider.createSubdomain({ label, dir });
  const verify = await provider.domainExists(host);
  if (!verify) throw new PlatformError(`Subdomain ${host} was not listed after creation.`, { code: 'DOMAIN_VERIFY' });
  log.ok(`Subdomain ${host} created (${r.api}) -> ${dir}`);
  return { created: true, host };
}

export async function ensureCustomDomain(provider, { domain, label, dir, apply }) {
  log.check(`Custom domain ${domain}`);
  const existing = await provider.findDomain(domain);
  if (existing) {
    const root = existing.documentroot || '';
    if (root && !root.replace(/\/$/, '').endsWith(dir.replace(/\/$/, ''))) {
      throw new PlatformError(`Domain ${domain} already exists in cPanel with document root ${root}; refusing to rebind automatically.`, { code: 'DOMAIN_COLLISION' });
    }
    log.ok(`Custom domain ${domain} already bound${root ? ` -> ${root}` : ''}`);
    return { created: false, domain };
  }
  if (!apply) { log.dry(`Would bind custom domain ${domain} -> ${dir} (addon domain, helper label ${label})`); return { created: false, domain, dryRun: true }; }
  const r = await provider.addCustomDomain({ domain, dir, label });
  const verify = await provider.domainExists(domain);
  if (!verify) throw new PlatformError(`Domain ${domain} was not listed after binding.`, { code: 'DOMAIN_VERIFY' });
  log.ok(`Custom domain ${domain} bound (${r.api}) -> ${dir}`);
  return { created: true, domain };
}

/**
 * Ensure a dedicated FTP account restricted to the client deploy dir exists.
 * Returns credentials (password only when newly generated/rotated) so the caller can
 * store them as GitHub secrets. Falls back to the shared credential when unsupported.
 */
export async function ensureDedicatedFtp(provider, { slug, dir, apply, env = loadEnv() }) {
  const user = naming.ftpUser(slug);
  const login = naming.ftpLogin(slug, env);
  log.check(`Dedicated FTP account ${login} -> ${dir}`);
  let exists = false;
  try { exists = await provider.ftpAccountExists(login); } catch (err) { log.warn(`Could not list FTP accounts: ${err.message}`); }
  if (!apply) {
    log.dry(exists ? `FTP account ${login} exists; would rotate its password and store it as a GitHub secret` : `Would create FTP account ${login} restricted to ${dir}`);
    return { mode: 'dedicated', login, dryRun: true };
  }
  const password = randomPassword(28);
  registerSecret(password);
  try {
    if (exists) {
      log.info(`FTP account ${login} already exists; rotating password so GitHub secrets can be refreshed`);
      await provider.setFtpPassword({ user: login, password });
      log.ok(`FTP password rotated for ${login}`);
    } else {
      await provider.createFtpAccount({ user, password, homedir: dir });
      log.ok(`FTP account ${login} created, home ${dir}`);
    }
    return { mode: 'dedicated', login, password, server: env.ftpServer };
  } catch (err) {
    log.warn(`Dedicated FTP account unsupported or failed: ${err.message}`);
    if (!env.ftpUsername || !env.ftpPassword) {
      throw new PlatformError('Dedicated FTP failed and no shared FTP_USERNAME/FTP_PASSWORD is available for fallback.', { code: 'FTP_FALLBACK', hint: 'Export FTP_USERNAME and FTP_PASSWORD (shared deploy credential) or fix the cPanel FTP API.' });
    }
    log.warn(`FALLBACK: using shared FTP credential ${env.ftpUsername}; deployment isolation relies on path validation only.`);
    return { mode: 'shared', login: env.ftpUsername, password: env.ftpPassword, server: env.ftpServer, fallback: true, reason: err.message };
  }
}

export function sharedFtp(env = loadEnv()) {
  if (!env.ftpUsername || !env.ftpPassword) return { mode: 'shared', login: env.ftpUsername, server: env.ftpServer, missing: true };
  registerSecret(env.ftpPassword);
  return { mode: 'shared', login: env.ftpUsername, password: env.ftpPassword, server: env.ftpServer };
}
