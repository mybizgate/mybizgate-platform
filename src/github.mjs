// GitHubProvider: wraps the GitHub CLI (`gh`). It uses a dedicated gh config
// directory for the MyBizGate account so the user's office identity is untouched.
import { run, runWithInput, PlatformError, registerSecret, poll, log } from './utils.mjs';
import { loadEnv } from './config.mjs';

export class GitHubProvider {
  constructor(env = loadEnv()) {
    this.owner = env.githubOwner;
    this.env = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    if (env.ghToken) { this.env.GH_TOKEN = env.ghToken; registerSecret(env.ghToken); } else this.env.GH_CONFIG_DIR = env.ghConfigDir;
    this.configDir = env.ghConfigDir;
  }

  gh(args, opts = {}) { return run('gh', args, { env: this.env, ...opts }); }
  ghJson(args, opts = {}) { return this.gh(args, opts).then((r) => JSON.parse(r.stdout || 'null')); }

  async available() {
    const r = await run('gh', ['--version'], { allowFailure: true }).catch(() => ({ code: 1 }));
    return r.code === 0;
  }

  async authStatus() {
    const r = await this.gh(['auth', 'status', '--hostname', 'github.com'], { allowFailure: true });
    if (r.code !== 0) {
      return { ok: false, login: null, message: (r.stderr || r.stdout).trim().split('\n')[0] || 'not logged in' };
    }
    const login = (await this.gh(['api', 'user', '--jq', '.login'], { allowFailure: true })).stdout.trim() || null;
    const scopes = ((r.stdout + r.stderr).match(/Token scopes: (.*)/) || [])[1] || '';
    return { ok: true, login, scopes, message: `logged in as ${login}` };
  }

  requireAuthHint() {
    return `Authenticate the MyBizGate GitHub account without touching your office identity:\n  GH_CONFIG_DIR=${this.configDir} gh auth login --hostname github.com --git-protocol ssh --scopes repo,workflow\n(or export MYBIZGATE_GH_TOKEN with a token that has repo + workflow scopes).`;
  }

  async requireAuth() {
    const s = await this.authStatus();
    if (!s.ok) throw new PlatformError(`GitHub CLI is not authenticated for the ${this.owner} account.`, { code: 'GH_AUTH', hint: this.requireAuthHint() });
    if (s.login && s.login.toLowerCase() !== this.owner.toLowerCase()) {
      log.warn(`gh is authenticated as "${s.login}" but the owner is "${this.owner}"; repository creation under ${this.owner} may fail.`);
    }
    return s;
  }

  fullName(repo) { return repo.includes('/') ? repo : `${this.owner}/${repo}`; }

