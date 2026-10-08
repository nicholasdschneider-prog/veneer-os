// Isolated UI verification: all API requests are mocked; never accesses live business data.
// node --import tsx scripts/vibe-connector-browser-check.mjs /absolute/path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { botFeatureCatalog } from '../server/src/featureGuide/catalog.ts';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const vite = await createServer({ root: new URL('../web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 3298, strictPort: true } });
await vite.listen();
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const output = process.argv[3] ?? new URL('../docs/reports/vibe-connector/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const errors = [];
try {
  for (const restricted of [false, true]) {
    const context = await browser.newContext({ viewport: { width: restricted ? 390 : 1440, height: restricted ? 844 : 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let failGuide = false;
    let catalog = botFeatureCatalog(Date.parse('2026-10-08T12:00:00Z'));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/bot-workflows/guide') return route.fulfill({ status: failGuide ? 503 : 200, json: failGuide ? { error: 'Unavailable' } : catalog });
      if (path === '/api/me') return route.fulfill({ json: { setupRequired: false, pending: false, user: { id: 1, email: 'employee@example.test', displayName: 'Alex', role: 'member', employeeWorkspace: restricted } } });
      if (path === '/api/team-rooms') return route.fulfill({ json: { rooms: [] } });
      if (path === '/api/team-rooms/directory') return route.fulfill({ json: { self_key: 'user:1', teams: [] } });
      if (path === '/api/bots') return route.fulfill({ json: { bots: [], decisions: [], teams: [] } });
      if (path === '/api/navigation') return route.fulfill({ json: { configured: true, navigation: { items: [] } } });
      if (path === '/api/page-brand') return route.fulfill({ json: { brand: {} } });
      return route.fulfill({ status: 404, json: { error: 'Not available in fixture' } });
    });
    await page.goto('http://127.0.0.1:3298/#/bot-guide?feature=vibe-connector');
    await page.getByRole('searchbox').fill('Vibe');
    const card = page.locator('#feature-vibe-connector');
    await card.getByRole('heading', { name: 'Connect Vibe for streaming TV advertising', exact: true }).waitFor();
    assert.match(await card.innerText(), /Selected projects/);
    assert.match(await card.innerText(), /There is no read-only connector mode/);
    assert.match(await card.innerText(), /New · 2026-10-08/);
    await page.getByRole('button', { name: /^New features/ }).click();
    await card.waitFor();
    await card.getByRole('button', { name: 'Copy example for Connect Vibe for streaming TV advertising' }).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /MP Health and Bulk Bid/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path: output + '/' + (restricted ? 'employee-mobile' : 'desktop') + '.png', fullPage: true});
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Vibe guide passed: desktop/mobile, full/restricted, search, New callout, example copy, and overflow.');
} finally {
  await browser.close();
  await vite.close();
}
