// CPanelProvider: the single place that talks to the cPanel API.
// UAPI is preferred; the deprecated API 2 calls that this hosting still needs
// (addon-domain management, subdomain removal) are isolated in this file.
import { PlatformError, registerSecret, redact } from './utils.mjs';
import { loadEnv } from './config.mjs';

export class CPanelProvider {
  constructor(env = loadEnv(), { fetchImpl = globalThis.fetch } = {}) {
    this.host = env.cpanelHost;
    this.user = env.cpanelUser;
    this.token = env.cpanelToken;
    this.port = env.cpanelPort || 2083;
    this.baseDomain = env.baseDomain;
    this.fetch = fetchImpl;
    if (this.token) registerSecret(this.token);
  }

  get configured() { return Boolean(this.host && this.user && this.token); }

  requireConfigured() {
    if (!this.configured) {
      throw new PlatformError('cPanel API is not configured (CPANEL_HOST, CPANEL_USER, CPANEL_TOKEN).', {
        code: 'CPANEL_NOT_CONFIGURED',
        hint: 'Add them to the workspace root .env (loaded automatically; POSIX or Fish syntax) or export them in your shell. Run `mybizgate env` to see what is set.',
      });
    }
  }

  async request(pathname, params = {}, { method = 'GET' } = {}) {
    this.requireConfigured();
    const url = new URL(`https://${this.host}:${this.port}${pathname}`);
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
    const init = { method, headers: { Authorization: `cpanel ${this.user}:${this.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(60000) };
    if (method === 'GET') url.search = body.toString();
    else { init.body = body.toString(); init.headers['content-type'] = 'application/x-www-form-urlencoded'; }
    let res;
    try {
      res = await this.fetch(url, init);
    } catch (err) {
      throw new PlatformError(`cPanel API request failed: ${redact(err.message)}`, { code: 'CPANEL_NETWORK' });
    }
    if (res.status === 401 || res.status === 403) throw new PlatformError(`cPanel API authentication failed (HTTP ${res.status}).`, { code: 'CPANEL_AUTH', hint: 'Check CPANEL_USER / CPANEL_TOKEN.' });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new PlatformError(`cPanel API returned non-JSON (HTTP ${res.status}) for ${pathname}: ${redact(text.slice(0, 200))}`, { code: 'CPANEL_BAD_RESPONSE' }); }
    return json;
  }

  /** UAPI call: /execute/<Module>/<function> */
  async uapi(module, fn, params = {}, opts = {}) {
    const json = await this.request(`/execute/${module}/${fn}`, params, opts);
    if (json.status !== 1) {
      const errors = (json.errors || ['unknown error']).map(String);
      const e = new PlatformError(`cPanel UAPI ${module}/${fn} failed: ${errors.join('; ')}`, { code: 'CPANEL_UAPI' });
      e.errors = errors;
      throw e;
    }
    return json.data;
  }

  /** Deprecated API 2 call, isolated here on purpose. */
  async api2(module, fn, params = {}, opts = { method: 'POST' }) {
    const json = await this.request('/json-api/cpanel', {
      cpanel_jsonapi_user: this.user,
      cpanel_jsonapi_apiversion: 2,
      cpanel_jsonapi_module: module,
      cpanel_jsonapi_func: fn,
      ...params,
    }, opts);
    const result = json.cpanelresult || {};
    const event = result.event || {};
    if (event.result === 0 || result.error) {
      const msg = result.error || event.reason || JSON.stringify(result.data || {}).slice(0, 300);
      throw new PlatformError(`cPanel API2 ${module}::${fn} failed: ${msg}`, { code: 'CPANEL_API2' });
    }
    const data = Array.isArray(result.data) ? result.data : [result.data];
    const first = data[0] || {};
    if (first.result === 0 || first.status === 0) {
      throw new PlatformError(`cPanel API2 ${module}::${fn} failed: ${first.reason || first.statusmsg || 'unknown error'}`, { code: 'CPANEL_API2' });
    }
    return data;
  }

  // ---- Domains -----------------------------------------------------------
  async listDomains() {
    const d = await this.uapi('DomainInfo', 'list_domains');
    return { main: d.main_domain, subdomains: d.sub_domains || [], addons: d.addon_domains || [], parked: d.parked_domains || [] };
  }

  async domainsData() {
    const d = await this.uapi('DomainInfo', 'domains_data', { format: 'hash' });
    const all = [];
    if (d.main_domain) all.push({ ...d.main_domain, kind: 'main' });
    for (const s of d.sub_domains || []) all.push({ ...s, kind: 'sub' });
    for (const a of d.addon_domains || []) all.push({ ...a, kind: 'addon' });
    for (const p of d.parked_domains || []) all.push({ ...p, kind: 'parked' });
    return all;
  }

  async findDomain(host) {
    const all = await this.domainsData();
    return all.find((d) => d.domain === host) || null;
  }

  async domainExists(host) {
    const d = await this.listDomains();
    return [d.main, ...d.subdomains, ...d.addons, ...d.parked].includes(host);
  }

  async serverIp() {
    const all = await this.domainsData();
    const main = all.find((d) => d.kind === 'main');
    return (main && (main.ip || main.ipv4)) || null;
  }

  /**
   * Create a MyBizGate subdomain pointing at a document root (relative to the account home).
   * Tries UAPI first, then falls back to API 2 if the host does not expose the UAPI function.
   */
  async createSubdomain({ label, rootDomain = this.baseDomain, dir }) {
    const params = { domain: label, rootdomain: rootDomain, dir: dir.replace(/\/$/, ''), disallowdot: 1 };
    try {
      await this.uapi('SubDomain', 'addsubdomain', params, { method: 'POST' });
      return { api: 'uapi', host: `${label}.${rootDomain}` };
    } catch (err) {
      if (!/not found|unknown|does not exist|no such|Could not find/i.test(err.message)) throw err;
      await this.api2('SubDomain', 'addsubdomain', params);
      return { api: 'api2', host: `${label}.${rootDomain}` };
    }
  }

  /** Remove a subdomain. Callers must obtain explicit confirmation first. */
  async removeSubdomain(host) {
    await this.api2('SubDomain', 'delsubdomain', { domain: host });
    return { api: 'api2', host };
  }

  /**
   * Bind a custom (addon) domain to a document root. cPanel requires a helper
   * subdomain label for addon domains; we derive it from the client slug.
   */
  async addCustomDomain({ domain, dir, label }) {
    await this.api2('AddonDomain', 'addaddondomain', { newdomain: domain, subdomain: label, dir: dir.replace(/\/$/, '') });
    return { api: 'api2', domain, dir };
  }

  /** Remove a custom (addon) domain. Callers must obtain explicit confirmation first. */
  async removeCustomDomain({ domain, label }) {
    const found = await this.findDomain(domain);
    const sub = (found && found.subdomain) || `${label}.${this.baseDomain}`;
    await this.api2('AddonDomain', 'deladdondomain', { domain, subdomain: sub });
    return { api: 'api2', domain };
  }

  // ---- FTP ---------------------------------------------------------------
  async listFtpAccounts() {
    const d = await this.uapi('Ftp', 'list_ftp');
    return (d || []).map((a) => ({ user: a.user, type: a.type, homedir: a.homedir }));
  }

  async ftpAccountExists(login) {
    const accounts = await this.listFtpAccounts();
    const short = login.split('@')[0];
    return accounts.some((a) => a.user === login || a.user === short);
  }

  /** Create a restricted FTP account. The password is sent in the POST body and never logged. */
  async createFtpAccount({ user, password, homedir, quota = 0 }) {
    registerSecret(password);
    await this.uapi('Ftp', 'add_ftp', { user, pass: password, homedir: homedir.replace(/\/$/, ''), quota }, { method: 'POST' });
    return { user, login: `${user}@${this.baseDomain}`, homedir };
  }

  async setFtpPassword({ user, password }) {
    registerSecret(password);
    await this.uapi('Ftp', 'passwd', { user, pass: password }, { method: 'POST' });
    return { user };
  }

  async deleteFtpAccount({ user, destroyFiles = false }) {
    await this.uapi('Ftp', 'delete_ftp', { user, destroy: destroyFiles ? 1 : 0 }, { method: 'POST' });
  }

  // ---- AutoSSL -------------------------------------------------------------
  async installedHosts() {
    return (await this.uapi('SSL', 'installed_hosts')) || [];
  }

  async checkAutoSSL(host) {
    const [hosts, problems, inProgress] = await Promise.all([
      this.installedHosts(),
      this.uapi('SSL', 'get_autossl_problems').catch(() => []),
      this.uapi('SSL', 'is_autossl_check_in_progress').catch(() => 0),
    ]);
    const match = hosts.find((h) => {
      const names = new Set([...(h.certificate && h.certificate.domains) || [], ...(h.fqdns || [])]);
      return names.has(host) || [...names].some((n) => n.startsWith('*.') && host.endsWith(n.slice(1)) && host.split('.').length === n.split('.').length);
    });
    const expires = match && match.certificate && match.certificate.not_after ? new Date(match.certificate.not_after * 1000).toISOString() : null;
    return {
      covered: Boolean(match),
      expires,
      issuer: match && match.certificate ? match.certificate.issuer_organization_name : null,
      inProgress: Boolean(Number(inProgress)),
      problems: (problems || []).filter((p) => p.domain === host),
    };
  }

  async startAutoSSL() {
    await this.uapi('SSL', 'start_autossl_check', {}, { method: 'POST' });
  }

  // ---- Files -----------------------------------------------------------------
  async listFiles(dir) {
    try {
      const d = await this.uapi('Fileman', 'list_files', { dir, include_hash: 0, show_hidden: 1 });
      return (d || []).map((f) => ({ name: f.file, type: f.type, size: Number(f.size || 0) }));
    } catch (err) {
      if (/No such|not exist|does not exist|cannot access/i.test(err.message)) return null;
      throw err;
    }
  }

  async dirExists(dir) {
    const files = await this.listFiles(dir);
    return files !== null;
  }
}

/** In-memory mock used by unit tests and by `--mock` runs. */
export class MockCPanelProvider {
  constructor({ domains = ['mybizgate.com'], subdomains = [], addons = [], ftp = [], ssl = [], files = {} } = {}) {
    this.state = { main: domains[0], subdomains: [...subdomains], addons: [...addons], ftp: [...ftp], ssl: [...ssl], files, calls: [] };
    this.baseDomain = domains[0];
  }
  get configured() { return true; }
  requireConfigured() {}
  async listDomains() { return { main: this.state.main, subdomains: this.state.subdomains, addons: this.state.addons, parked: [] }; }
  async domainsData() { return [{ domain: this.state.main, kind: 'main', documentroot: '/home/mybizgat/public_html', ip: '203.0.113.10' }, ...this.state.subdomains.map((d) => ({ domain: d, kind: 'sub' })), ...this.state.addons.map((d) => ({ domain: d, kind: 'addon' }))]; }
  async findDomain(host) { return (await this.domainsData()).find((d) => d.domain === host) || null; }
  async domainExists(host) { const d = await this.listDomains(); return [d.main, ...d.subdomains, ...d.addons].includes(host); }
  async serverIp() { return '203.0.113.10'; }
  async createSubdomain({ label, rootDomain = this.baseDomain, dir }) { this.state.calls.push(['createSubdomain', label, dir]); this.state.subdomains.push(`${label}.${rootDomain}`); return { api: 'mock', host: `${label}.${rootDomain}` }; }
  async removeSubdomain(host) { this.state.calls.push(['removeSubdomain', host]); this.state.subdomains = this.state.subdomains.filter((d) => d !== host); }
  async addCustomDomain({ domain, dir }) { this.state.calls.push(['addCustomDomain', domain, dir]); this.state.addons.push(domain); return { api: 'mock', domain, dir }; }
  async removeCustomDomain({ domain }) { this.state.calls.push(['removeCustomDomain', domain]); this.state.addons = this.state.addons.filter((d) => d !== domain); }
  async listFtpAccounts() { return this.state.ftp; }
  async ftpAccountExists(login) { return this.state.ftp.some((a) => a.user === login || a.user === login.split('@')[0]); }
  async createFtpAccount({ user, homedir }) { this.state.calls.push(['createFtpAccount', user, homedir]); this.state.ftp.push({ user: `${user}@${this.baseDomain}`, type: 'sub', homedir }); return { user, login: `${user}@${this.baseDomain}`, homedir }; }
  async setFtpPassword({ user }) { this.state.calls.push(['setFtpPassword', user]); return { user }; }
  async deleteFtpAccount({ user }) { this.state.calls.push(['deleteFtpAccount', user]); }
  async checkAutoSSL(host) { return { covered: this.state.ssl.includes(host), expires: null, issuer: 'mock', inProgress: false, problems: [] }; }
  async startAutoSSL() { this.state.calls.push(['startAutoSSL']); for (const d of [...this.state.subdomains, ...this.state.addons]) if (!this.state.ssl.includes(d)) this.state.ssl.push(d); }
  async listFiles(dir) { return this.state.files[dir] || null; }
  async dirExists(dir) { return Boolean(this.state.files[dir]); }
}
