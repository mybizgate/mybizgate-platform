import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rewriteReferences, replaceBuildVersion, injectBuildVersionMeta, buildVersionMetaTag, injectNoindex, rewriteCanonical } from '../build/lib/rewrite.mjs';
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

test('build-version meta is inserted into <head> when the source has none', () => {
  const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>x</title>\n</head>\n<body></body>\n</html>';
  const r = injectBuildVersionMeta(html, 'bc2ccee2');
  assert.equal(r.action, 'inserted');
  assert.equal(r.text.match(/<meta name="build-version"/g).length, 1);
  assert.match(r.text, /<head>\n  <meta charset="UTF-8">\n<meta name="build-version" content="bc2ccee2">\n  <title>x<\/title>/, 'placed inside <head>, after the charset meta');
  const noCharset = injectBuildVersionMeta('<html><head><title>x</title></head><body></body></html>', 'v1');
  assert.equal(noCharset.text, '<html><head>\n<meta name="build-version" content="v1"><title>x</title></head><body></body></html>');
  assert.equal(injectBuildVersionMeta('<html><body>no head</body></html>', 'v1').text, '<html>\n<head><meta name="build-version" content="v1"></head><body>no head</body></html>');
  assert.match(injectBuildVersionMeta('<p>fragment</p>', 'v1').text, /^<meta name="build-version" content="v1">\n<p>fragment<\/p>$/);
  assert.equal(buildVersionMetaTag('a"b&c'), '<meta name="build-version" content="a&quot;b&amp;c">');
});

