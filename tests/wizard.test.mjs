import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { wizard, confirm, newClient, normalizeInput, clientSummary, suggestSlug, WIZARD_TITLE } from '../src/provision.mjs';
import { createScriptedIo } from '../src/prompt.mjs';
import { MockCPanelProvider } from '../src/cpanel.mjs';
import { MockGitHubProvider } from '../src/github.mjs';
import { loadEnv, naming, parseSiteConfig, serializeSiteConfig, normalizeWhatsapp, normalizeBusinessInfo, validateEmail } from '../src/config.mjs';
import { TEMPLATES_DIR_ENV_VAR } from '../src/templates.mjs';
import { DOTENV_ENV_VAR } from '../src/dotenv.mjs';
import { setQuiet } from '../src/utils.mjs';

setQuiet(true);
const execFileAsync = promisify(execFile);
const PLATFORM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv({ HOME: os.tmpdir(), MYBIZGATE_GH_CONFIG_DIR: path.join(os.tmpdir(), 'gh-x') });

function fakeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-wiz-'));
  for (const rel of ['pet-boarding/modern-01', 'pet-boarding/premium-01', 'pet-boarding/playful-01', 'beauty/elegant-01', 'general-business/corporate-01', 'supplier/catalogue-01']) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, '.gitkeep'), '');
  }
  const ready = path.join(root, 'dental', 'clean-01');
  fs.mkdirSync(path.join(ready, 'images'), { recursive: true });
  fs.writeFileSync(path.join(ready, 'index.html'), '<!DOCTYPE html><html><head><title>Clean</title></head><body><h1>Clean</h1></body></html>');
  fs.writeFileSync(path.join(ready, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(ready, 'template.yml'), 'name: Clean Dental\nversion: 1.2.0\n');
  fs.mkdirSync(path.join(root, 'automotive'));
  return root;
}
const providers = () => ({ cpanel: new MockCPanelProvider(), github: new MockGitHubProvider() });
function cleanEnv(extra = {}) {
  const base = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[k]) base[k] = process.env[k];
  return { ...base, [DOTENV_ENV_VAR]: '0', ...extra };
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------
test('wizard: header, dynamic menus, slug suggestion, placeholder warning, dry-run default', async () => {
  const root = fakeLibrary();
  const io = createScriptedIo([
    '',                     // project type -> default [1] Client Website
    'Paw Haven Cat Hotel', // Business Name
    'pawhaven',            // Client slug (suggestion shown first)
    '',                    // Short name -> derived "Paw Haven"
    '5',                   // business type: automotive(1, empty) beauty(2) dental(3) general-business(4) pet-boarding(5) supplier(6)
    '1',                   // template: Modern 01
    '',                    // domain type -> default [1] subdomain
    '+60123456789', 'hello@pawhaven.com', 'Kuala Lumpur', // required business info
    '',                    // locality -> derived "Kuala Lumpur"
    '', '', '', '', '',    // phone, opening hours, facebook, instagram, tiktok
    '',                    // images folder
    '',                    // mode -> default [1] Dry Run
  ]);
  const out = await wizard({}, env, { io, templatesRoot: root });
  const text = io.text;
  assert.match(text, /={56}\n {8}MyBizgate - Multi Tenancy SaaS Wizard\n={56}\n/);
  assert.equal(WIZARD_TITLE, 'MyBizgate - Multi Tenancy SaaS Wizard');
  assert.match(text, /Project Type\n\n\[1\] Client Website\n\[2\] Demo Website\n\nCreate as \[1\]:\n> \n/);
  assert.match(text, /Client Information\n\nBusiness Name:\n> Paw Haven Cat Hotel\n/);
  assert.match(text, /Suggested slug:\npaw-haven-cat-hotel\n/);
  assert.match(text, /Available Business Types\n\n\[1\] Automotive\n\[2\] Beauty\n\[3\] Dental\n\[4\] General Business\n\[5\] Pet Boarding\n\[6\] Supplier\n\nSelect business type:\n> 5\n/);
  assert.match(text, /Pet Boarding Templates\n\n\[1\] Modern 01\n\[2\] Playful 01\n\[3\] Premium 01\n\nSelect template:\n> 1\n/);
  assert.match(text, /\[WARN\] Template pet-boarding\/modern-01 currently contains no website source files\./);
  assert.match(text, /Domain Type\n\n\[1\] MyBizGate Subdomain\n\[2\] Client Custom Domain\n\nSelect \[1\]:\n> \n/);
  assert.match(text, /Domain: pawhaven\.mybizgate\.com/);
  assert.match(text, /Business Information\n\nWhatsApp:\n> \+60123456789\n/);
  assert.match(text, /Client images folder \(optional, e\.g\. [^)]*\):\n> \n\n\[INFO\] No client image folder supplied\./);
  assert.match(text, /Mode\n\n\[1\] Dry Run\n\[2\] Apply \/ Provision\n\nSelect \[1\]:\n> \n/);
  assert.equal(out.name, 'Paw Haven Cat Hotel');
  assert.equal(out.projectType, 'client');
  assert.equal(out.slug, 'pawhaven');
  assert.equal(out.template, 'pet-boarding/modern-01', 'internal reference is the path, not the display name');
  assert.equal(out.businessType, 'Pet Boarding');
  assert.equal(out.domainType, 'subdomain');
  assert.equal(out.whatsapp, '+60123456789');
  assert.equal(out.shortName, 'Paw Haven', 'short name derived from the business name');
  assert.equal(out.locality, 'Kuala Lumpur');
  assert.equal(out.apply, false, 'dry run is the default mode');
  assert.equal(io.queue.length, 0, 'every scripted answer was consumed');
});

