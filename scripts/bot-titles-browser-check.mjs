// Uses only the in-memory --titles fixture, never live bots or decisions.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const screenshot = name => page.screenshot({ path: `docs/reports/bot-job-titles/screenshots/${name}.png` });
try {
  await page.goto('http://127.0.0.1:3297/#/bots');
  const roster = page.getByRole('region', { name: 'Your bots' });
  await roster.getByRole('button', { name: /Piper Content/ }).waitFor();
  const rail = page.getByRole('complementary', { name: 'Bot conversations' }).first();
  for (const surface of [roster, rail]) {
    assert.equal(await surface.getByRole('button', { name: /Piper Piper/ }).count(), 0);
    await surface.getByRole('button', { name: /Henry ERVP Business Leadership/ }).waitFor();
    await surface.getByRole('button', { name: /Grant Customer Service Lead/ }).waitFor();
    await surface.getByRole('button', { name: /Sage Vendor Operations\/Orders/ }).waitFor();
    await surface.getByRole('button', { name: /Solo/ }).waitFor();
    await surface.getByRole('button', { name: /Missing/ }).waitFor();
  }
  await roster.scrollIntoViewIfNeeded();
  await screenshot('desktop-roster');
  await rail.getByRole('button', { name: /Piper Content/ }).click();
  await page.waitForURL(/chat\/title-piper/);
  await rail.getByRole('button', { name: /Piper Content/ }).waitFor();
  await screenshot('desktop-selected-chat');
  await page.goto('http://127.0.0.1:3297/#/bots');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await roster.getByRole('button', { name: /Piper Content/ }).waitFor();
    await roster.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const long = roster.getByRole('button', { name: /Long International Vendor/ });
    assert.equal(await long.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await screenshot(`mobile-${width}-roster`);
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByText('All bot conversations', { exact: true }).click();
  await screenshot('mobile-conversation-list');
  assert.deepEqual(errors, []);
  console.log('PASS desktop roster/rail and selected native chat; mobile 390px/320px roster; no duplicate names, missing-title artifacts, long-title overflow or browser errors. No live data accessed.');
} finally { await browser.close(); }
