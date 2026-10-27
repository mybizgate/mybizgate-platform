import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderText, buildContext, personalizeProject, scanResidue, residuePatternsFor, deriveShortName, deriveLocality, initialsOf, socialUrl, missingRequiredContent, assertNoResidue,
} from '../src/personalize.mjs';
import { resolveTemplate, discoverTemplates, templatesDir, TEMPLATE_STATUS } from '../src/templates.mjs';
import {
  newClient, normalizeInput, generateClientProject, writeProjectFiles, renderCallerWorkflow, readPlatformRef, writeLocalConfig, readLocalConfig, LOCAL_CONFIG_FILE, clientSummary,
} from '../src/provision.mjs';
import { buildSiteConfig, validateSiteConfig, parseSiteConfig, serializeSiteConfig, loadEnv, naming, validatePlatformRef, PLATFORM_RELEASE_REF, PLATFORM_VERSION } from '../src/config.mjs';
import { DEFAULT_EXCLUDES } from '../build/lib/fsutil.mjs';
import { buildWithEngine } from '../src/build.mjs';
import { qaDist } from '../src/verify.mjs';
import { MockCPanelProvider } from '../src/cpanel.mjs';
import { MockGitHubProvider } from '../src/github.mjs';
import { setQuiet } from '../src/utils.mjs';

setQuiet(true);
const PLATFORM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv({ HOME: os.tmpdir(), MYBIZGATE_GH_CONFIG_DIR: path.join(os.tmpdir(), 'gh-x') });
const REAL_TEMPLATES = templatesDir({});
const hasRealTemplate = fs.existsSync(path.join(REAL_TEMPLATES, 'pet-boarding', 'modern-01', 'index.html'));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const PAW = { name: 'Paw Haven Cat Hotel', slug: 'pawhaven-pz', template: 'pet-boarding/modern-01', domainType: 'subdomain', whatsapp: '012-345 6789', email: 'hello@pawhaven.com', address: '12 Jalan Ampang, 55100 Kuala Lumpur', instagram: '@pawhaven', facebook: 'https://facebook.com/pawhaven' };
function pawConfig(root = REAL_TEMPLATES) {
  const input = normalizeInput(PAW, env, { templatesRoot: root });
  return { input, cfg: validateSiteConfig(buildSiteConfig({ ...input, kind: 'client', env })) };
}

// A tiny tokenised template library for engine tests that do not need the real design.
function miniLibrary() {
  const root = tmp('mbg-pz-');
  const dir = path.join(root, 'pet-boarding', 'mini-01');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), [
    '<!DOCTYPE html><html><head><title>{{SEO_TITLE}}</title><meta name="description" content="{{SEO_DESCRIPTION}}"><link rel="canonical" href="{{PRODUCTION_URL}}/"></head>',
    '<body><h1>{{BUSINESS_NAME}}</h1><a href="tel:{{PHONE_TEL}}">{{PHONE}}</a> <a href="mailto:{{EMAIL}}">{{EMAIL}}</a> <p>{{ADDRESS}} · {{LOCALITY}} · {{OPENING_HOURS}}</p>',
    '{{#INSTAGRAM_URL}}<a href="{{INSTAGRAM_URL}}">IG</a>{{/INSTAGRAM_URL}}{{^INSTAGRAM_URL}}<span>no-ig</span>{{/INSTAGRAM_URL}}',
    '<script>const CONFIG={whatsapp:"{{WHATSAPP_DIGITS}}",hi:"Hi {{SHORT_NAME|js}}!"};</script></body></html>',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'template.yml'), 'name: Mini\nversion: 0.1.0\nrequired_content: [business_name, whatsapp, address]\ndefaults:\n  opening_hours: "By appointment"\n  seo_title: "{{BUSINESS_NAME}} in {{LOCALITY}}"\n  seo_description: "{{SHORT_NAME}} cares for cats in {{LOCALITY}}."\nresidue: [OldBrand, "old-brand.example"]\n');
  fs.writeFileSync(path.join(dir, 'images', 'hero.webp'), 'x');
  // A template that forgets to tokenise its brand -> residue must be caught.
  const bad = path.join(root, 'pet-boarding', 'leaky-01');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'index.html'), '<!DOCTYPE html><html><head><title>{{BUSINESS_NAME}}</title></head><body>Welcome to OldBrand. Visit old-brand.example. {{UNKNOWN_TOKEN}}</body></html>');
  fs.writeFileSync(path.join(bad, 'template.yml'), 'name: Leaky\nresidue: [OldBrand, old-brand.example]\n');
  fs.writeFileSync(path.join(bad, 'oldbrand-logo.svg'), '<svg/>');
  return root;
}
const providers = () => ({ cpanel: new MockCPanelProvider(), github: new MockGitHubProvider() });