test('wizard: invalid slug, invalid selections and invalid contact details are re-asked; Apply mode can be chosen', async () => {
  const root = fakeLibrary();
  const io = createScriptedIo([
    'client',
    'Dr Smile Dental',
    'Bad Slug', 'paw_haven', 'drsmile',   // two invalid slugs then a valid one
    'Dr Smile',                           // short name
    '9', 'x', 'dental',                   // invalid numbers then the category id
    '0', '1',                             // invalid template selection then Clean Dental
    '1',
    'abc', '012-345 6789',                // invalid WhatsApp then a local form (normalised)
    'nope', 'hello@drsmile.my',
    'Jalan Ampang, KL',
    'Ampang',                             // locality
    '', '', '', '', '',
    '',
    '2',                                  // Apply / Provision
  ]);
  const out = await wizard({}, env, { io, templatesRoot: root });
  const text = io.text;
  assert.match(text, /\[FAIL\] Invalid slug "Bad Slug"/);
  assert.match(text, /\[FAIL\] Invalid slug "paw_haven"/);
  assert.match(text, /\[FAIL\] Invalid selection "9"\. Enter a number between 1 and 6\./);
  assert.match(text, /\[FAIL\] Invalid selection "x"/);
  assert.match(text, /Dental Templates\n\n\[1\] Clean Dental\n/, 'template.yml name is used for display');
  assert.match(text, /\[FAIL\] Invalid selection "0"\. Enter a number between 1 and 1\./);
  assert.match(text, /\[ OK \] Template dental\/clean-01: ready, 2 source file\(s\), v1\.2\.0/);
  assert.match(text, /\[FAIL\] WhatsApp number "abc" is not valid/);
  assert.match(text, /\[INFO\] WhatsApp "012-345 6789" normalised to \+60123456789 \(interpreted as a Malaysian number \(\+60\)\)/);
  assert.match(text, /\[FAIL\] Email "nope" is not a valid address/);
  assert.equal(out.slug, 'drsmile');
  assert.equal(out.template, 'dental/clean-01');
  assert.equal(out.whatsapp, '+60123456789');
  assert.equal(out.shortName, 'Dr Smile');
  assert.equal(out.locality, 'Ampang');
  assert.equal(out.apply, true);
});

