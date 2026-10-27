import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rewriteReferences, replaceBuildVersion, injectNoindex, rewriteCanonical } from '../build/lib/rewrite.mjs';
import { shouldConvert, collectProtectedImages, webpTarget } from '../build/lib/images.mjs';
import { matchesPattern, isExcluded } from '../build/lib/fsutil.mjs';
import { validateDist } from '../build/lib/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hasEngine = fs.existsSync(path.join(here, '..', 'build', 'node_modules', 'sharp'));
const engineRequire = createRequire(path.join(here, '..', 'build', 'package.json'));

test('image path rewriting covers root-relative, ./ and file-relative references', () => {
  const conv = [{ from: 'images/web/cat.jpg', to: 'images/web/cat.webp' }, { from: 'assets/hero.png', to: 'assets/hero.webp' }];
  const html = '<img src="images/web/cat.jpg"><img src="./images/web/cat.jpg"><img src="/images/web/cat.jpg"> url(assets/hero.png) "images/web/cat.jpg?x=1" cat.jpg images/web/cat.jpg.bak';
  const r = rewriteReferences(html, 'index.html', conv);
  assert.equal(r.count, 5);
  assert.equal(r.text, '<img src="images/web/cat.webp"><img src="./images/web/cat.webp"><img src="/images/web/cat.webp"> url(assets/hero.webp) "images/web/cat.webp?x=1" cat.jpg images/web/cat.jpg.bak');
  const css = rewriteReferences('background:url(../web/cat.jpg);', 'images/css/style.css', conv);
  assert.equal(css.text, 'background:url(../web/cat.webp);');
  const same = rewriteReferences('src="cat.jpg"', 'images/web/page.html', conv);
  assert.equal(same.text, 'src="cat.webp"');
});

test('cache busting replaces every token', () => {
  const r = replaceBuildVersion('a __BUILD_VERSION__ b __BUILD_VERSION__', 'abc12345');
  assert.equal(r.count, 2);
  assert.equal(r.text, 'a abc12345 b abc12345');
  assert.equal(replaceBuildVersion('none', 'x').count, 0);
});

test('staging noindex and canonical rewriting', () => {
  const html = '<html><head><meta name="robots" content="index, follow"><link rel="canonical" href="https://old.example/"></head></html>';
  const out = rewriteCanonical(injectNoindex(html), 'https://pawhaven.com.my');
  assert.match(out, /<meta name="robots" content="noindex,nofollow">/);
  assert.doesNotMatch(out, /index, follow/);
  assert.match(out, /href="https:\/\/pawhaven\.com\.my\/"/);
});

test('image conversion decisions preserve icons, manifest and social images', () => {
  assert.equal(shouldConvert('images/web/cat.jpg').convert, true);
  assert.equal(shouldConvert('photo.jpeg').convert, true);
  assert.equal(shouldConvert('assets/favicon-32.png').convert, false);
  assert.equal(shouldConvert('assets/apple-touch-icon.png').convert, false);
  assert.equal(shouldConvert('assets/icon-192.png').convert, false);
  assert.equal(shouldConvert('logo.svg').convert, false);
  assert.equal(shouldConvert('favicon.ico').convert, false);
  assert.equal(shouldConvert('assets/print.png', { preserve: ['assets/print.*'] }).convert, false);
  const files = ['index.html', 'site.webmanifest', 'assets/og.jpg', 'assets/m.png'];
  const texts = { 'index.html': '<meta property="og:image" content="assets/og.jpg"><link rel="icon" href="/assets/m.png">', 'site.webmanifest': '{"icons":[{"src":"assets/m.png"}]}' };
  const prot = collectProtectedImages(files, (f) => texts[f] || '');
  assert.ok(prot.has('assets/og.jpg'));
  assert.ok(prot.has('assets/m.png'));
  assert.equal(shouldConvert('assets/og.jpg', { protectedSet: prot }).convert, false);
  assert.equal(webpTarget('a/b.JPG'), 'a/b.webp');
});

test('exclude matcher keeps runtime files and drops dev files', () => {
  assert.equal(matchesPattern('.git/config', '.git'), true);
  assert.equal(matchesPattern('docs/x.md', 'docs'), true);
  assert.equal(matchesPattern('a/b.log', '*.log'), true);
  assert.equal(isExcluded('.htaccess', ['.*']), false);
  assert.equal(isExcluded('.well-known/acme/x', ['.*']), false);
  assert.equal(isExcluded('README.md', ['README.md']), true);
  assert.equal(isExcluded('site.config.yml', ['site.config.yml']), true);
});

