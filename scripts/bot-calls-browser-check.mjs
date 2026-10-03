// Isolated UI verification: all API requests are mocked; never accesses live business data.
// node --import tsx scripts/bot-calls-browser-check.mjs /absolute/path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const vite = await createServer({ root: new URL('../web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 3298, strictPort: true } });
await vite.listen();
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const output = process.argv[3] ?? new URL('../docs/reports/bot-calls/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const errors = [];
const ringFor = id => ({ decisionId: id, conversationId: 'autoship-chat', botName: 'AutoShip Worker', question: 'Ship order 100121413 to the address on file today?', remainingMs: 25000 });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, permissions: ['microphone'] });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let ring = null;
    let settings = { dnd: false, windowStart: '08:00', windowEnd: '18:00', timezone: 'America/New_York', bots: [{ conversationId: 'autoship-chat', name: 'AutoShip Worker', enabled: false }, { conversationId: 'clara-chat', name: 'Clara', enabled: false }] };
    const posts = [];
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.method() === 'POST' ? JSON.parse(request.postData() || '{}') : null;
      if (body) posts.push({ path, body });
      if (path === '/api/me') return route.fulfill({ json: { setupRequired: false, pending: false, user: { id: 1, email: 'owner@example.test', displayName: 'Owner', role: 'owner' } } });
      if (path === '/api/bots/chief-of-staff') return route.fulfill({ json: { chief_of_staff: { conversation_id: 'archer-chat', name: 'Archer', active: true } } });
      if (path === '/api/question-line') return route.fulfill({ json: { decisions: [], sleeping: [], selectedId: null, revision: 0 } });
      if (path === '/api/bots') return route.fulfill({ json: { bots: [], decisions: [], teams: [] } });
      if (path === '/api/team-rooms') return route.fulfill({ json: { rooms: [] } });
      if (path === '/api/team-rooms/directory') return route.fulfill({ json: { self_key: 'user:1', teams: [] } });
      if (path === '/api/navigation') return route.fulfill({ json: { configured: true, navigation: { items: [] } } });
      if (path === '/api/page-brand') return route.fulfill({ json: { brand: {} } });
      if (path === '/api/bot-calls/poll') return route.fulfill({ json: { ring } });
      if (path === '/api/bot-calls/ring') { ring = ringFor(body.decisionId); return route.fulfill({ json: { ring } }); }
      if (path === '/api/bot-calls/decline' || path === '/api/bot-calls/answer') { ring = null; return route.fulfill({ json: { ok: true } }); }
      if (path === '/api/bot-calls/settings') {
        if (body?.dnd !== undefined) settings = { ...settings, dnd: body.dnd };
        if (body?.bot) settings = { ...settings, bots: settings.bots.map(b => b.conversationId === body.bot.conversationId ? { ...b, enabled: body.bot.enabled } : b) };
        return route.fulfill({ json: settings });
      }
      if (path === '/api/live-voice') return route.fulfill({ json: { ok: true, configuration: { ready: true, missing: [], invalidUrl: false }, callerName: 'Owner', call: null,
        bot: { conversationId: 'autoship-chat', name: 'AutoShip Worker', title: null, archived: false, role: null, subteam: null, team: null, canMessage: true },
        decision: null, decisions: [], blockers: [], chats: [], history: [] } });
      if (path === '/api/live-voice/calls') return route.fulfill({ status: 503, json: { ok: false, error: 'Fixture has no voice service.' } });
      return route.fulfill({ status: 404, json: { error: 'Not available in fixture' } });
    });
    // Track audio elements the page creates so the check can tell whether the ringtone is sounding.
    await page.addInitScript(() => {
      const made = [];
      const Native = window.Audio;
      window.Audio = function (src) { const a = new Native(src); made.push(a); return a; };
      window.__ringing = () => made.some(a => a.src.endsWith('/sounds/bot-call.mp3') && !a.paused && !a.muted);
    });
    await page.goto('http://127.0.0.1:3298/#/bots?view=work');
    await page.locator('[data-desk-pill]').waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'nothing rings until a bot calls');

    // Settings live in the desk: every bot starts off, each has its own switch.
    await page.getByRole('button', { name: 'Choose from 0 waiting questions' }).click();
    await page.getByRole('button', { name: 'Calls' }).click();
    const autoship = page.getByRole('switch', { name: 'AutoShip Worker can call me' });
    await autoship.waitFor();
    assert.equal(await autoship.getAttribute('aria-checked'), 'false');
    assert.equal(await page.getByRole('switch', { name: 'Clara can call me' }).getAttribute('aria-checked'), 'false');
    await autoship.click();
    await page.getByRole('switch', { name: 'AutoShip Worker can call me', checked: true }).waitFor();
    assert.equal(await page.getByRole('switch', { name: 'Clara can call me' }).getAttribute('aria-checked'), 'false');
    await page.getByRole('switch', { name: 'Do not disturb' }).click();
    await page.getByRole('switch', { name: 'Do not disturb', checked: true }).waitFor();
    await page.getByRole('switch', { name: 'Do not disturb' }).click();
    await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-settings.png` });
    await page.getByRole('button', { name: 'Collapse question desk' }).click();

    // A bot rings: the card names it and shows the question. Decline is reported and the card leaves.
    ring = ringFor('q1');
    const card = page.getByRole('alertdialog', { name: 'AutoShip Worker is calling' });
    await card.waitFor({ timeout: 8000 });
    assert.ok((await card.textContent()).includes('Ship order 100121413'));
    const box = await card.boundingBox();
    const view = page.viewportSize();
    assert.ok(box.x >= 0 && box.x + box.width <= view.width && box.y >= 0 && box.y + box.height <= view.height, 'ring card stays on screen');
    await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-ringing.png` });
    // The page has been touched, so the ring is audible: the bundled tone is playing, unmuted.
    await page.waitForFunction(() => window.__ringing?.() === true, null, { timeout: 5000 });
    await card.getByRole('button', { name: 'Decline' }).click();
    await page.waitForFunction(() => window.__ringing?.() === false, null, { timeout: 5000 });
    await card.waitFor({ state: 'detached' });
    assert.deepEqual(posts.find(p => p.path === '/api/bot-calls/decline')?.body, { decisionId: 'q1' });

    // A tapped phone notification rings again in the app and lands on the question.
    await page.evaluate(() => { window.location.hash = '#/answer-call/q2'; });
    await card.waitFor({ timeout: 8000 });
    assert.deepEqual(posts.find(p => p.path === '/api/bot-calls/ring')?.body, { decisionId: 'q2' });
    assert.equal(await page.evaluate(() => window.location.hash), '#/bots/q2');

    // Answer reports the pickup and starts the live call on that question with no second press.
    await card.getByRole('button', { name: 'Answer' }).click();
    await card.waitFor({ state: 'detached' });
    await page.getByRole('region', { name: 'Live voice · AutoShip Worker' }).waitFor();
    await page.waitForFunction(() => document.body.textContent.includes('Fixture has no voice service.'), null, { timeout: 10000 });
    assert.deepEqual(posts.find(p => p.path === '/api/bot-calls/answer')?.body, { decisionId: 'q2' });
    assert.deepEqual(posts.find(p => p.path === '/api/live-voice/calls')?.body, { botConversationId: 'autoship-chat', decisionId: 'q2', incoming: true });
    await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-answered.png` });
    assert.ok(posts.filter(p => p.path === '/api/bot-calls/poll').every(p => typeof p.body.active === 'boolean'));
    assert.ok(posts.some(p => p.path === '/api/bot-calls/poll' && p.body.active), 'real input is reported as activity');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('bot calls browser check passed');
} finally {
  await browser.close();
  await vite.close();
}
