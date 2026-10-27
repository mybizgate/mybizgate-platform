// HTTPS / AutoSSL verification with bounded polling.
import https from 'node:https';
import { poll, log } from './utils.mjs';

export function checkHttps(url, { timeoutMs = 15000, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (err) { return resolve({ ok: false, error: `Invalid URL: ${err.message}` }); }
    const req = https.request(u, { method, timeout: timeoutMs, rejectUnauthorized: true, headers: { 'user-agent': 'mybizgate-platform/1.0' } }, (res) => {
      const cert = res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 2 * 1024 * 1024) body += d; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 400,
        status: res.statusCode,
        headers: res.headers,
        body,
        cert: cert && cert.subject ? { subject: cert.subject.CN, issuer: cert.issuer && cert.issuer.O, validTo: cert.valid_to, altNames: cert.subjectaltname } : null,
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message, tlsError: /CERT|SSL|TLS|self.signed|altname|EPROTO/i.test(err.code || err.message) }));
    req.end();
  });
}

export async function waitForHttps(host, { timeoutMs = 20 * 60 * 1000, intervalMs = 30000 } = {}) {
  const url = `https://${host}/`;
  log.check(`HTTPS for ${url}`);
  return poll({
    label: `valid HTTPS certificate for ${host}`,
    timeoutMs,
    intervalMs,
    fn: async () => {
      const r = await checkHttps(url, { method: 'HEAD' });
      if (r.ok || (r.status && !r.tlsError)) { log.ok(`HTTPS OK ${host} (status ${r.status}${r.cert ? `, cert ${r.cert.subject} by ${r.cert.issuer}` : ''})`); return { done: true, value: r }; }
      return { done: false, hint: r.error || `status ${r.status}` };
    },
    onTick: (n, r) => log.info(`SSL WAITING ${host} (attempt ${n}) - ${r && r.hint}`),
  });
}

/** Ask cPanel whether AutoSSL already covers the host; trigger a check when it does not. */
export async function ensureAutoSSL(provider, host, { timeoutMs = 20 * 60 * 1000, intervalMs = 45000, apply = true } = {}) {
  log.check(`AutoSSL coverage for ${host}`);
  const initial = await provider.checkAutoSSL(host);
  if (initial.covered) { log.ok(`AutoSSL already covers ${host} (expires ${initial.expires || 'n/a'})`); return initial; }
  if (initial.problems.length) for (const p of initial.problems) log.warn(`AutoSSL problem for ${p.domain}: ${p.problem}`);
  if (!apply) { log.dry(`Would start an AutoSSL check for ${host}`); return initial; }
  if (!initial.inProgress) {
    await provider.startAutoSSL();
    log.info('AutoSSL check started');
  } else log.info('AutoSSL check already in progress');
  return poll({
    label: `AutoSSL certificate for ${host}`,
    timeoutMs,
    intervalMs,
    fn: async () => {
      const r = await provider.checkAutoSSL(host);
      if (r.covered) { log.ok(`AutoSSL installed for ${host}`); return { done: true, value: r }; }
      return { done: false, hint: r.problems.map((p) => p.problem).join('; ') || (r.inProgress ? 'check in progress' : 'not yet issued') };
    },
    onTick: (n, r) => log.info(`SSL WAITING ${host} (attempt ${n}) - ${r && r.hint}`),
  });
}