test('wizard: custom domain flow keeps the DNS mode question and staging host', async () => {
  const root = fakeLibrary();
  const io = createScriptedIo(['', 'Paw Haven', 'pawhaven', '', '5', '2', '2', 'pawhaven.com.my', '', '+60123456789', 'a@b.my', 'KL', '', '', '', '', '', '', '', '']);
  const out = await wizard({}, env, { io, templatesRoot: root });
  assert.match(io.text, /Custom domain \(e\.g\. pawhaven\.com\.my\):\n> pawhaven\.com\.my\n/);
  assert.match(io.text, /DNS Mode\n\n\[1\] External DNS/);
  assert.match(io.text, /Domain: pawhaven\.com\.my \(staging: stg-pawhaven\.mybizgate\.com, dns_mode=external\)/);
  assert.equal(out.domainType, 'custom');
  assert.equal(out.domain, 'pawhaven.com.my');
  assert.equal(out.dnsMode, 'external');
  assert.equal(out.template, 'pet-boarding/playful-01');
});

test('wizard: an empty business type is reported and re-asked; an empty library fails with guidance', async () => {
  const root = fakeLibrary();
  const io = createScriptedIo(['', 'Auto Co', 'autoco', '', '1', '5', '2', '1', '+60123456789', 'a@b.my', 'KL', '', '', '', '', '', '', '', '']);
  const out = await wizard({}, env, { io, templatesRoot: root });
  assert.match(io.text, /\[WARN\] No templates found under .*automotive\/\. Choose another business type\./);
  assert.equal(out.template, 'pet-boarding/playful-01');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-empty-'));
  await assert.rejects(wizard({}, env, { io: createScriptedIo(['', 'X Co', 'xco', '']), templatesRoot: empty }), /No business types found/);
});

test('wizard: values given on the command line are not asked again and --apply skips the mode question', async () => {
  const root = fakeLibrary();
  const io = createScriptedIo(['', '+60123456789', 'a@b.my', 'KL', '', '', '', '', '', '', '']);
  const out = await wizard({ name: 'Given Co', slug: 'givenco', projectType: 'client', template: 'pet-boarding/modern-01', domainType: 'subdomain', apply: true }, env, { io, templatesRoot: root });
  assert.doesNotMatch(io.text, /Available Business Types/);
  assert.match(io.text, /\[INFO\] Mode: Apply \/ Provision \(--apply given on the command line\)/);
  assert.equal(out.apply, true);
  assert.equal(out.businessType, 'Pet Boarding');
});

test('wizard: demo selection uses demo identity and skips custom-domain choices', async () => {
  const root = fakeLibrary();
  const io = createScriptedIo([
    '2', 'Showcase Dental', 'showcase-dental', '', '3', '1',
    '+60123456789', 'demo@example.my', 'Kuala Lumpur', '', '', '', '', '', '', '', '',
  ]);
  const out = await wizard({}, env, { io, templatesRoot: root });
  assert.match(io.text, /\[2\] Demo Website/);
  assert.match(io.text, /Demo Information/);
  assert.match(io.text, /Demo slug/);
  assert.match(io.text, /Demo Domain: showcase-dental\.mybizgate\.com/);
  assert.doesNotMatch(io.text, /Domain Type\n/);
  assert.equal(out.projectType, 'demo');
  assert.equal(out.domainType, 'subdomain');
});

test('slug suggestion is kebab-case and within limits', () => {
  assert.equal(suggestSlug('Paw Haven Cat Hotel'), 'paw-haven-cat-hotel');
  assert.equal(suggestSlug('  Dr. Smile & Co!  '), 'dr-smile-co');
  assert.ok(suggestSlug('x'.repeat(100)).length <= 40);
});

// ---------------------------------------------------------------------------
// Confirmation defaults to No
// ---------------------------------------------------------------------------
test('final confirmation defaults to No and only y/Y/yes proceed', async () => {
  for (const [answer, expected] of [['', false], ['n', false], ['N', false], ['no', false], ['maybe', false], ['y', true], ['Y', true], ['yes', true], ['YES', true]]) {
    const io = createScriptedIo([answer]);
    assert.equal(await confirm('Proceed with provisioning?', { io }), expected, `answer ${JSON.stringify(answer)}`);
    assert.match(io.text, /Proceed with provisioning\? \[y\/N\]: /);
  }
  if (!process.stdin.isTTY) assert.equal(await confirm('Proceed?'), false, 'no terminal means no');
});

