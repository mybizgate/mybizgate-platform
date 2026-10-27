// Generic browser smoke tests. Never submits real forms.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const screenshotDir = process.env.SMOKE_SCREENSHOT_DIR || path.join(process.cwd(), '.screenshots');
const siteName = process.env.SMOKE_SITE_NAME || '';

test('homepage loads without severe console errors', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  const res = await page.goto('/');
  expect(res && res.status()).toBe(200);
  await expect(page).toHaveTitle(/.+/);
  if (siteName) await expect(page.locator('body')).toContainText(siteName.split(' ')[0], { ignoreCase: true });
  const severe = errors.filter((e) => !/favicon|net::ERR_BLOCKED|fonts\.g(static|oogleapis)|third-party cookie/i.test(e));
  expect(severe, `console errors: ${severe.join('\n')}`).toEqual([]);
});

test('hero and primary CTA are visible', async ({ page }) => {
  await page.goto('/');
  const hero = page.locator('header, .hero, section, main').first();
  await expect(hero).toBeVisible();
  const cta = page.locator('a[href*="wa.me"], a[href*="whatsapp"], a.cta, .btn-primary, a[href^="#book"], a[href^="#contact"], button[type="submit"]').first();
  await expect(cta).toHaveCount(1);
});

test('navigation anchors resolve', async ({ page }) => {
  await page.goto('/');
  const hrefs = await page.locator('nav a[href^="#"], header a[href^="#"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')).filter((h) => h && h.length > 1));
  for (const href of hrefs.slice(0, 12)) {
    const id = href.slice(1);
    await expect(page.locator(`[id="${id}"]`), `missing anchor target ${href}`).toHaveCount(1);
  }
});

test('whatsapp links are well-formed when present', async ({ page }) => {
  await page.goto('/');
  const links = await page.locator('a[href*="wa.me"], a[href*="api.whatsapp.com"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  for (const l of links) expect(l).toMatch(/^https:\/\/(wa\.me\/\d{6,15}|api\.whatsapp\.com\/send)/);
});

test('mobile viewport has no horizontal overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile only');
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);
});

test('capture homepage screenshot', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle').catch(() => {});
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${testInfo.project.name}-home.png`), fullPage: true });
});