test('dist validation finds missing local references and passes on a complete site', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-validate-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><title>x</title><link rel="stylesheet" href="style.css"></head><body><img src="img/a.webp"><a href="#top">t</a><a href="#missing">m</a><a href="https://x.y/z.jpg">e</a></body></html>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'a{background:url(img/a.webp)}');
  let r = validateDist(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /img\/a\.webp/.test(e)));
  fs.mkdirSync(path.join(dir, 'img'));
  fs.writeFileSync(path.join(dir, 'img', 'a.webp'), 'x');
  r = validateDist(dir);
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.ok(r.warnings.some((w) => /#missing/.test(w)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('full build of a fixture site produces optimised dist with WebP, rewritten paths and cache busting', { skip: !hasEngine && 'build engine dependencies not installed' }, async () => {
  const sharp = engineRequire('sharp');
  const { buildSite } = await import('../build/build-static-site.mjs');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-site-'));
  fs.mkdirSync(path.join(site, 'images'));
  fs.mkdirSync(path.join(site, 'assets'));
  await sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 120, g: 80, b: 40 } } }).jpeg({ quality: 95 }).toFile(path.join(site, 'images', 'photo.jpg'));
  await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 100, b: 200, alpha: 0.5 } } }).png().toFile(path.join(site, 'assets', 'graphic.png'));
  await sharp({ create: { width: 180, height: 180, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } } }).png().toFile(path.join(site, 'assets', 'apple-touch-icon.png'));
  fs.writeFileSync(path.join(site, 'index.html'), `<!DOCTYPE html>\n<html lang="en">\n<head>\n<!-- comment -->\n<meta charset="UTF-8">\n<meta name="build-version" content="__BUILD_VERSION__">\n<title>Fixture Site</title>\n<link rel="apple-touch-icon" href="assets/apple-touch-icon.png">\n<link rel="stylesheet" href="style.css?v=__BUILD_VERSION__">\n<link rel="canonical" href="https://fixture.test/">\n</head>\n<body>\n  <h1>Fixture   Site</h1>\n  <img src="images/photo.jpg" alt="Photo">\n  <img src="assets/graphic.png" alt="Graphic">\n  <a href="https://wa.me/60123456789">WhatsApp</a>\n  <script src="script.js?v=__BUILD_VERSION__" defer></script>\n</body>\n</html>\n`);
  fs.writeFileSync(path.join(site, 'style.css'), 'body {\n  color: #ffffff;\n  background: url("images/photo.jpg");\n}\n');
  fs.writeFileSync(path.join(site, 'script.js'), 'function greet(longName) {\n  return "hi " + longName;\n}\nconsole.log(greet("there"));\n');
  fs.writeFileSync(path.join(site, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  fs.writeFileSync(path.join(site, '.htaccess'), 'Options -Indexes\n');
  fs.writeFileSync(path.join(site, 'README.md'), '# dev only\n');
  fs.writeFileSync(path.join(site, 'site.config.yml'), 'client:\n  name: Fixture\n  slug: fixture\n');
  const report = await buildSite({ site, out: path.join(site, 'dist'), version: 'v1234567', quiet: true });
  const dist = path.join(site, 'dist');
  assert.ok(fs.existsSync(path.join(dist, 'index.html')));
  assert.ok(fs.existsSync(path.join(dist, 'images', 'photo.webp')), 'jpg converted');
  assert.ok(!fs.existsSync(path.join(dist, 'images', 'photo.jpg')), 'original jpg not copied');
  assert.ok(fs.existsSync(path.join(dist, 'assets', 'graphic.webp')), 'png converted');
  assert.ok(fs.existsSync(path.join(dist, 'assets', 'apple-touch-icon.png')), 'icon preserved');
  assert.ok(fs.existsSync(path.join(dist, '.htaccess')), '.htaccess copied');
  assert.ok(fs.existsSync(path.join(dist, 'robots.txt')));
  assert.ok(!fs.existsSync(path.join(dist, 'README.md')), 'README excluded');
  assert.ok(!fs.existsSync(path.join(dist, 'site.config.yml')), 'config excluded');
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.match(html, /images\/photo\.webp/);
  assert.match(html, /assets\/graphic\.webp/);
  assert.match(html, /content="v1234567"/);
  assert.match(html, /style\.css\?v=v1234567/);
  assert.doesNotMatch(html, /__BUILD_VERSION__/);
  assert.doesNotMatch(html, /<!-- comment -->/);
  assert.match(html, /<a href="https:\/\/wa\.me\/60123456789">/);
  const css = fs.readFileSync(path.join(dist, 'style.css'), 'utf8');
  assert.match(css, /url\(images\/photo\.webp\)/);
  assert.ok(!css.includes('\n  '), 'css minified');
  const js = fs.readFileSync(path.join(dist, 'script.js'), 'utf8');
  assert.ok(js.length < 70 && !js.includes('longName'), 'js minified and mangled');
  const photo = await sharp(path.join(dist, 'images', 'photo.webp')).metadata();
  assert.equal(photo.width, 1920, 'resized to max width');
  assert.equal(photo.format, 'webp');
  assert.equal(report.images.length, 2);
  assert.ok(report.validation.ok);
  assert.ok(report.distBytes < report.sourceBytes);
  // source untouched
  assert.ok(fs.existsSync(path.join(site, 'images', 'photo.jpg')));
  assert.match(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), /__BUILD_VERSION__/);
  // staging mode
  const staging = await buildSite({ site, out: path.join(site, 'dist-staging'), version: 'v1', staging: true, productionUrl: 'https://stg-fixture.mybizgate.com', quiet: true });
  const sh = fs.readFileSync(path.join(site, 'dist-staging', 'index.html'), 'utf8');
  assert.match(sh, /noindex,nofollow/);
  assert.match(sh, /canonical" href="https:\/\/stg-fixture\.mybizgate\.com\/"/);
  assert.match(fs.readFileSync(path.join(site, 'dist-staging', 'robots.txt'), 'utf8'), /Disallow: \//);
  assert.ok(staging.validation.ok);
  fs.rmSync(site, { recursive: true, force: true });
});

test('build fails on broken JavaScript', { skip: !hasEngine && 'build engine dependencies not installed' }, async () => {
  const { buildSite } = await import('../build/build-static-site.mjs');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-badjs-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<html><head><title>x</title></head><body><script src="bad.js"></script></body></html>');
  fs.writeFileSync(path.join(site, 'bad.js'), 'function ( {');
  await assert.rejects(buildSite({ site, out: path.join(site, 'dist'), version: 'v', quiet: true }), /JS minification failed/);
  fs.rmSync(site, { recursive: true, force: true });
});