test('apply mode with a usable template stops at the confirmation when the user just presses Enter', async () => {
  const root = fakeLibrary();
  const { cpanel, github } = providers();
  const io = createScriptedIo(['']);
  const slug = 'confirm-default-zz';
  const r = await newClient({ name: 'Confirm Co', slug, template: 'dental/clean-01', whatsapp: '+60123456789', email: 'a@b.my', address: 'KL' }, { env, cpanel, github, apply: true, io, templatesRoot: root });
  assert.equal(r.aborted, true);
  assert.match(io.text, /Proceed with provisioning\? \[y\/N\]: \n/);
  assert.deepEqual(cpanel.state.calls, []);
  assert.deepEqual(github.state.calls, []);
  assert.equal(fs.existsSync(naming.clientDir(slug)), false, 'nothing is created before confirmation');
});

// ---------------------------------------------------------------------------
// Placeholder templates and dry run
// ---------------------------------------------------------------------------
test('dry run works with a placeholder template and apply stops before creating anything', async () => {
  const root = fakeLibrary();
  const slug = 'placeholder-zz';
  {
    const { cpanel, github } = providers();
    const r = await newClient({ name: 'Placeholder Co', slug, template: 'pet-boarding/modern-01' }, { env, cpanel, github, apply: false, templatesRoot: root });
    assert.equal(r.dryRun, true);
    assert.equal(r.templateBlocked, true);
    assert.equal(r.cfg.template.id, 'pet-boarding/modern-01');
    assert.deepEqual(cpanel.state.calls, []);
    assert.deepEqual(github.state.calls, []);
  }
  {
    const { cpanel, github } = providers();
    await assert.rejects(
      newClient({ name: 'Placeholder Co', slug, template: 'pet-boarding/modern-01' }, { env, cpanel, github, apply: true, yes: true, templatesRoot: root }),
      (err) => err.code === 'TEMPLATE_PLACEHOLDER' && /placeholder template/.test(err.message) && /cannot be generated until the template is populated/.test(err.message),
    );
    assert.deepEqual(cpanel.state.calls, [], 'no hosting resources');
    assert.deepEqual(github.state.calls, [], 'no GitHub resources');
    assert.equal(fs.existsSync(naming.clientDir(slug)), false, 'no local project');
  }
});