// ---------------------------------------------------------------------------
// Platform release pinning
// ---------------------------------------------------------------------------
test('new client workflows are pinned to the current platform release, never to main', () => {
  assert.equal(PLATFORM_RELEASE_REF, `v${PLATFORM_VERSION}`);
  assert.equal(PLATFORM_RELEASE_REF, `v${JSON.parse(fs.readFileSync(path.join(PLATFORM_DIR, 'package.json'), 'utf8')).version}`);
  assert.equal(env.platformRef, PLATFORM_RELEASE_REF, 'default pin is the release of this checkout');
  const wf = renderCallerWorkflow(env);
  assert.match(wf, new RegExp(`uses: mybizgate/mybizgate-platform/\\.github/workflows/static-site-deploy\\.yml@${PLATFORM_RELEASE_REF.replace('.', '\\.')}\\n`));
  assert.match(wf, new RegExp(`platform_ref: ${PLATFORM_RELEASE_REF.replace('.', '\\.')}\\n`));
  assert.doesNotMatch(wf, /@main\b/);
  assert.doesNotMatch(wf, /\{\{PLATFORM_REF\}\}/);
  // Controlled override for upgrades / testing.
  const pinned = renderCallerWorkflow(loadEnv({ HOME: os.tmpdir(), MYBIZGATE_PLATFORM_REF: 'v9.9.9' }));
  assert.match(pinned, /static-site-deploy\.yml@v9\.9\.9\n/);
  assert.match(renderCallerWorkflow(env, 'main'), /@main\n/, 'main stays possible but is never the default');
  for (const bad of ['', 'v1', '1.2.0', 'release;rm', 'v1.2.0x', 'feature/x']) assert.throws(() => validatePlatformRef(bad), /platform_ref/, bad);
  assert.equal(validatePlatformRef('abcdef1234'), 'abcdef1234');
  // The pin is recorded in site.config.yml and read back from the workflow.
  const cfg = validateSiteConfig(buildSiteConfig({ name: 'Pin Co', slug: 'pin-co', template: 'blank', env }));
  assert.equal(cfg.platform_ref, PLATFORM_RELEASE_REF);
  assert.match(serializeSiteConfig(cfg), new RegExp(`^platform_ref: ${PLATFORM_RELEASE_REF.replace('.', '\\.')}$`, 'm'));
  const dir = tmp('mbg-pin-');
  writeProjectFiles(cfg, dir, { env });
  assert.equal(readPlatformRef(dir), PLATFORM_RELEASE_REF);
  assert.throws(() => parseSiteConfig(serializeSiteConfig({ ...cfg, platform_ref: 'nope' })), /platform_ref/);
  // Existing clients keep whatever they have: a config without platform_ref still loads.
  const legacy = parseSiteConfig(serializeSiteConfig(cfg).replace(/^platform_ref:.*\n/m, ''));
  assert.equal(legacy.platform_ref, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Local image source is never committed
// ---------------------------------------------------------------------------
test('image source folder stays in .mybizgate.local.yml, which is gitignored and excluded from builds', () => {
  const photos = tmp('mbg-photos-');
  const input = normalizeInput({ ...PAW, template: 'blank', images: photos }, env);
  assert.equal(input.local.images_source, photos);
  const cfg = validateSiteConfig(buildSiteConfig({ ...input, kind: 'client', env }));
  assert.equal(cfg.assets, undefined);
  assert.ok(!serializeSiteConfig(cfg).includes(photos));
  const dir = tmp('mbg-local-');
  writeProjectFiles(cfg, dir, { env, local: input.local });
  assert.ok(fs.existsSync(path.join(dir, LOCAL_CONFIG_FILE)));
  assert.ok(!fs.readFileSync(path.join(dir, 'site.config.yml'), 'utf8').includes(photos));
  assert.equal(readLocalConfig(dir).images_source, photos);
  assert.equal(readLocalConfig(dir).platform_version, PLATFORM_VERSION);
  const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes(LOCAL_CONFIG_FILE), '.mybizgate.local.yml must be gitignored in every generated site');
  assert.ok(fs.readFileSync(path.join(PLATFORM_DIR, 'templates', 'static-site', '.gitignore'), 'utf8').split('\n').includes(LOCAL_CONFIG_FILE));
  assert.ok(DEFAULT_EXCLUDES.includes(LOCAL_CONFIG_FILE), 'build engine never ships it');
  assert.ok(DEFAULT_EXCLUDES.includes('template.yml'));
  assert.equal(writeLocalConfig(dir, { images_source: null }), null, 'nothing to record -> no file');
  // A committed config carrying a local path is refused so it cannot reach GitHub.
  assert.throws(() => parseSiteConfig(`${serializeSiteConfig(cfg)}assets:\n  images_source: /home/someone/Downloads/x\n`), /must not be committed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Engine primitives
// ---------------------------------------------------------------------------
test('derivations: short name, locality, initials, social URLs', () => {
  assert.equal(deriveShortName('Paw Haven Cat Hotel'), 'Paw Haven');
  assert.equal(deriveShortName('Meow Manor Pet Boarding Sdn Bhd'), 'Meow Manor');
  assert.equal(deriveShortName('PetGate'), 'PetGate');
  assert.equal(deriveShortName('The Cat House'), 'The Cat');
  assert.equal(deriveLocality('12 Jalan Ampang, 55100 Kuala Lumpur'), 'Kuala Lumpur');
  assert.equal(deriveLocality('Kuala Lumpur'), 'Kuala Lumpur');
  assert.equal(deriveLocality('No. 3, Jalan SS2/24, 47300 Petaling Jaya, Selangor, Malaysia'), 'Selangor');
  assert.equal(deriveLocality(''), '');
  assert.equal(initialsOf('Paw Haven'), 'PH');
  assert.equal(initialsOf('PetGate'), 'PE');
  assert.equal(socialUrl('instagram', '@pawhaven'), 'https://www.instagram.com/pawhaven');
  assert.equal(socialUrl('tiktok', 'pawhaven'), 'https://www.tiktok.com/@pawhaven');
  assert.equal(socialUrl('facebook', 'https://facebook.com/pawhaven'), 'https://facebook.com/pawhaven');
  assert.equal(socialUrl('facebook', ''), '');
});

test('renderText escapes per context and handles conditional blocks', () => {
  const ctx = { NAME: 'Paw & "Haven" <3', EMPTY: '', URL: 'https://x.example/?a=1&b=2' };
  assert.equal(renderText('<h1>{{NAME}}</h1>', ctx).text, '<h1>Paw &amp; &quot;Haven&quot; &lt;3</h1>');
  assert.equal(renderText('var n="{{NAME|js}}";', ctx).text, 'var n="Paw & \\"Haven\\" <3";');
  assert.equal(renderText('?q={{NAME|url}}', ctx).text, `?q=${encodeURIComponent('Paw & "Haven" <3')}`);
  assert.equal(renderText('{{NAME|raw}}', ctx).text, 'Paw & "Haven" <3');
  assert.equal(renderText('a{{#URL}}<a href="{{URL}}">x</a>{{/URL}}b', ctx).text, 'a<a href="https://x.example/?a=1&amp;b=2">x</a>b');
  assert.equal(renderText('a{{#EMPTY}}gone{{/EMPTY}}b{{^EMPTY}}shown{{/EMPTY}}', ctx).text, 'abshown');
  const r = renderText('{{NAME}} {{MISSING}}', ctx);
  assert.equal(r.text, 'Paw &amp; &quot;Haven&quot; &lt;3 {{MISSING}}', 'unknown tokens are left for the residue scan');
  assert.deepEqual([...r.missing], ['MISSING']);
  assert.equal(renderText('{{lowercase}} {{ SPACED }}', ctx).text, '{{lowercase}} {{ SPACED }}', 'only UPPER_SNAKE tokens are tokens');
});

test('buildContext applies business info and template defaults (business name, contact, SEO)', () => {
  const root = miniLibrary();
  const tpl = resolveTemplate('pet-boarding/mini-01', { root });
  const cfg = validateSiteConfig(buildSiteConfig({ ...normalizeInput({ ...PAW, template: 'pet-boarding/mini-01' }, env, { templatesRoot: root }), kind: 'client', env }));
  const ctx = buildContext(cfg, tpl);
  assert.equal(ctx.BUSINESS_NAME, 'Paw Haven Cat Hotel');
  assert.equal(ctx.SHORT_NAME, 'Paw Haven');
  assert.equal(ctx.INITIALS, 'PH');
  assert.equal(ctx.WHATSAPP, '+60123456789', 'normalised from 012-345 6789');
  assert.equal(ctx.WHATSAPP_DIGITS, '60123456789');
  assert.equal(ctx.PHONE, '+60123456789', 'phone falls back to WhatsApp');
  assert.equal(ctx.PHONE_TEL, '+60123456789');
  assert.equal(ctx.EMAIL, 'hello@pawhaven.com');
  assert.equal(ctx.ADDRESS, '12 Jalan Ampang, 55100 Kuala Lumpur');
  assert.equal(ctx.LOCALITY, 'Kuala Lumpur');
  assert.equal(ctx.OPENING_HOURS, 'By appointment', 'template default');
  assert.equal(ctx.SEO_TITLE, 'Paw Haven Cat Hotel in Kuala Lumpur', 'template default with tokens resolved');
  assert.equal(ctx.SEO_DESCRIPTION, 'Paw Haven cares for cats in Kuala Lumpur.');
  assert.equal(ctx.PRODUCTION_URL, 'https://pawhaven-pz.mybizgate.com');
  assert.equal(ctx.INSTAGRAM_URL, 'https://www.instagram.com/pawhaven');
  assert.equal(ctx.FACEBOOK_URL, 'https://facebook.com/pawhaven');
  assert.equal(ctx.TIKTOK_URL, '');
  assert.equal(ctx.SOCIAL_JSON, '"https://facebook.com/pawhaven","https://www.instagram.com/pawhaven"');
  assert.match(ctx.MAPS_URL, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=12%20Jalan%20Ampang/);
  // Explicit values win over derivations and defaults.
  const custom = buildContext({ ...cfg, business: { ...cfg.business, short_name: 'PH Cats', locality: 'Ampang', seo_title: 'Custom title', opening_hours: '9-6', phone: '03-2161 0000' } }, tpl);
  assert.equal(custom.SHORT_NAME, 'PH Cats');
  assert.equal(custom.LOCALITY, 'Ampang');
  assert.equal(custom.SEO_TITLE, 'Custom title');
  assert.equal(custom.OPENING_HOURS, '9-6');
  assert.equal(custom.PHONE, '03-2161 0000');
  assert.equal(custom.PHONE_TEL, '+60321610000');
  assert.deepEqual(missingRequiredContent(tpl, { client: { name: 'X' }, business: {} }), ['whatsapp', 'address']);
  assert.deepEqual(missingRequiredContent(tpl, cfg), []);
});

test('personalizeProject substitutes every token in a generated project (mini template)', () => {
  const root = miniLibrary();
  const input = normalizeInput({ ...PAW, template: 'pet-boarding/mini-01' }, env, { templatesRoot: root });
  const cfg = validateSiteConfig(buildSiteConfig({ ...input, kind: 'client', env }));
  const out = tmp('mbg-gen-');
  const g = generateClientProject(cfg, out, { template: input.templateRecord, env });
  assert.equal(g.files, 2);
  assert.deepEqual(g.personalized.files, ['index.html']);
  assert.deepEqual(g.personalized.missing, []);
  assert.ok(g.residue.ok, JSON.stringify(g.residue.findings));
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<title>Paw Haven Cat Hotel in Kuala Lumpur<\/title>/);
  assert.match(html, /<h1>Paw Haven Cat Hotel<\/h1>/);
  assert.match(html, /href="tel:\+60123456789">\+60123456789</);
  assert.match(html, /href="mailto:hello@pawhaven\.com">hello@pawhaven\.com</);
  assert.match(html, /12 Jalan Ampang, 55100 Kuala Lumpur · Kuala Lumpur · By appointment/);
  assert.match(html, /<a href="https:\/\/www\.instagram\.com\/pawhaven">IG<\/a>/);
  assert.doesNotMatch(html, /no-ig/);
  assert.match(html, /whatsapp:"60123456789",hi:"Hi Paw Haven!"/);
  assert.match(html, /rel="canonical" href="https:\/\/pawhaven-pz\.mybizgate\.com\/"/);
  assert.doesNotMatch(html, /\{\{/);
  assert.equal(fs.existsSync(path.join(out, 'template.yml')), false);
  assert.equal(readPlatformRef(out), PLATFORM_RELEASE_REF);
  fs.rmSync(out, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Residue detection
// ---------------------------------------------------------------------------
test('residue scan reports leftover branding, unfilled tokens and file names with file:line detail', () => {
  const root = miniLibrary();
  const leaky = resolveTemplate('pet-boarding/leaky-01', { root });
  assert.deepEqual(residuePatternsFor(leaky), ['OldBrand', 'old-brand.example']);
  const input = normalizeInput({ ...PAW, template: 'pet-boarding/leaky-01' }, env, { templatesRoot: root });
  const cfg = validateSiteConfig(buildSiteConfig({ ...input, kind: 'client', env }));
  const out = tmp('mbg-leak-');
  const g = generateClientProject(cfg, out, { template: leaky, env });
  assert.equal(g.residue.ok, false);
  const matches = g.residue.findings.map((f) => `${f.file}:${f.match}`);
  assert.ok(matches.includes('index.html:OldBrand'), matches.join(','));
  assert.ok(matches.includes('index.html:old-brand.example'));
  assert.ok(matches.includes('index.html:{{UNKNOWN_TOKEN}}'));
  assert.ok(matches.includes('oldbrand-logo.svg:oldbrand-logo.svg'), 'file names are scanned too');
  assert.ok(g.residue.findings.every((f) => f.file !== 'index.html' || f.line >= 1));
  assert.throws(() => assertNoResidue(out, leaky), (err) => err.code === 'TEMPLATE_RESIDUE' && /Template personalisation incomplete\nindex\.html:1: OldBrand/.test(err.message));
  // Legacy demo copies are residue by definition (the demo name is the brand).
  assert.deepEqual(residuePatternsFor(resolveTemplate('petgate')), ['petgate']);
  assert.ok(scanResidue(out, { patterns: [] }).findings.some((f) => f.pattern === 'unfilled token'), 'unfilled tokens are always residue');
  fs.rmSync(out, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Local QA before provisioning
// ---------------------------------------------------------------------------
test('apply stops at the local residue check before any GitHub/cPanel call and leaves no partial client folder', async () => {
  const root = miniLibrary();
  const slug = 'leaky-apply-pz';
  const { cpanel, github } = providers();
  await assert.rejects(
    newClient({ ...PAW, slug, template: 'pet-boarding/leaky-01' }, { env, cpanel, github, apply: true, yes: true, templatesRoot: root }),
    (err) => err.code === 'TEMPLATE_RESIDUE' && /index\.html:1: OldBrand/.test(err.message),
  );
  assert.deepEqual(cpanel.state.calls, [], 'no hosting resources');
  assert.deepEqual(github.state.calls, [], 'no GitHub resources');
  assert.equal(fs.existsSync(naming.clientDir(slug)), false, 'no local client folder left behind');
  // Dry run reports the same problem without creating anything.
  const r = await newClient({ ...PAW, slug, template: 'pet-boarding/leaky-01' }, { env, cpanel, github, apply: false, templatesRoot: root });
  assert.equal(r.dryRun, true);
  assert.equal(r.residueBlocked, true);
  assert.equal(r.preflight.residue.ok, false);
});

test('apply stops when the template requires content that was not supplied', async () => {
  const root = miniLibrary();
  const { cpanel, github } = providers();
  await assert.rejects(newClient({ name: 'No Contact Co', slug: 'nocontact-pz', template: 'pet-boarding/mini-01' }, { env, cpanel, github, apply: true, yes: true, templatesRoot: root }), (err) => err.code === 'TEMPLATE_CONTENT_MISSING' && /whatsapp, address/.test(err.message));
  assert.deepEqual(github.state.calls, []);
  const r = await newClient({ name: 'No Contact Co', slug: 'nocontact-pz', template: 'pet-boarding/mini-01' }, { env, cpanel, github, apply: false, templatesRoot: root });
  assert.equal(r.contentBlocked, true);
});

test('dry run preflight passes for a well-personalised template and reports the pin in the summary', async () => {
  const root = miniLibrary();
  const { cpanel, github } = providers();
  const r = await newClient({ ...PAW, template: 'pet-boarding/mini-01' }, { env, cpanel, github, apply: false, templatesRoot: root });
  assert.equal(r.dryRun, true);
  assert.equal(r.residueBlocked, false);
  assert.equal(r.preflight.residue.ok, true);
  assert.ok(r.preflight.tokens.includes('BUSINESS_NAME'));
  assert.deepEqual(cpanel.state.calls, []);
  assert.deepEqual(github.state.calls, []);
  assert.equal(fs.existsSync(naming.clientDir(PAW.slug)), false);
  const summary = clientSummary(r.cfg, env, { template: r.template });
  assert.match(summary, new RegExp(`Platform Ref     : ${PLATFORM_RELEASE_REF.replace('.', '\\.')}\\n`));
});

test('placeholder templates are still blocked from Apply while being dry-runnable', async () => {
  const root = REAL_TEMPLATES;
  if (!fs.existsSync(path.join(root, 'pet-boarding', 'premium-01'))) return;
  const { cpanel, github } = providers();
  const r = await newClient({ ...PAW, slug: 'ph-premium-pz', template: 'pet-boarding/premium-01' }, { env, cpanel, github, apply: false, templatesRoot: root });
  assert.equal(r.templateBlocked, true);
  await assert.rejects(newClient({ ...PAW, slug: 'ph-premium-pz', template: 'pet-boarding/premium-01' }, { env, cpanel, github, apply: true, yes: true, templatesRoot: root }), (err) => err.code === 'TEMPLATE_PLACEHOLDER');
  assert.deepEqual(github.state.calls, []);
  assert.equal(fs.existsSync(naming.clientDir('ph-premium-pz')), false);
});

// ---------------------------------------------------------------------------
// The real template: pet-boarding/modern-01
// ---------------------------------------------------------------------------
test('Pet Boarding Modern 01 is discovered as the only ready template with its metadata', () => {
  if (!hasRealTemplate) return;
  const list = discoverTemplates('pet-boarding', { root: REAL_TEMPLATES });
  const ready = list.filter((t) => t.usable);
  assert.deepEqual(ready.map((t) => t.ref), ['pet-boarding/modern-01']);
  assert.ok(list.filter((t) => t.status === TEMPLATE_STATUS.PLACEHOLDER).length >= 2, 'the other pet-boarding templates stay placeholders');
  const t = resolveTemplate('pet-boarding/modern-01', { root: REAL_TEMPLATES });
  assert.equal(t.name, 'Modern Pet Boarding');
  assert.equal(t.version, '1.0.0');
  assert.equal(t.metadata.id, 'pet-boarding-modern-01');
  assert.equal(t.metadata.category, 'pet-boarding');
  assert.match(t.description, /pet boarding, cat hotel and pet daycare/);
  assert.deepEqual(t.metadata.required_content, ['business_name', 'whatsapp', 'address']);
  for (const f of ['booking', 'whatsapp', 'gallery', 'services', 'pricing']) assert.equal(t.metadata.features[f], 'true', f);
  assert.ok(t.metadata.residue.includes('PetGate'));
  assert.ok(t.metadata.defaults.seo_title.includes('{{BUSINESS_NAME}}'));
  assert.deepEqual(t.warnings, []);
  assert.ok(t.files >= 30, `template ships its images (${t.files} files)`);
  // Every other library template remains a placeholder.
  for (const cat of ['beauty', 'dental', 'automotive', 'supplier', 'general-business']) for (const x of discoverTemplates(cat, { root: REAL_TEMPLATES })) assert.equal(x.status, TEMPLATE_STATUS.PLACEHOLDER, x.ref);
});

test('the template source itself carries no PetGate identity, only tokens', () => {
  if (!hasRealTemplate) return;
  const dir = path.join(REAL_TEMPLATES, 'pet-boarding', 'modern-01');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  for (const bad of [/petgate/i, /kampung pandan/i, /sales@mybizgate\.com/i, /601158121239/, /5812 1239/, /3\.144827966176431/, /deploy-marker/]) assert.doesNotMatch(html, bad);
  for (const token of ['{{BUSINESS_NAME}}', '{{SHORT_NAME}}', '{{WHATSAPP}}', '{{EMAIL}}', '{{PHONE}}', '{{ADDRESS}}', '{{OPENING_HOURS}}', '{{SEO_TITLE}}', '{{SEO_DESCRIPTION}}', '{{FACEBOOK_URL}}', '{{INSTAGRAM_URL}}', '{{TIKTOK_URL}}']) assert.ok(html.includes(token), token);
  // Design sections preserved from the demo.
  for (const id of ['id="services"', 'id="suites"', 'id="gallery"', 'id="feeding"', 'id="rest"', 'id="book"', 'id="bookForm"', 'class="wa-link"', 'id="heroMedia"', 'class="rv', 'prefers-reduced-motion', 'application/ld+json', 'rel="canonical"']) assert.ok(html.includes(id), id);
  // template.yml names the origin and the residue strings themselves; it is never copied to clients.
  const r = scanResidue(dir, { patterns: resolveTemplate('pet-boarding/modern-01', { root: REAL_TEMPLATES }).metadata.residue, ignore: ['template.yml', 'README.md'] });
  assert.deepEqual(r.findings.filter((f) => f.pattern !== 'unfilled token'), [], 'no branding residue in the template itself');
});

test('Paw Haven generated from Modern 01 is fully personalised, residue-free and passes the production build + QA', async () => {
  if (!hasRealTemplate) return;
  const { input, cfg } = pawConfig();
  const out = tmp('mbg-paw-');
  const g = generateClientProject(cfg, out, { template: input.templateRecord, env });
  assert.ok(g.residue.ok, JSON.stringify(g.residue.findings));
  assert.deepEqual(g.personalized.missing, []);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<title>Paw Haven Cat Hotel · Cat Boarding, Grooming &amp; Daycare in Kuala Lumpur<\/title>/);
  assert.match(html, /<h1>Paw Haven Cat Hotel, <em>/);
  assert.match(html, /<meta name="description" content="Paw Haven Cat Hotel is a boutique cat-care stay in Kuala Lumpur/);
  assert.match(html, /<meta property="og:title" content="Paw Haven Cat Hotel · /);
  assert.match(html, /<link rel="canonical" href="https:\/\/pawhaven-pz\.mybizgate\.com\/">/);
  assert.match(html, /"@type":"LocalBusiness","name":"Paw Haven Cat Hotel"/);
  assert.match(html, /whatsapp: "60123456789"/);
  assert.match(html, /data-msg="Hi Paw Haven! I'd like to make a booking\."/);
  assert.match(html, /href="tel:\+60123456789"/);
  assert.match(html, /href="mailto:hello@pawhaven\.com"/);
  assert.match(html, /<span>12 Jalan Ampang, 55100 Kuala Lumpur<\/span>/);
  assert.match(html, /aria-label="Instagram"/);
  assert.doesNotMatch(html, /aria-label="TikTok"/, 'unsupplied socials are omitted');
  assert.match(html, /"sameAs":\["https:\/\/facebook\.com\/pawhaven","https:\/\/www\.instagram\.com\/pawhaven"\]/);
  assert.doesNotMatch(html, /petgate/i);
  assert.doesNotMatch(html, /\{\{/);
  assert.equal(readPlatformRef(out), PLATFORM_RELEASE_REF);
  assert.ok(fs.existsSync(path.join(out, 'images', 'hero-lounge.webp')));
  assert.equal(fs.existsSync(path.join(out, 'template.yml')), false);
  // Local production build and QA on the generated project (the same gate the apply flow uses).
  await buildWithEngine(out, { version: 'test', quiet: true });
  const qa = await qaDist(path.join(out, 'dist'));
  assert.ok(qa.ok, qa.errors.join('; '));
  const built = fs.readFileSync(path.join(out, 'dist', 'index.html'), 'utf8');
  assert.match(built, /Paw Haven Cat Hotel/);
  assert.doesNotMatch(built, /petgate/i);
  assert.equal(fs.existsSync(path.join(out, 'dist', 'site.config.yml')), false);
  fs.rmSync(out, { recursive: true, force: true });
});
