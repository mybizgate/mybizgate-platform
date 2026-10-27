// DNS verification helpers (uses Node's resolver; no external `dig` required).
import dns from 'node:dns/promises';
import { poll, log } from './utils.mjs';

const SECOND_LEVEL_SUFFIXES = new Set(['com.my', 'net.my', 'org.my', 'edu.my', 'gov.my', 'co.uk', 'org.uk', 'com.sg', 'com.au', 'co.id', 'co.nz', 'com.bn']);

export function registrableDomain(host) {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

export async function resolveA(host) {
  try { return await dns.resolve4(host); } catch (err) { return { error: err.code || err.message }; }
}

export async function resolveNs(domain) {
  try { return (await dns.resolveNs(domain)).map((n) => n.toLowerCase().replace(/\.$/, '')); } catch (err) { return { error: err.code || err.message }; }
}

export async function resolveCname(host) {
  try { return await dns.resolveCname(host); } catch { return []; }
}

/** Discover the hosting IP by resolving the primary MyBizGate domain. */
export async function hostingIp(baseDomain) {
  const a = await resolveA(baseDomain);
  if (Array.isArray(a) && a.length) return a[0];
  return null;
}

export function dnsState(resolved, expectedIps) {
  if (!Array.isArray(resolved) || resolved.length === 0) return 'WAITING FOR DNS';
  if (!expectedIps || expectedIps.length === 0) return 'DNS OK';
  return resolved.some((ip) => expectedIps.includes(ip)) ? 'DNS OK' : 'DNS MISMATCH';
}

export async function checkDns(host, expectedIps) {
  const resolved = await resolveA(host);
  const state = dnsState(resolved, expectedIps);
  return { host, resolved: Array.isArray(resolved) ? resolved : [], error: resolved && resolved.error, state, expectedIps };
}

export async function checkDelegation(domain, nameservers) {
  const ns = await resolveNs(registrableDomain(domain));
  const want = nameservers.map((n) => n.toLowerCase());
  const ok = Array.isArray(ns) && want.every((n) => ns.includes(n));
  return { domain, nameservers: Array.isArray(ns) ? ns : [], expected: want, state: ok ? 'DELEGATION OK' : 'WAITING FOR NAMESERVERS' };
}

export async function waitForDns(host, expectedIps, { timeoutMs = 20 * 60 * 1000, intervalMs = 30000 } = {}) {
  log.check(`DNS for ${host} (expecting ${expectedIps.join(', ') || 'any A record'})`);
  return poll({
    label: `DNS for ${host}`,
    timeoutMs,
    intervalMs,
    fn: async () => {
      const r = await checkDns(host, expectedIps);
      if (r.state === 'DNS OK') { log.ok(`DNS OK ${host} -> ${r.resolved.join(', ')}`); return { done: true, value: r }; }
      return { done: false, hint: `Current answer: ${r.resolved.join(', ') || r.error || 'none'}` };
    },
    onTick: (n, r) => log.info(`WAITING FOR DNS ${host} (attempt ${n}) ${r && r.hint ? `- ${r.hint}` : ''}`),
  });
}

export async function waitForDelegation(domain, nameservers, opts = {}) {
  const { timeoutMs = 60 * 60 * 1000, intervalMs = 60000 } = opts;
  log.check(`Nameserver delegation for ${registrableDomain(domain)} -> ${nameservers.join(', ')}`);
  return poll({
    label: `nameserver delegation for ${domain}`,
    timeoutMs,
    intervalMs,
    fn: async () => {
      const r = await checkDelegation(domain, nameservers);
      if (r.state === 'DELEGATION OK') { log.ok(`DELEGATION OK ${domain}`); return { done: true, value: r }; }
      return { done: false, hint: `Current NS: ${r.nameservers.join(', ') || 'none'}` };
    },
    onTick: (n, r) => log.info(`WAITING FOR NAMESERVERS ${domain} (attempt ${n}) ${r && r.hint ? `- ${r.hint}` : ''}`),
  });
}

export function dnsInstructions({ domain, ip, mode, nameservers, stagingHost, slug }) {
  const lines = [];
  lines.push(`MyBizGate DNS instructions for ${domain}`);
  lines.push(`Client slug: ${slug}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  if (mode === 'awedns') {
    lines.push('DNS MODE: awedns (MyBizGate hosting manages DNS once delegated)');
    lines.push('');
    lines.push('At the domain registrar, set the nameservers of the domain to:');
    for (const ns of nameservers) lines.push(`  ${ns}`);
    lines.push('');
    lines.push('Do not add any other records at the registrar. Email and other records will be');
    lines.push('managed inside MyBizGate hosting after delegation completes.');
  } else {
    lines.push('DNS MODE: external (the client keeps their current DNS provider and nameservers)');
    lines.push('');
    lines.push('Do NOT change the nameservers. Keep all existing MX, SPF, DKIM, DMARC, TXT and other records.');
    lines.push('Add or update ONLY the web records below at the current DNS provider:');
    lines.push('');
    lines.push(`  Type  Name   Value             TTL`);
    lines.push(`  A     @      ${ip.padEnd(17)} 3600`);
    lines.push(`  A     www    ${ip.padEnd(17)} 3600`);
    lines.push('');
    lines.push('If the provider does not allow an A record for "www", use:');
    lines.push(`  CNAME www    ${domain}.`);
    lines.push('');
    lines.push('If the domain is behind Cloudflare, set the proxy status for these records to');
    lines.push('"DNS only" (grey cloud) until HTTPS is verified, then it can be enabled.');
  }
  lines.push('');
  lines.push(`Expected hosting IP: ${ip}`);
  if (stagingHost) lines.push(`Staging preview (already live, not indexed): https://${stagingHost}`);
  lines.push('');
  lines.push('After the change propagates, resume provisioning with:');
  lines.push(`  ./platform/bin/mybizgate new-client --slug ${slug} --resume --apply`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