// ---------------------------------------------------------------------------
// Generated client configuration
// ---------------------------------------------------------------------------
test('generated client configuration records template id/version, business info and platform ref; image source stays local', async () => {
  const root = fakeLibrary();
  const photos = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-photos-'));
  fs.writeFileSync(path.join(photos, 'a.jpg'), ''); fs.writeFileSync(path.join(photos, 'b.PNG'), ''); fs.writeFileSync(path.join(photos, 'notes.txt'), '');
  const raw = {
    name: 'Dr Smile Dental', slug: 'drsmile-zz', template: 'dental/clean-01', domainType: 'subdomain',
    whatsapp: '60123456789', email: 'hello@drsmile.my', address: '12 Jalan Ampang,   Kuala Lumpur', phone: '03-2161 0000', openingHours: 'Mon-Sat 9am-6pm',
    facebook: 'https://facebook.com/drsmile', instagram: '@drsmile', images: photos,
  };
  const input = normalizeInput(raw, env, { templatesRoot: root });
  assert.equal(input.templateVersion, '1.2.0');
  assert.equal(input.businessType, 'Dental');
  assert.deepEqual(input.businessNotes, ['WhatsApp "60123456789" normalised to +60123456789']);
  assert.equal(input.images.images, 2);
  const { cpanel, github } = providers();
  const r = await newClient(raw, { env, cpanel, github, apply: false, templatesRoot: root });
  const cfg = r.cfg;
  assert.deepEqual(cfg.client, { name: 'Dr Smile Dental', slug: 'drsmile-zz' });
  assert.deepEqual(cfg.template, { id: 'dental/clean-01', version: '1.2.0' });
  assert.deepEqual(cfg.domain, { type: 'subdomain', primary: 'drsmile-zz.mybizgate.com' });
  assert.deepEqual(cfg.business, { whatsapp: '+60123456789', email: 'hello@drsmile.my', address: '12 Jalan Ampang, Kuala Lumpur', phone: '03-2161 0000', opening_hours: 'Mon-Sat 9am-6pm', facebook: 'https://facebook.com/drsmile', instagram: '@drsmile' });
  assert.deepEqual(cfg.hosting, { deploy_dir: 'public_html/clients/drsmile-zz/', ftp_account: 'dedicated' });
  assert.equal(cfg.site.kind, 'client');
  assert.equal(cfg.site.environment, 'production');
  assert.equal(cfg.site.production_url, 'https://drsmile-zz.mybizgate.com');
  assert.equal(cfg.assets, undefined, 'local image paths are never part of the committed config');
  assert.equal(cfg.platform_ref, env.platformRef);
  assert.equal(input.local.images_source, photos);
  const text = serializeSiteConfig(cfg);
  assert.match(text, /template:\n  id: dental\/clean-01\n  version: 1\.2\.0\n/);
  assert.match(text, /business:\n  whatsapp: '\+60123456789'\n  email: hello@drsmile\.my\n  address: 12 Jalan Ampang, Kuala Lumpur\n/);
  assert.doesNotMatch(text, /password|token/i);
  assert.ok(!text.includes(photos), 'serialised config must not contain the local path');
  // Round trip through the parser used by CI.
  const parsed = parseSiteConfig(text);
  assert.deepEqual(parsed.template, { id: 'dental/clean-01', version: '1.2.0' });
  assert.equal(parsed.business.whatsapp, '+60123456789');
  const summary = clientSummary(cfg, env, { template: input.templateRecord, businessType: input.businessType, images: input.images });
  assert.match(summary, /NEW CLIENT SUMMARY/);
  assert.match(summary, /Business Type    : Dental\n/);
  assert.match(summary, /Template         : dental\/clean-01 \(v1\.2\.0\)\n/);
  assert.match(summary, /GitHub Repo      : mybizgate\/client-drsmile-zz\n/);
  assert.match(summary, /Hosting Directory: public_html\/clients\/drsmile-zz\/\n/);
  assert.match(summary, /Mode             : Dry Run\n/);
});

test('placeholder templates record version null; legacy template.type configs still load', () => {
  const root = fakeLibrary();
  const input = normalizeInput({ name: 'P', slug: 'p-zz', template: 'pet-boarding/premium-01' }, env, { templatesRoot: root });
  assert.equal(input.templateVersion, null);
  assert.deepEqual(input.business, {});
  const legacy = parseSiteConfig('client:\n  name: Paw Haven Cat Hotel\n  slug: pawhaven\ntemplate:\n  type: petgate\ndomain:\n  type: subdomain\n  primary: pawhaven.mybizgate.com\nhosting:\n  deploy_dir: public_html/clients/pawhaven/\n  ftp_account: dedicated\nsite:\n  kind: client\n');
  assert.equal(legacy.template.id, 'petgate');
  assert.equal(legacy.template.type, 'petgate');
  assert.equal(legacy.template.version, null);
  assert.throws(() => parseSiteConfig('client:\n  name: X\n  slug: x\ntemplate:\n  id: ../evil\ndomain:\n  primary: x.mybizgate.com\nhosting:\n  deploy_dir: public_html/clients/x/\n'), /template\.id/);
  assert.throws(() => parseSiteConfig('client:\n  name: X\n  slug: x\ntemplate:\n  id: blank\n  version: v1\ndomain:\n  primary: x.mybizgate.com\nhosting:\n  deploy_dir: public_html/clients/x/\n'), /template\.version/);
  assert.throws(() => parseSiteConfig('client:\n  name: X\n  slug: x\ntemplate:\n  id: blank\nbusiness:\n  whatsapp: abc\ndomain:\n  primary: x.mybizgate.com\nhosting:\n  deploy_dir: public_html/clients/x/\n'), /WhatsApp/);
});

