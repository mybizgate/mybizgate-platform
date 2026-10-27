// Bridge between the CLI/provisioning code and the build engine in platform/build.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLATFORM_DIR } from './config.mjs';
import { PlatformError, exists, log, formatBytes } from './utils.mjs';

const ENGINE = path.join(PLATFORM_DIR, 'build', 'build-static-site.mjs');

export async function buildWithEngine(siteDir, { out, version, staging = false, productionUrl, report, quiet = false } = {}) {
  if (!exists(path.join(PLATFORM_DIR, 'build', 'node_modules'))) {
    throw new PlatformError('Build engine dependencies are not installed.', { hint: `Run: npm --prefix ${path.join(PLATFORM_DIR, 'build')} ci` });
  }
  const { buildSite } = await import(pathToFileURL(ENGINE).href);
  try {
    return await buildSite({ site: siteDir, out: out || path.join(siteDir, 'dist'), version, staging, productionUrl, report, quiet });
  } catch (err) {
    throw new PlatformError(`Build failed: ${err.message}`, { code: 'BUILD_FAILED', cause: err });
  }
}

export function summarizeReport(report) {
  const sum = (arr, k) => arr.reduce((a, b) => a + b[k], 0);
  return {
    source: formatBytes(report.sourceBytes),
    dist: formatBytes(report.distBytes),
    html: `${formatBytes(sum(report.html, 'before'))} -> ${formatBytes(sum(report.html, 'after'))}`,
    css: `${formatBytes(sum(report.css, 'before'))} -> ${formatBytes(sum(report.css, 'after'))}`,
    js: `${formatBytes(sum(report.js, 'before'))} -> ${formatBytes(sum(report.js, 'after'))}`,
    images: `${formatBytes(sum(report.images, 'before'))} -> ${formatBytes(sum(report.images, 'after'))} (${report.images.length} converted)`,
  };
}

export function logReport(report) {
  const s = summarizeReport(report);
  log.info(`Size: source ${s.source} -> dist ${s.dist}`);
}
