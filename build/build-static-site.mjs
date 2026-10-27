#!/usr/bin/env node
// MyBizGate static-site production build.
//
//   node build-static-site.mjs <site-dir> [--out dist] [--version <id>] [--staging]
//                              [--production-url https://host] [--report <file>] [--quiet]
//
// Source files are never modified. Output goes to <site-dir>/dist by default.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import sharp from 'sharp';
import { DEFAULT_EXCLUDES, walk, readText, writeText, ensureDir, fileSize, fmt } from './lib/fsutil.mjs';
import { rewriteReferences, replaceBuildVersion, injectBuildVersionMeta, injectNoindex, rewriteCanonical, stagingRobotsTxt } from './lib/rewrite.mjs';
import { collectProtectedImages, shouldConvert, webpTarget, convertToWebp } from './lib/images.mjs';
import { minifyHtml, minifyCss, minifyJs, MinifyError } from './lib/minify.mjs';
import { validateDist } from './lib/validate.mjs';

const TEXT_VERSION_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.webmanifest', '.json', '.xml', '.txt', '.svg']);
const REWRITE_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.webmanifest', '.json', '.xml']);

function parseCli(argv) {
  const opts = { out: null, version: null, staging: false, productionUrl: null, report: null, quiet: false, site: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--version') opts.version = argv[++i];
    else if (a === '--staging') opts.staging = true;
    else if (a === '--production-url') opts.productionUrl = argv[++i];
    else if (a === '--report') opts.report = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else opts.site = a;
  }
  if (!opts.site) throw new Error('Usage: build-static-site.mjs <site-dir> [--out dist] [--version id] [--staging] [--production-url url] [--report file]');
  return opts;
}

function loadBuildConfig(siteDir) {
  const p = path.join(siteDir, 'site.config.yml');
  const defaults = { exclude: [], images: { convert: true, quality: 82, max_width: 1920, preserve: [], png: 'lossy' }, cache_bust: true };
  if (!fs.existsSync(p)) return { config: null, build: defaults };
  const config = yaml.load(fs.readFileSync(p, 'utf8'), { schema: yaml.JSON_SCHEMA }) || {};
  const build = { ...defaults, ...(config.build || {}) };
  build.images = { ...defaults.images, ...((config.build && config.build.images) || {}) };
  build.exclude = Array.isArray(build.exclude) ? build.exclude : [];
  build.images.preserve = Array.isArray(build.images.preserve) ? build.images.preserve : [];
  return { config, build };
}

function detectVersion(siteDir) {
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: siteDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
  }
}