test('WhatsApp and business-info normalisation never changes values silently', () => {
  assert.deepEqual(normalizeWhatsapp('+60123456789'), { value: '+60123456789', changed: false, note: null, original: '+60123456789' });
  assert.equal(normalizeWhatsapp('012-345 6789').value, '+60123456789');
  assert.equal(normalizeWhatsapp('012-345 6789').changed, true);
  assert.equal(normalizeWhatsapp('60 12 345 6789').value, '+60123456789');
  assert.equal(normalizeWhatsapp('https://wa.me/60123456789').value, '+60123456789');
  assert.equal(normalizeWhatsapp('0060123456789').value, '+60123456789');
  assert.equal(normalizeWhatsapp('+65 9123 4567').value, '+6591234567');
  for (const bad of ['', 'abc', '123', '+0123', '+601234567890123456', '123456789012']) assert.throws(() => normalizeWhatsapp(bad), /WhatsApp/, `should reject ${JSON.stringify(bad)}`);
  assert.equal(validateEmail(' Hello@Example.com '), 'Hello@Example.com');
  assert.throws(() => validateEmail('nope@'), /Email/);
  const { business, notes } = normalizeBusinessInfo({ whatsapp: '0123456789', email: 'a@b.my', address: 'KL', tiktok: '@shop' });
  assert.equal(business.whatsapp, '+60123456789');
  assert.equal(business.tiktok, '@shop');
  assert.equal(notes.length, 1);
  assert.throws(() => normalizeBusinessInfo({}, { requireContact: true }), /WhatsApp number is required/);
  assert.deepEqual(normalizeBusinessInfo({ whatsapp: '', email: '  ' }).business, {}, 'empty optional fields are allowed in CLI mode');
  assert.throws(() => normalizeBusinessInfo({ facebook: 'has space' }), /without spaces/);
});

