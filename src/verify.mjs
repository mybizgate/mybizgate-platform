// Production health checks and dist QA.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHttps } from './ssl.mjs';
import { log, PlatformError, poll } from './utils.mjs';

const BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');

export async function qaDist(distDir) {
  const { validateDist } = await import(path.join(BUILD_DIR, 'lib', 'validate.mjs'));
  return validateDist(distDir);
}

function firstMatch(html, re) { const m = re.exec(html); return m ? (m[1] || m[2]) : null; }

export function extractCriticalAssets(html) {
  const css = firstMatch(html, /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/i) || firstMatch(html, /<link[^>]+href=["']([^"']+\.css[^"']*)["'][^>]*rel=["']stylesheet["']/i);
  const js = firstMatch(html, /<script[^>]+src=["']([^"']+)["']/i);
  const img = firstMatch(html, /<img[^>]+src=["']([^"']+)["']/i) || firstMatch(html, /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  const title = firstMatch(html, /<title[^>]*>([^<]*)<\/title>/i);
  const version = firstMatch(html, /<meta[^>]+name=["']build-version["'][^>]*content=["']([^"']+)["']/i);
  const whatsapp = firstMatch(html, /href=["'](https:\/\/(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)[^"']*)["']/i);
  return { css, js, img, title, version, whatsapp, hasInlineCss: /<style[\s>]/i.test(html), hasInlineJs: /<script(?![^>]*\bsrc=)[\s>]/i.test(html) };
}

function isExternal(ref) { return /^(?:[a-z]+:)?\/\//i.test(ref) || /^(data|mailto|tel):/i.test(ref); }

export async function healthCheck({ url, identity, expectedVersion, requireJs = false }) {
  const results = [];
  const add = (name, ok, detail) => { results.push({ name, ok, detail }); (ok ? log.ok : log.fail)(`${name}: ${detail}`); };
  const base = url.endsWith('/') ? url : `${url}/`;
  log.check(`Production health for ${base}`);
  const home = await checkHttps(base);
  add('HTTPS', Boolean(home.status) && !home.tlsError, home.error ? `error ${home.error}` : `certificate OK${home.cert ? ` (${home.cert.subject}, ${home.cert.issuer})` : ''}`);
  add('HTTP status', home.status === 200, `status ${home.status || 'none'}`);
  const html = home.body || '';
  const assets = extractCriticalAssets(html);
  if (identity) {
    const found = html.toLowerCase().includes(identity.toLowerCase());
    add('Site identity', found, found ? `found "${identity}" (title: ${assets.title || 'n/a'})` : `"${identity}" not found in homepage (title: ${assets.title || 'n/a'})`);
  }
  if (expectedVersion) add('Build version', assets.version === expectedVersion, `deployed ${assets.version || 'none'}, expected ${expectedVersion}`);
  else if (assets.version) log.info(`Deployed build version: ${assets.version}`);

  const checkAsset = async (label, ref) => {
    if (isExternal(ref)) { log.info(`${label}: external (${ref}) skipped`); return; }
    const target = new URL(ref, base).toString();
    const r = await checkHttps(target, { method: 'HEAD' });
    add(label, r.status === 200, `${target} -> ${r.status || r.error}`);
  };
  if (assets.css) await checkAsset('CSS reachable', assets.css);
  else add('CSS reachable', assets.hasInlineCss, assets.hasInlineCss ? 'inline <style> present' : 'no stylesheet or inline style found');
  if (assets.js) await checkAsset('JS reachable', assets.js);
  else if (assets.hasInlineJs) add('JS reachable', true, 'inline <script> present');
  else if (requireJs) add('JS reachable', false, 'no script found');
  else log.info('JS reachable: no script referenced (skipped)');
  if (assets.img) await checkAsset('Critical image reachable', assets.img);
  else add('Critical image reachable', false, 'no <img> or og:image found');
  if (assets.whatsapp) {
    const ok = /^https:\/\/(wa\.me\/\d{6,15}|api\.whatsapp\.com\/send|chat\.whatsapp\.com\/)/.test(assets.whatsapp);
    add('WhatsApp link', ok, assets.whatsapp);
  }
  const ok = results.every((r) => r.ok);
  return { ok, results, assets, status: home.status };
}

export async function waitForHealthy(opts, { timeoutMs = 5 * 60 * 1000, intervalMs = 20000 } = {}) {
  return poll({
    label: `healthy production at ${opts.url}`,
    timeoutMs,
    intervalMs,
    fn: async () => {
      const r = await healthCheck(opts);
      if (r.ok) return { done: true, value: r };
      return { done: false, hint: r.results.filter((x) => !x.ok).map((x) => x.name).join(', ') };
    },
    onTick: (n, r) => log.info(`Health not ready (attempt ${n}): ${r && r.hint}`),
  });
}

export function assertHealthy(result) {
  if (!result.ok) {
    throw new PlatformError(`Production health check failed: ${result.results.filter((r) => !r.ok).map((r) => `${r.name} (${r.detail})`).join('; ')}`, { code: 'HEALTH_FAILED' });
  }
}