export async function buildSite(opts) {
  const siteDir = path.resolve(opts.site);
  const outDir = path.resolve(opts.out || path.join(siteDir, 'dist'));
  const say = (m) => { if (!opts.quiet) process.stdout.write(`${m}\n`); };
  if (!fs.existsSync(path.join(siteDir, 'index.html'))) throw new Error(`No index.html in ${siteDir}`);
  if (outDir === siteDir || siteDir.startsWith(`${outDir}${path.sep}`)) throw new Error('Output directory must be outside the site source tree (or be <site>/dist).');
  const { config, build } = loadBuildConfig(siteDir);
  const version = opts.version || detectVersion(siteDir);
  const staging = Boolean(opts.staging);
  const productionUrl = opts.productionUrl || (staging ? (config && config.site && config.site.staging_url) : (config && config.site && config.site.production_url)) || null;

  say(`[INFO] Building ${siteDir}`);
  say(`[INFO] Output ${outDir}  version ${version}  mode ${staging ? 'staging' : 'production'}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  const exclude = [...DEFAULT_EXCLUDES, ...build.exclude, path.relative(siteDir, outDir).split(path.sep).join('/') || 'dist'];
  const files = walk(siteDir, { exclude });
  const report = { site: siteDir, out: outDir, version, mode: staging ? 'staging' : 'production', files: files.length, sourceBytes: 0, distBytes: 0, images: [], html: [], css: [], js: [], copied: 0, versionReplacements: 0, versionMeta: { inserted: 0, updated: 0, deduplicated: 0 }, referenceRewrites: 0, warnings: [] };
  for (const rel of files) report.sourceBytes += fileSize(path.join(siteDir, rel));

  // --- Images --------------------------------------------------------------
  const protectedSet = collectProtectedImages(files, (rel) => readText(path.join(siteDir, rel)));
  const conversions = [];
  for (const rel of files) {
    const decision = shouldConvert(rel, { preserve: build.images.preserve, protectedSet, convert: build.images.convert !== false });
    if (!decision.convert) continue;
    const src = path.join(siteDir, rel);
    const before = fileSize(src);
    let result;
    try {
      result = await convertToWebp(sharp, fs.readFileSync(src), { quality: build.images.quality, maxWidth: build.images.max_width, png: build.images.png });
    } catch (err) {
      report.warnings.push(`${rel}: WebP conversion failed (${err.message}); original kept`);
      continue;
    }
    if (result.buffer.length >= before * 0.97 && !result.resized) {
      report.warnings.push(`${rel}: WebP not smaller (${fmt(result.buffer.length)} vs ${fmt(before)}); original kept`);
      continue;
    }
    const target = webpTarget(rel);
    writeText(path.join(outDir, target), result.buffer);
    conversions.push({ from: rel, to: target });
    report.images.push({ from: rel, to: target, before, after: result.buffer.length, width: result.width, resized: result.resized });
  }
  const converted = new Set(conversions.map((c) => c.from));

  // --- Everything else -------------------------------------------------------
  for (const rel of files) {
    if (converted.has(rel)) continue;
    const src = path.join(siteDir, rel);
    const dest = path.join(outDir, rel);
    const ext = path.extname(rel).toLowerCase();
    const before = fileSize(src);
    if (ext === '.html' || ext === '.htm') {
      let html = readText(src);
      const rw = rewriteReferences(html, rel, conversions); html = rw.text; report.referenceRewrites += rw.count;
      if (staging) html = injectNoindex(html);
      if (staging && productionUrl) html = rewriteCanonical(html, productionUrl); // production canonicals are left as authored
      if (build.cache_bust !== false) { const v = replaceBuildVersion(html, version); html = v.text; report.versionReplacements += v.count; }
      // Every dist HTML document carries the build version so deployment verification can confirm what is live.
      const meta = injectBuildVersionMeta(html, version); html = meta.text; report.versionMeta[meta.action] += 1;
      const out = await minifyHtml(html, { filename: rel });
      writeText(dest, out);
      report.html.push({ file: rel, before, after: Buffer.byteLength(out) });
    } else if (ext === '.css') {
      let css = readText(src);
      const rw = rewriteReferences(css, rel, conversions); css = rw.text; report.referenceRewrites += rw.count;
      if (build.cache_bust !== false) { const v = replaceBuildVersion(css, version); css = v.text; report.versionReplacements += v.count; }
      let out;
      try { out = minifyCss(css, { filename: rel }); } catch (err) { throw new MinifyError('CSS', rel, err); }
      writeText(dest, out);
      report.css.push({ file: rel, before, after: Buffer.byteLength(out) });
    } else if (ext === '.js' || ext === '.mjs') {
      let js = readText(src);
      const rw = rewriteReferences(js, rel, conversions); js = rw.text; report.referenceRewrites += rw.count;
      if (build.cache_bust !== false) { const v = replaceBuildVersion(js, version); js = v.text; report.versionReplacements += v.count; }
      let out;
      try { out = minifyJs(js, { filename: rel, module: ext === '.mjs' || /^\s*import\s|^\s*export\s/m.test(js) }); } catch (err) { throw new MinifyError('JS', rel, err); }
      writeText(dest, out);
      report.js.push({ file: rel, before, after: Buffer.byteLength(out) });
    } else if (TEXT_VERSION_EXT.has(ext) || REWRITE_EXT.has(ext)) {
      let text = readText(src);
      if (REWRITE_EXT.has(ext)) { const rw = rewriteReferences(text, rel, conversions); text = rw.text; report.referenceRewrites += rw.count; }
      if (build.cache_bust !== false) { const v = replaceBuildVersion(text, version); text = v.text; report.versionReplacements += v.count; }
      if (staging && path.posix.basename(rel) === 'robots.txt') text = stagingRobotsTxt();
      writeText(dest, text);
      report.copied += 1;
    } else {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      report.copied += 1;
    }
  }
  if (staging && !files.includes('robots.txt')) writeText(path.join(outDir, 'robots.txt'), stagingRobotsTxt());

  // --- Validate ---------------------------------------------------------------
  const validation = validateDist(outDir);
  report.validation = validation;
  for (const rel of walk(outDir)) report.distBytes += fileSize(path.join(outDir, rel));

  const sum = (arr, k) => arr.reduce((a, b) => a + b[k], 0);
  say(`[ OK ] HTML  ${fmt(sum(report.html, 'before'))} -> ${fmt(sum(report.html, 'after'))} (${report.html.length} files)`);
  say(`[ OK ] CSS   ${fmt(sum(report.css, 'before'))} -> ${fmt(sum(report.css, 'after'))} (${report.css.length} files)`);
  say(`[ OK ] JS    ${fmt(sum(report.js, 'before'))} -> ${fmt(sum(report.js, 'after'))} (${report.js.length} files)`);
  say(`[ OK ] WebP  ${fmt(sum(report.images, 'before'))} -> ${fmt(sum(report.images, 'after'))} (${report.images.length} images converted, ${report.referenceRewrites} references rewritten)`);
  say(`[ OK ] Cache busting: ${report.versionReplacements} replacement(s) of __BUILD_VERSION__ -> ${version}`);
  say(`[ OK ] Build version meta: ${report.versionMeta.inserted} inserted, ${report.versionMeta.updated} updated, ${report.versionMeta.deduplicated} deduplicated`);
  say(`[ OK ] Total ${fmt(report.sourceBytes)} -> ${fmt(report.distBytes)} (${report.files} source files, ${validation.files} output files)`);
  for (const w of report.warnings) say(`[WARN] ${w}`);
  for (const w of validation.warnings) say(`[WARN] ${w}`);
  for (const e of validation.errors) say(`[FAIL] ${e}`);
  if (opts.report) { ensureDir(path.dirname(path.resolve(opts.report))); fs.writeFileSync(path.resolve(opts.report), `${JSON.stringify(report, null, 2)}\n`); }
  if (!validation.ok) throw new Error(`dist validation failed with ${validation.errors.length} error(s)`);
  say(`[ OK ] Build complete: ${outDir}`);
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  buildSite(parseCli(process.argv.slice(2))).catch((err) => {
    process.stderr.write(`[FAIL] ${err.message}\n`);
    process.exit(1);
  });
}
