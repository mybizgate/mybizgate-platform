import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  humanize, discoverCategories, discoverTemplates, discoverAllTemplates, resolveTemplate, readTemplateMetadata, templateStatusText,
  countSourceFiles, TEMPLATE_STATUS, PLACEHOLDER_WARNING, templatesDir, TEMPLATES_DIR_ENV_VAR,
} from '../src/templates.mjs';
import { copyTemplate } from '../src/provision.mjs';

// Build a throw-away template library mirroring the workspace layout.
function fakeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-tpl-'));
  const mk = (rel, files = { '.gitkeep': '' }) => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  };
  mk('pet-boarding/modern-01');
  mk('pet-boarding/premium-01');
  mk('pet-boarding/playful-01');
  mk('beauty/elegant-01');
  mk('general-business/corporate-01');
  // A populated template with metadata.
  mk('dental/clean-01', {
    'index.html': '<!DOCTYPE html><html><head><title>Clean</title><link rel="stylesheet" href="style.css"></head><body><img src="images/hero.jpg"></body></html>',
    'style.css': 'body{margin:0}',
    'script.js': 'console.log(1)',
    'images/hero.jpg': 'jpg',
    'template.yml': 'id: dental-clean-01\nname: Clean Dental\ncategory: dental\nversion: 1.2.0\ndescription: Clean dental site.\n',
    'preview.png': 'png',
    'README.md': '# template readme',
  });
  // Files but no index.html -> incomplete.
  mk('dental/modern-01', { 'style.css': 'body{}' });
  // Bad metadata must not crash discovery.
  mk('beauty/luxury-01', { 'template.yml': 'name: [broken\n' });
  mk('beauty/modern-01', { 'template.yml': 'name: Modern Beauty\nversion: not-a-version\ncategory: dental\n' });
  // Ignored entries: hidden dirs, files at category level, uppercase names.
  fs.mkdirSync(path.join(root, '.hidden', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# templates');
  fs.mkdirSync(path.join(root, 'pet-boarding', 'Not-Valid'), { recursive: true });
  return root;
}

test('humanize turns folder names into display names', () => {
  assert.equal(humanize('pet-boarding'), 'Pet Boarding');
  assert.equal(humanize('general-business'), 'General Business');
  assert.equal(humanize('premium-01'), 'Premium 01');
  assert.equal(humanize('modern_02'), 'Modern 02');
  assert.equal(humanize(''), '');
});

test('categories are discovered from the filesystem, sorted and humanised', () => {
  const root = fakeLibrary();
  const cats = discoverCategories({ root });
  assert.deepEqual(cats.map((c) => c.id), ['beauty', 'dental', 'general-business', 'pet-boarding']);
  assert.deepEqual(cats.map((c) => c.name), ['Beauty', 'Dental', 'General Business', 'Pet Boarding']);
  assert.equal(cats.find((c) => c.id === 'pet-boarding').templateCount, 3);
  // Adding a directory later makes it appear without any code change.
  fs.mkdirSync(path.join(root, 'automotive', 'workshop-01'), { recursive: true });
  assert.ok(discoverCategories({ root }).some((c) => c.id === 'automotive'));
  assert.deepEqual(discoverCategories({ root: path.join(root, 'does-not-exist') }), []);
});

test('templates are discovered per category with stable refs and friendly names', () => {
  const root = fakeLibrary();
  const t = discoverTemplates('pet-boarding', { root });
  assert.deepEqual(t.map((x) => x.ref), ['pet-boarding/modern-01', 'pet-boarding/playful-01', 'pet-boarding/premium-01']);
  assert.deepEqual(t.map((x) => x.name), ['Modern 01', 'Playful 01', 'Premium 01']);
  assert.ok(t.every((x) => x.status === TEMPLATE_STATUS.PLACEHOLDER && x.placeholder && !x.usable && x.files === 0));
  assert.ok(t.every((x) => x.categoryName === 'Pet Boarding'));
  fs.mkdirSync(path.join(root, 'pet-boarding', 'luxury-02'));
  assert.ok(discoverTemplates('pet-boarding', { root }).some((x) => x.ref === 'pet-boarding/luxury-02'));
  assert.throws(() => discoverTemplates('nope', { root }), /Unknown business type/);
  assert.throws(() => discoverTemplates('../etc', { root }), /Invalid business type/);
  assert.equal(discoverAllTemplates({ root }).length, 10);
});

test('template.yml metadata drives the display name and version; invalid metadata degrades to the folder name', () => {
  const root = fakeLibrary();
  const clean = resolveTemplate('dental/clean-01', { root });
  assert.equal(clean.name, 'Clean Dental');
  assert.equal(clean.version, '1.2.0');
  assert.equal(clean.description, 'Clean dental site.');
  assert.equal(clean.status, TEMPLATE_STATUS.READY);
  assert.ok(clean.usable);
  assert.equal(clean.files, 4, 'preview/README/template.yml are not website source');
  assert.deepEqual(clean.warnings, []);
  assert.match(templateStatusText(clean), /ready, 4 source file\(s\), v1\.2\.0/);

  const broken = resolveTemplate('beauty/luxury-01', { root });
  assert.equal(broken.name, 'Luxury 01');
  assert.equal(broken.version, null);
  assert.ok(broken.warnings.some((w) => /could not parse/.test(w)));
  assert.equal(broken.status, TEMPLATE_STATUS.PLACEHOLDER, 'metadata only is still a placeholder');

  const badVersion = resolveTemplate('beauty/modern-01', { root });
  assert.equal(badVersion.name, 'Modern Beauty');
  assert.equal(badVersion.version, null);
  assert.ok(badVersion.warnings.some((w) => /not a valid semantic version/.test(w)));
  assert.ok(badVersion.warnings.some((w) => /category "dental" does not match/.test(w)));

  const { metadata } = readTemplateMetadata(path.join(root, 'pet-boarding', 'modern-01'));
  assert.equal(metadata, null);
});

test('placeholder and incomplete templates are reported, never crash', () => {
  const root = fakeLibrary();
  const ph = resolveTemplate('pet-boarding/modern-01', { root });
  assert.equal(ph.status, TEMPLATE_STATUS.PLACEHOLDER);
  assert.equal(PLACEHOLDER_WARNING(ph.ref), 'Template pet-boarding/modern-01 currently contains no website source files.');
  assert.match(templateStatusText(ph), /placeholder, no website source yet/);
  const inc = resolveTemplate('dental/modern-01', { root });
  assert.equal(inc.status, TEMPLATE_STATUS.INCOMPLETE);
  assert.ok(!inc.usable);
  assert.match(templateStatusText(inc), /no index\.html/);
  assert.equal(countSourceFiles(path.join(root, 'pet-boarding', 'modern-01')), 0);
  // Copying a placeholder is refused so no broken website can be produced.
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-dest-'));
  assert.throws(() => copyTemplate(ph, dest), /no website source/);
  assert.equal(fs.readdirSync(dest).length, 0);
});

test('invalid template references are rejected with actionable errors', () => {
  const root = fakeLibrary();
  assert.throws(() => resolveTemplate('pet-boarding/nope', { root }), /Unknown template "pet-boarding\/nope"/);
  try { resolveTemplate('pet-boarding/nope', { root }); } catch (err) { assert.match(err.hint, /pet-boarding\/modern-01/); assert.equal(err.code, 'INVALID_TEMPLATE'); }
  for (const bad of ['', '   ', 'wordpress', 'Pet-Boarding/modern-01', 'pet-boarding/', '/modern-01', 'pet-boarding/../x', 'a/b/c', 'pet boarding/modern 01', 'pet-boarding/modern-01;rm']) {
    assert.throws(() => resolveTemplate(bad, { root }), /template/i, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => resolveTemplate('nothing/here', { root }), /Unknown template/);
});

test('blank is a built-in usable template; legacy demo names are accepted with a deprecation warning', () => {
  const blank = resolveTemplate('blank');
  assert.ok(blank.builtin && blank.usable);
  const legacy = resolveTemplate('petgate');
  assert.ok(legacy.legacy);
  assert.ok(legacy.warnings.some((w) => /deprecated/i.test(w)));
  assert.match(legacy.name, /legacy demo source/);
});

test('copyTemplate copies website source only', () => {
  const root = fakeLibrary();
  const tpl = resolveTemplate('dental/clean-01', { root });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-dest-'));
  const count = copyTemplate(tpl, dest);
  assert.equal(count, 4);
  for (const f of ['index.html', 'style.css', 'script.js', 'images/hero.jpg']) assert.ok(fs.existsSync(path.join(dest, f)), f);
  for (const f of ['template.yml', 'preview.png', 'README.md', '.gitkeep']) assert.ok(!fs.existsSync(path.join(dest, f)), `${f} must not be copied`);
  fs.rmSync(dest, { recursive: true, force: true });
});

test('templates directory defaults to <workspace>/templates and honours the override', () => {
  assert.equal(templatesDir({}), path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'templates'));
  assert.equal(templatesDir({ [TEMPLATES_DIR_ENV_VAR]: '/tmp/x' }), '/tmp/x');
});

test('the real workspace library is discoverable and currently placeholder-only or better', () => {
  const root = templatesDir({});
  if (!fs.existsSync(root)) return; // CI checkout of the platform alone
  const cats = discoverCategories({ root });
  assert.ok(cats.length >= 1);
  for (const c of cats) for (const t of discoverTemplates(c.id, { root })) assert.ok([TEMPLATE_STATUS.READY, TEMPLATE_STATUS.PLACEHOLDER, TEMPLATE_STATUS.INCOMPLETE].includes(t.status));
});