test('build-version meta is updated in place, never duplicated', () => {
  const authored = '<head><meta charset="UTF-8"><meta name="build-version" content="__BUILD_VERSION__"><title>x</title></head>';
  const r = injectBuildVersionMeta(replaceBuildVersion(authored, 'v2').text, 'v2');
  assert.equal(r.action, 'updated');
  assert.equal(r.text, '<head><meta charset="UTF-8"><meta name="build-version" content="v2"><title>x</title></head>');
  // stale value, reversed attribute order, single quotes, self-closing
  for (const tag of ['<meta name="build-version" content="old123">', "<meta content='old' name='build-version'>", '<meta content="old" name="build-version" />', '<meta name=build-version content=old>']) {
    const out = injectBuildVersionMeta(`<head>${tag}<title>x</title></head>`, 'new1');
    assert.equal(out.action, 'updated', tag);
    assert.equal(out.text, '<head><meta name="build-version" content="new1"><title>x</title></head>', tag);
  }
  // unrelated meta tags are untouched and do not count as a build-version tag
  const other = injectBuildVersionMeta('<head><meta name="build-versions" content="x"><meta name="description" content="build-version"></head>', 'v3');
  assert.equal(other.action, 'inserted');
  assert.match(other.text, /<meta name="build-versions" content="x">/);
  assert.match(other.text, /<meta name="description" content="build-version">/);
  // duplicates collapse to a single tag at the first position
  const dup = injectBuildVersionMeta('<head><meta name="build-version" content="a"><title>x</title><meta name="build-version" content="b"></head>', 'v4');
  assert.equal(dup.action, 'deduplicated');
  assert.equal(dup.removed, 1);
  assert.equal(dup.text, '<head><meta name="build-version" content="v4"><title>x</title></head>');
  // idempotent
  assert.equal(injectBuildVersionMeta(dup.text, 'v4').text, dup.text);
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
  assert.equal(html.match(/<meta name="build-version"/g).length, 1, 'authored build-version tag kept once');
  assert.match(html, /<meta name="build-version" content="v1234567">/);
  assert.match(html, /style\.css\?v=v1234567/);
  assert.equal(report.versionMeta.updated, 1);
  assert.equal(report.versionMeta.inserted, 0);
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
  assert.match(sh, /<meta name="build-version" content="v1">/);
  assert.match(sh, /canonical" href="https:\/\/stg-fixture\.mybizgate\.com\/"/);
  assert.match(fs.readFileSync(path.join(site, 'dist-staging', 'robots.txt'), 'utf8'), /Disallow: \//);
  assert.ok(staging.validation.ok);
  fs.rmSync(site, { recursive: true, force: true });
});

test('full build injects build-version meta into every HTML page when the source has none', { skip: !hasEngine && 'build engine dependencies not installed' }, async () => {
  const { buildSite } = await import('../build/build-static-site.mjs');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-meta-'));
  fs.mkdirSync(path.join(site, 'about'));
  // Mirrors mybizgate-site: cache-busting tokens present, no build-version meta authored.
  fs.writeFileSync(path.join(site, 'index.html'), `<!DOCTYPE html>\n<html lang="en-MY">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>MyBizGate</title>\n  <link rel="stylesheet" href="style.css?v=__BUILD_VERSION__">\n</head>\n<body>\n  <h1>MyBizGate</h1>\n  <img src="pic.svg" alt="">\n  <script src="script.js?v=__BUILD_VERSION__" defer></script>\n</body>\n</html>\n`);
  fs.writeFileSync(path.join(site, 'about', 'index.html'), '<!DOCTYPE html><html><head><meta name="build-version" content="stale"><title>About</title></head><body><a href="../">home</a></body></html>\n');
  fs.writeFileSync(path.join(site, 'style.css'), 'body { color: #fff; }\n');
  fs.writeFileSync(path.join(site, 'script.js'), 'console.log("hi");\n');
  fs.writeFileSync(path.join(site, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const report = await buildSite({ site, out: path.join(site, 'dist'), version: 'bc2ccee2', quiet: true });
  const index = fs.readFileSync(path.join(site, 'dist', 'index.html'), 'utf8');
  const about = fs.readFileSync(path.join(site, 'dist', 'about', 'index.html'), 'utf8');
  for (const [name, html] of [['index', index], ['about', about]]) {
    assert.equal((html.match(/<meta name="build-version"/g) || []).length, 1, `${name}: exactly one build-version meta`);
    assert.match(html, /<head>[^]*?<meta name="build-version" content="bc2ccee2">[^]*?<\/head>/, `${name}: inside <head> with the build version`);
  }
  assert.doesNotMatch(about, /stale/);
  assert.match(index, /style\.css\?v=bc2ccee2/);
  assert.ok(!index.includes('\n  '), 'html still minified');
  assert.deepEqual(report.versionMeta, { inserted: 1, updated: 1, deduplicated: 0 });
  // verify.mjs must be able to read the version back the way the deployment health check does
  const { extractCriticalAssets } = await import('../src/verify.mjs');
  assert.equal(extractCriticalAssets(index).version, 'bc2ccee2');
  assert.equal(extractCriticalAssets(about).version, 'bc2ccee2');
  // source untouched
  assert.doesNotMatch(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), /build-version/);
  assert.ok(report.validation.ok, report.validation.errors.join(';'));
  assert.ok(!report.validation.warnings.some((w) => /build-version/.test(w)));
  fs.rmSync(site, { recursive: true, force: true });
});

test('dist validation warns when an HTML document has no build-version meta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-validate-meta-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><title>x</title></head><body></body></html>');
  let r = validateDist(dir);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => /build-version/.test(w)));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><meta name="build-version" content="v1"><title>x</title></head><body></body></html>');
  r = validateDist(dir);
  assert.ok(!r.warnings.some((w) => /build-version/.test(w)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build fails on broken JavaScript', { skip: !hasEngine && 'build engine dependencies not installed' }, async () => {
  const { buildSite } = await import('../build/build-static-site.mjs');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'mbg-badjs-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<html><head><title>x</title></head><body><script src="bad.js"></script></body></html>');
  fs.writeFileSync(path.join(site, 'bad.js'), 'function ( {');
  await assert.rejects(buildSite({ site, out: path.join(site, 'dist'), version: 'v', quiet: true }), /JS minification failed/);
  fs.rmSync(site, { recursive: true, force: true });
});