// ---------------------------------------------------------------------------
// CLI compatibility (subprocess)
// ---------------------------------------------------------------------------
test('CLI mode: the documented non-interactive command still works as a dry run with the template library', async () => {
  const root = fakeLibrary();
  const bin = path.join(PLATFORM_DIR, 'bin', 'new-client.sh');
  const r = await execFileAsync(bin, ['--name', 'Paw Haven Cat Hotel', '--slug', 'pawhaven-cli-zz', '--template', 'pet-boarding/modern-01', '--domain-type', 'subdomain', '--mock'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() });
  assert.match(r.stdout, /\[CHECK\] Template pet-boarding\/modern-01/);
  assert.match(r.stderr, /\[WARN\] Template pet-boarding\/modern-01 currently contains no website source files\./);
  assert.match(r.stdout, /NEW CLIENT SUMMARY/);
  assert.match(r.stdout, /Template         : pet-boarding\/modern-01\n/);
  assert.match(r.stdout, /\[PLAN\] Create clients\/client-pawhaven-cli-zz\/ from template "pet-boarding\/modern-01"/);
  assert.match(r.stdout, /id: pet-boarding\/modern-01\n  version: null/);
  assert.match(r.stderr, /Selected template is currently a placeholder template\./);
  assert.match(r.stdout, /\[DRY \] Dry run only\. Nothing was created\./);
  assert.equal(fs.existsSync(naming.clientDir('pawhaven-cli-zz')), false);
  // Legacy and built-in template names are still accepted.
  const blank = await execFileAsync(bin, ['--name', 'Blank Co', '--slug', 'blank-cli-zz', '--template', 'blank', '--domain-type', 'subdomain', '--mock'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() });
  assert.match(blank.stdout, /\[ OK \] Blank starter \(built-in\)/);
  assert.doesNotMatch(blank.stderr, /placeholder/);
  const demo = await execFileAsync(bin, ['--name', 'Demo Co', '--slug', 'demo-cli-zz', '--project-type', 'demo', '--template', 'blank', '--mock'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() });
  assert.match(demo.stdout, /NEW DEMO SUMMARY/);
  assert.match(demo.stdout, /Project Type     : Demo Website/);
  assert.match(demo.stdout, /GitHub Repo      : mybizgate\/demo-demo-cli-zz/);
  assert.match(demo.stdout, /Hosting Directory: public_html\/demo\/demo-cli-zz\//);
  assert.match(demo.stdout, /\[PLAN\] Create demo\/demo-demo-cli-zz\//);
  assert.equal(fs.existsSync(naming.demoDir('demo-cli-zz')), false);
  const legacy = await execFileAsync(bin, ['--name', 'Legacy Co', '--slug', 'legacy-cli-zz', '--template', 'petgate', '--domain-type', 'subdomain', '--mock'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() });
  assert.match(legacy.stderr, /deprecated/);
});

test('CLI mode: --apply with a placeholder template exits non-zero before creating anything; missing args and bad input are reported without stack traces', async () => {
  const root = fakeLibrary();
  const bin = path.join(PLATFORM_DIR, 'bin', 'new-client.sh');
  const slug = 'placeholder-cli-zz';
  await assert.rejects(execFileAsync(bin, ['--name', 'P Co', '--slug', slug, '--template', 'beauty/elegant-01', '--domain-type', 'subdomain', '--mock', '--apply', '--yes'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() }), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /\[FAIL\] Selected template is currently a placeholder template\.\n\[FAIL\] Website source cannot be generated until the template is populated\./);
    assert.doesNotMatch(err.stderr, /at .*\.mjs:\d+/, 'no stack trace for a validation problem');
    return true;
  });
  assert.equal(fs.existsSync(naming.clientDir(slug)), false);
  await assert.rejects(execFileAsync(bin, ['--name', 'X', '--slug', 'bad slug', '--template', 'blank', '--mock'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() }), (err) => /\[FAIL\] Invalid slug "bad slug"/.test(err.stderr) && !/at .*\.mjs:\d+/.test(err.stderr));
  await assert.rejects(execFileAsync(bin, ['--name', 'X', '--slug', 'x-zz', '--template', 'pet-boarding/nope', '--mock'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() }), (err) => /\[FAIL\] Unknown template "pet-boarding\/nope"/.test(err.stderr) && /\[INFO\] Templates for pet-boarding: pet-boarding\/modern-01/.test(err.stdout));
  await assert.rejects(execFileAsync(bin, ['--name', 'X', '--slug', 'x-zz', '--mock'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() }), (err) => /--template is required/.test(err.stderr));
  // No --name and no terminal: interactive mode cannot start, and says how to use CLI mode instead.
  await assert.rejects(execFileAsync(bin, ['--mock'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() }), (err) => /no interactive terminal/.test(err.stderr) && /--name, --slug, --template and optionally --project-type/.test(err.stdout));
});

test('CLI: "mybizgate templates" lists the library from the filesystem', async () => {
  const root = fakeLibrary();
  const r = await execFileAsync(path.join(PLATFORM_DIR, 'bin', 'mybizgate'), ['templates'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() });
  assert.match(r.stdout, /Pet Boarding \(pet-boarding\/\)\n  pet-boarding\/modern-01 +Modern 01 +placeholder, no website source yet\n/);
  assert.match(r.stdout, /dental\/clean-01 +Clean Dental +ready, 2 source file\(s\), v1\.2\.0/);
  assert.match(r.stdout, /Automotive \(automotive\/\)\n  \(no templates\)/);
  fs.mkdirSync(path.join(root, 'pet-boarding', 'luxury-02'));
  const again = await execFileAsync(path.join(PLATFORM_DIR, 'bin', 'mybizgate'), ['templates'], { env: cleanEnv({ [TEMPLATES_DIR_ENV_VAR]: root }), cwd: os.tmpdir() });
  assert.match(again.stdout, /pet-boarding\/luxury-02 +Luxury 02/);
});
