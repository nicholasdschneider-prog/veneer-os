// Isolated UI verification: all API requests are mocked; never accesses live business data.
// node --import tsx scripts/desk-pill-browser-check.mjs /absolute/path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const vite = await createServer({ root: new URL('../web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 3297, strictPort: true } });
await vite.listen();
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const output = process.argv[3] ?? new URL('../docs/reports/desk-pill/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const errors = [];
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let chief = { conversation_id: 'archer-chat', name: 'Archer', active: true };
    const requested = [];
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      requested.push(path);
      if (path === '/api/me') return route.fulfill({ json: { setupRequired: false, pending: false, user: { id: 1, email: 'owner@example.test', displayName: 'Owner', role: 'owner' } } });
      if (path === '/api/bots/chief-of-staff') return route.fulfill({ json: { chief_of_staff: chief } });
      if (path === '/api/question-line') return route.fulfill({ json: { decisions: [], sleeping: [], selectedId: null, revision: 0 } });
      if (path === '/api/bots') return route.fulfill({ json: { bots: [], decisions: [], teams: [] } });
      if (path === '/api/team-rooms') return route.fulfill({ json: { rooms: [] } });
      if (path === '/api/team-rooms/directory') return route.fulfill({ json: { self_key: 'user:1', teams: [] } });
      if (path === '/api/navigation') return route.fulfill({ json: { configured: true, navigation: { items: [] } } });
      if (path === '/api/page-brand') return route.fulfill({ json: { brand: {} } });
      return route.fulfill({ status: 404, json: { error: 'Not available in fixture' } });
    });
    await page.goto('http://127.0.0.1:3297/#/bots?view=work');
    const pill = page.locator('[data-desk-pill]');
    // Visible with zero questions because a chief of staff exists.
    await pill.waitFor();
    await page.getByRole('button', { name: 'Chat with Archer' }).waitFor();
    await page.getByRole('button', { name: 'Choose from 0 waiting questions' }).waitFor();
    await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-default.png` });
    const view = page.viewportSize();
    const start = await pill.boundingBox();
    assert.ok(start.x + start.width > view.width - 40, 'starts in the right corner');

    // Drag by the chief button: the pill moves and the press does not open the desk.
    const from = { x: start.x + 30, y: start.y + start.height / 2 };
    const drag = async (to) => {
      if (mobile) {
        const client = await context.newCDPSession(page);
        const point = (p) => ({ x: p.x, y: p.y });
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
        for (let i = 1; i <= 8; i++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 }] });
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();
      }
    };
    await drag({ x: 120, y: 200 });
    await page.waitForTimeout(100);
    const moved = await pill.boundingBox();
    assert.ok(Math.abs(moved.x - (start.x + 120 - from.x)) < 3 && Math.abs(moved.y - (start.y + 200 - from.y)) < 3, `pill follows the pointer: ${JSON.stringify(moved)}`);
    assert.equal(await page.locator('aside[aria-label="Question desk"]').isVisible(), false, 'a drag is not a click');
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('veneer.desk-pill.v1')));
    assert.deepEqual(saved.position, { x: Math.round(moved.x), y: Math.round(moved.y) });

    // Position survives a reload, and is clamped when the window shrinks.
    await page.reload();
    await pill.waitFor();
    const reloaded = await pill.boundingBox();
    assert.ok(Math.abs(reloaded.x - moved.x) < 2 && Math.abs(reloaded.y - moved.y) < 2, 'position persisted');
    if (!mobile) {
      await page.evaluate(() => localStorage.setItem('veneer.desk-pill.v1', JSON.stringify({ position: { x: 5000, y: 5000 }, minimized: false })));
      await page.reload();
      await pill.waitFor();
      const clamped = await pill.boundingBox();
      assert.ok(clamped.x + clamped.width <= view.width - 7 && clamped.y + clamped.height <= view.height - 7, `clamped on load: ${JSON.stringify(clamped)}`);
      await page.setViewportSize({ width: 700, height: 500 });
      await page.waitForTimeout(100);
      const resized = await pill.boundingBox();
      assert.ok(resized.x + resized.width <= 693 && resized.y + resized.height <= 493, `re-clamped on resize: ${JSON.stringify(resized)}`);
      await page.setViewportSize(view);
    }

    // Minimize and restore with the keyboard.
    await page.getByRole('button', { name: 'Minimize' }).focus();
    await page.keyboard.press('Enter');
    const bubble = page.getByRole('button', { name: 'Show Archer and 0 waiting questions' });
    await bubble.waitFor();
    assert.equal(await pill.getByRole('button').count(), 1);
    await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-minimized.png` });
    await page.reload();
    await bubble.waitFor();
    await bubble.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Minimize' }).waitFor();

    // Selecting Archer opens his real chat in the desk without navigating away.
    const hash = await page.evaluate(() => location.hash);
    await page.getByRole('button', { name: 'Chat with Archer' }).click();
    const desk = page.locator('aside[aria-label="Question desk"]');
    await desk.waitFor();
    assert.equal(await desk.getByRole('button', { name: 'Archer', exact: true }).getAttribute('aria-pressed'), 'true');
    await desk.getByRole('textbox').first().waitFor();
    assert.equal(await page.evaluate(() => location.hash), hash, 'stays on the current screen');
    assert.ok(requested.some(path => path.startsWith('/api/conversations/archer-chat')), 'loads the chief of staff conversation');
    assert.equal(await pill.count(), 0, 'pill hides while the desk is open');
    await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-chat.png` });
    await desk.getByRole('button', { name: 'Questions' }).click();
    await desk.getByText('No questions waiting right now.').waitFor();
    await desk.getByRole('button', { name: 'Collapse question desk' }).click();
    await pill.waitFor();

    // No chief of staff and no questions: no pill at all.
    chief = null;
    await page.reload();
    await page.waitForTimeout(800);
    assert.equal(await pill.count(), 0, 'no pill without a chief of staff or questions');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('desk pill browser check passed');
} finally {
  await browser.close();
  await vite.close();
}