  async repoExists(repo) {
    const r = await this.gh(['repo', 'view', this.fullName(repo), '--json', 'name,visibility,defaultBranchRef,url'], { allowFailure: true });
    if (r.code !== 0) {
      if (/Could not resolve|not found|404/i.test(r.stderr + r.stdout)) return null;
      throw new PlatformError(`gh repo view failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return JSON.parse(r.stdout);
  }

  async createRepo({ name, visibility = 'private', description = '' }) {
    await this.gh(['repo', 'create', this.fullName(name), `--${visibility}`, '--description', description || `MyBizGate site ${name}`]);
    return this.repoExists(name);
  }

  async setDefaultBranch(repo, branch) {
    await this.gh(['repo', 'edit', this.fullName(repo), '--default-branch', branch]);
  }

  async listVariables(repo) {
    const r = await this.gh(['variable', 'list', '--repo', this.fullName(repo), '--json', 'name,value'], { allowFailure: true });
    return r.code === 0 ? JSON.parse(r.stdout || '[]') : [];
  }

  async setVariable(repo, name, value) {
    await this.gh(['variable', 'set', name, '--repo', this.fullName(repo), '--body', String(value)]);
  }

  async listSecrets(repo) {
    const r = await this.gh(['secret', 'list', '--repo', this.fullName(repo), '--json', 'name'], { allowFailure: true });
    return r.code === 0 ? JSON.parse(r.stdout || '[]').map((s) => s.name) : [];
  }

  /** The secret value travels over stdin; it never appears in argv or logs. */
  async setSecret(repo, name, value) {
    registerSecret(value);
    await runWithInput('gh', ['secret', 'set', name, '--repo', this.fullName(repo)], value, { env: this.env });
  }

  async listRuns(repo, { branch, limit = 5 } = {}) {
    const args = ['run', 'list', '--repo', this.fullName(repo), '--limit', String(limit), '--json', 'databaseId,status,conclusion,url,headSha,createdAt,headBranch,displayTitle'];
    if (branch) args.push('--branch', branch);
    const r = await this.gh(args, { allowFailure: true });
    return r.code === 0 ? JSON.parse(r.stdout || '[]') : [];
  }

  async waitForRun(repo, { sha, branch = 'deploy', timeoutMs = 15 * 60 * 1000, intervalMs = 15000 } = {}) {
    log.check(`GitHub Actions run for ${this.fullName(repo)}@${branch}${sha ? ` (${sha.slice(0, 8)})` : ''}`);
    return poll({
      label: `GitHub Actions deployment of ${repo}`,
      timeoutMs,
      intervalMs,
      fn: async () => {
        const runs = await this.listRuns(repo, { branch, limit: 10 });
        const match = sha ? runs.find((r) => r.headSha.startsWith(sha)) : runs[0];
        if (!match) return { done: false, hint: 'run not started yet' };
        if (match.status === 'completed') {
          if (match.conclusion === 'success') { log.ok(`Deployment run succeeded: ${match.url}`); return { done: true, value: match }; }
          throw new PlatformError(`Deployment run ${match.conclusion}: ${match.url}`, { code: 'RUN_FAILED', hint: `Inspect logs with: gh run view ${match.databaseId} --repo ${this.fullName(repo)} --log-failed` });
        }
        return { done: false, hint: `${match.status} ${match.url}` };
      },
      onTick: (n, r) => log.info(`Deployment ${r && r.hint} (attempt ${n})`),
    });
  }
}

export class MockGitHubProvider {
  constructor({ repos = [], login = 'mybizgate' } = {}) {
    this.owner = 'mybizgate';
    this.state = { repos: new Map(repos.map((r) => [r, { name: r, visibility: 'PRIVATE', variables: {}, secrets: new Set() }])), calls: [], login };
  }
  fullName(repo) { return repo.includes('/') ? repo : `${this.owner}/${repo}`; }
  async available() { return true; }
  async authStatus() { return { ok: true, login: this.state.login, scopes: 'repo, workflow' }; }
  async requireAuth() { return this.authStatus(); }
  async repoExists(repo) { const n = repo.replace(/^.*\//, ''); return this.state.repos.get(n) || null; }
  async createRepo({ name, visibility = 'private' }) { this.state.calls.push(['createRepo', name, visibility]); const r = { name, visibility: visibility.toUpperCase(), variables: {}, secrets: new Set(), url: `https://github.com/mybizgate/${name}` }; this.state.repos.set(name, r); return r; }
  async setDefaultBranch(repo, branch) { this.state.calls.push(['setDefaultBranch', repo, branch]); }
  async listVariables(repo) { const r = this.state.repos.get(repo.replace(/^.*\//, '')); return r ? Object.entries(r.variables).map(([name, value]) => ({ name, value })) : []; }
  async setVariable(repo, name, value) { this.state.calls.push(['setVariable', repo, name, value]); const r = this.state.repos.get(repo.replace(/^.*\//, '')); if (r) r.variables[name] = value; }
  async listSecrets(repo) { const r = this.state.repos.get(repo.replace(/^.*\//, '')); return r ? [...r.secrets] : []; }
  async setSecret(repo, name) { this.state.calls.push(['setSecret', repo, name]); const r = this.state.repos.get(repo.replace(/^.*\//, '')); if (r) r.secrets.add(name); }
  async listRuns() { return [{ databaseId: 1, status: 'completed', conclusion: 'success', url: 'https://github.com/mock/run/1', headSha: 'mock', createdAt: new Date().toISOString() }]; }
  async waitForRun() { return { status: 'completed', conclusion: 'success', url: 'https://github.com/mock/run/1' }; }
}
