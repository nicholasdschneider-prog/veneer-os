// Isolated UI verification: all API requests are mocked; never accesses live business data.
// node --import tsx scripts/bot-guide-browser-check.mjs /absolute/path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { botFeatureCatalog } from '../server/src/featureGuide/catalog.ts';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const vite = await createServer({ root: new URL('../web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 3298, strictPort: true } });
await vite.listen();
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const output = new URL('../docs/reports/bot-guide/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const errors = [];
try {
  for (const restricted of [false, true]) {
    const context = await browser.newContext({ viewport: { width: restricted ? 390 : 1440, height: restricted ? 844 : 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let failGuide = false;
    let catalog = botFeatureCatalog(Date.parse('2026-09-23T12:00:00Z'));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/bot-workflows/guide') return route.fulfill({ status: failGuide ? 503 : 200, json: failGuide ? { error: 'Unavailable' } : catalog });
      if (path === '/api/me') return route.fulfill({ json: { setupRequired: false, pending: false, user: { id: 1, email: 'employee@example.test', displayName: 'Alex', role: 'member', employeeWorkspace: restricted } } });
      if (path === '/api/bots') return route.fulfill({ json: { bots: [], decisions: [], teams: [] } });
      if (path === '/api/navigation') return route.fulfill({ json: { configured: true, navigation: { items: [] } } });
      if (path === '/api/page-brand') return route.fulfill({ json: { brand: {} } });
      return route.fulfill({ status: 404, json: { error: 'Not available in fixture' } });
    });
    await page.goto('http://127.0.0.1:3298/#/bots');
    if (!restricted) {
      await page.getByRole('button', { name: 'Bot guide', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Work with your VeneerBots' }).waitFor();
      await page.getByRole('button', { name: 'Back to VeneerBots' }).click();
    }
    await page.getByRole('button', { name: /See what’s new/ }).click();
    await page.getByRole('heading', { name: 'Work with your VeneerBots' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^New features/ }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'All features', exact: true }).click();
    await page.getByRole('heading', { name: 'Talk with your bot', exact: true }).waitFor();
    await page.getByRole('searchbox').fill('quiet hours');
    await page.getByRole('heading', { name: 'Get notified when a bot needs you' }).waitFor();
    assert.equal(await page.locator('article').count(), 1);
    await page.getByRole('button', { name: 'Copy example for Get notified when a bot needs you' }).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /quiet hours/);
    await page.getByRole('searchbox').fill('xyznomatch');
    await page.getByText('No matching features.', { exact: false }).waitFor();
    await page.getByRole('searchbox').fill('');
    await page.getByRole('button', { name: 'Copy guide link' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'http://127.0.0.1:3298/#/bot-guide');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/${restricted ? 'employee-mobile' : 'desktop'}.png` });
    await page.goto('http://127.0.0.1:3298/#/bot-guide?feature=notifications');
    await page.waitForFunction(() => {
      const top = document.getElementById('feature-notifications')?.getBoundingClientRect().top;
      return top !== undefined && top > 0 && top < 350;
    });
    // The permanent navigation entry remains available independently of announcements.
    if (restricted) await page.getByRole('button', { name: 'Bot guide', exact: true }).click();
    else {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'More navigation' }).click();
      await page.getByRole('menuitem', { name: 'Bot guide' }).click();
    }
    await page.getByRole('heading', { name: 'Work with your VeneerBots' }).waitFor();
    catalog = botFeatureCatalog(Date.parse('2027-01-01'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'New features (0)', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New features (0)', exact: true }).click();
    await page.getByText('No new features in the last 30 days.', { exact: false }).waitFor();
    failGuide = true;
    await page.reload();
    await page.getByRole('alert').filter({ hasText: 'Could not load the guide' }).waitFor();
    failGuide = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('button', { name: 'All features', exact: true }).click();
    await page.getByRole('heading', { name: 'Run a bot on a schedule' }).waitFor();
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Bot guide browser checks passed: full/restricted routes, new notice, desktop/mobile navigation, search, clipboard, permalinks, overflow, release aging, refresh, and failure recovery.');
} finally {
  await browser.close();
  await vite.close();
}
