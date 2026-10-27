// Thin Git helpers. Every call uses argument arrays (no shell interpolation).
import path from 'node:path';
import { run, PlatformError, exists } from './utils.mjs';
import { WORKSPACE_DIR } from './config.mjs';

const git = (cwd, args, opts = {}) => run('git', args, { cwd, ...opts });

export async function isRepo(cwd) {
  if (!exists(path.join(cwd, '.git'))) return false;
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function status(cwd) {
  const r = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  return r.stdout.split('\n').filter(Boolean);
}

export async function isClean(cwd) {
  return (await status(cwd)).length === 0;
}

export async function currentBranch(cwd) {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function localBranches(cwd) {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function remoteBranches(cwd, remote = 'origin') {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}/`], { allowFailure: true });
  return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(`${remote}/`, '')) : [];
}

export async function remoteUrl(cwd, remote = 'origin') {
  const r = await git(cwd, ['remote', 'get-url', remote], { allowFailure: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function headSha(cwd, { short = true, ref = 'HEAD' } = {}) {
  const r = await git(cwd, ['rev-parse', ...(short ? ['--short=8'] : []), ref]);
  return r.stdout.trim();
}

export async function recentLog(cwd, n = 10) {
  const r = await git(cwd, ['log', '--oneline', `-${n}`], { allowFailure: true });
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
}

export async function tags(cwd, pattern) {
  const r = await git(cwd, ['tag', '--list', ...(pattern ? [pattern] : []), '--sort=-creatordate']);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function tagExists(cwd, tag) {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true });
  return r.code === 0;
}

export async function createTag(cwd, tag, message, ref = 'HEAD') {
  await git(cwd, ['tag', '-a', tag, '-m', message, ref]);
}

export async function push(cwd, refspec, { remote = 'origin', setUpstream = false, tagsOnly = false } = {}) {
  const args = ['push'];
  if (setUpstream) args.push('-u');
  args.push(remote);
  if (tagsOnly) args.push('--tags'); else args.push(refspec);
  return git(cwd, args, { timeoutMs: 300000 });
}

export async function fetch(cwd, remote = 'origin') {
  return git(cwd, ['fetch', '--prune', remote], { allowFailure: true, timeoutMs: 120000 });
}

export async function init(cwd, { defaultBranch = 'main' } = {}) {
  await git(cwd, ['init', '-q', '-b', defaultBranch]);
}

export async function resolveIdentity(env = process.env) {
  if (env.MYBIZGATE_GIT_NAME && env.MYBIZGATE_GIT_EMAIL) return { name: env.MYBIZGATE_GIT_NAME, email: env.MYBIZGATE_GIT_EMAIL };
  // Reuse the local identity of an existing MyBizGate repository when available.
  for (const site of ['mybizgate-site', 'petgate']) {
    const dir = path.join(WORKSPACE_DIR, site);
    if (!(await isRepo(dir))) continue;
    const name = (await git(dir, ['config', '--local', 'user.name'], { allowFailure: true })).stdout.trim();
    const email = (await git(dir, ['config', '--local', 'user.email'], { allowFailure: true })).stdout.trim();
    if (name && email) return { name, email };
  }
  return null;
}

export async function setLocalIdentity(cwd, identity) {
  if (!identity) return;
  await git(cwd, ['config', '--local', 'user.name', identity.name]);
  await git(cwd, ['config', '--local', 'user.email', identity.email]);
}

export async function addAll(cwd) {
  await git(cwd, ['add', '-A']);
}

export async function commit(cwd, message, { allowEmpty = false } = {}) {
  const staged = await git(cwd, ['diff', '--cached', '--quiet'], { allowFailure: true });
  if (staged.code === 0 && !allowEmpty) return null;
  await git(cwd, ['commit', '-q', '-m', message, ...(allowEmpty ? ['--allow-empty'] : [])]);
  return headSha(cwd);
}

export async function branchExists(cwd, branch) {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true });
  return r.code === 0;
}

export async function createBranch(cwd, branch, from = 'HEAD') {
  await git(cwd, ['branch', branch, from]);
}

export async function checkout(cwd, branch) {
  await git(cwd, ['checkout', '-q', branch]);
}

export async function setRemote(cwd, url, remote = 'origin') {
  const existing = await remoteUrl(cwd, remote);
  if (existing === url) return;
  if (existing) await git(cwd, ['remote', 'set-url', remote, url]);
  else await git(cwd, ['remote', 'add', remote, url]);
}

export async function mergeFastForward(cwd, target, source) {
  const before = await currentBranch(cwd);
  await checkout(cwd, target);
  try {
    await git(cwd, ['merge', '--ff-only', source]);
  } catch (err) {
    throw new PlatformError(`Cannot fast-forward ${target} from ${source}: ${err.message}`, {
      hint: `Resolve manually: git checkout ${target} && git merge ${source}`,
    });
  } finally {
    if (before && before !== target) await checkout(cwd, before);
  }
}

export async function aheadBehind(cwd, left, right) {
  const r = await git(cwd, ['rev-list', '--left-right', '--count', `${left}...${right}`], { allowFailure: true });
  if (r.code !== 0) return null;
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

/** Make the working tree + index of the current branch identical to <ref> (used for rollback). */
export async function restoreTreeFrom(cwd, ref) {
  await git(cwd, ['read-tree', '-u', '--reset', ref]);
}

export async function lsRemoteHeads(url) {
  const r = await run('git', ['ls-remote', '--heads', url], { allowFailure: true, timeoutMs: 60000 });
  if (r.code !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1].replace('refs/heads/', ''));
}
