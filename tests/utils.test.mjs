import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, registerSecret, parseArgs, randomPassword, PlatformError } from '../src/utils.mjs';
import { dnsState, registrableDomain, dnsInstructions } from '../src/dns.mjs';
import { extractCriticalAssets } from '../src/verify.mjs';

test('secret redaction removes env secrets, registered secrets and credential patterns', () => {
  const env = { CPANEL_TOKEN: 'TOKENVALUE123456', FTP_PASSWORD: 'ftpSecret!2026' };
  assert.equal(redact('token TOKENVALUE123456 and ftpSecret!2026 here', env), 'token <redacted> and <redacted> here');
  registerSecret('GeneratedPw-99');
  assert.equal(redact('pw GeneratedPw-99 end', {}), 'pw <redacted> end');
  assert.equal(redact('Authorization: cpanel mybizgat:abcdef0123', {}), 'Authorization: cpanel mybizgat:<redacted>');
  assert.equal(redact('ftps://user:pass123@host/', {}), 'ftps://user:<redacted>@host/');
  assert.match(redact('{"password":"hunter2xyz"}', {}), /<redacted>/);
  assert.match(new PlatformError('bad token TOKENVALUE123456').message, /<redacted>|TOKENVALUE123456/);
});

test('parseArgs handles flags, values and booleans', () => {
  const o = parseArgs(['--name', 'Paw Haven', '--slug=pawhaven', '--apply', 'positional', '--domain-type', 'custom', '--no-apply'], { booleans: ['apply'] });
  assert.equal(o.name, 'Paw Haven');
  assert.equal(o.slug, 'pawhaven');
  assert.equal(o.apply, false);
  assert.equal(o.domainType, 'custom');
  assert.deepEqual(o._, ['positional']);
});

test('randomPassword is long and varied', () => {
  const p = randomPassword(28);
  assert.equal(p.length, 28);
  assert.notEqual(p, randomPassword(28));
  assert.match(p, /^[A-Za-z0-9!@#%^*\-_=+]+$/);
});

test('dns helpers', () => {
  assert.equal(dnsState([], ['1.1.1.1']), 'WAITING FOR DNS');
  assert.equal(dnsState(['1.1.1.1'], ['1.1.1.1']), 'DNS OK');
  assert.equal(dnsState(['2.2.2.2'], ['1.1.1.1']), 'DNS MISMATCH');
  assert.equal(registrableDomain('www.pawhaven.com.my'), 'pawhaven.com.my');
  assert.equal(registrableDomain('shop.pawhaven.com'), 'pawhaven.com');
  const text = dnsInstructions({ domain: 'pawhaven.com.my', ip: '203.0.113.10', mode: 'external', nameservers: ['ns1.awedns.com', 'ns2.awedns.com'], stagingHost: 'stg-pawhaven.mybizgate.com', slug: 'pawhaven' });
  assert.match(text, /Do NOT change the nameservers/);
  assert.match(text, /A\s+@\s+203\.0\.113\.10/);
  assert.match(text, /--slug pawhaven --resume --apply/);
  const aw = dnsInstructions({ domain: 'pawhaven.com.my', ip: '203.0.113.10', mode: 'awedns', nameservers: ['ns1.awedns.com', 'ns2.awedns.com'], slug: 'pawhaven' });
  assert.match(aw, /ns1\.awedns\.com/);
});

test('critical asset extraction from homepage HTML', () => {
  const html = '<html><head><title>PetGate</title><meta name="build-version" content="abc12345"><link rel="stylesheet" href="style.css?v=1"><script src="script.js" defer></script></head><body><img src="images/hero.webp"><a href="https://wa.me/60123456789?text=Hi">WA</a></body></html>';
  const a = extractCriticalAssets(html);
  assert.equal(a.css, 'style.css?v=1');
  assert.equal(a.js, 'script.js');
  assert.equal(a.img, 'images/hero.webp');
  assert.equal(a.version, 'abc12345');
  assert.equal(a.title, 'PetGate');
  assert.match(a.whatsapp, /^https:\/\/wa\.me\//);
});
