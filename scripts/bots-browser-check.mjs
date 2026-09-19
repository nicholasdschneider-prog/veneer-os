// Run against bots-browser-fixture.ts only. Pass the local playwright module path.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output = path.resolve(process.argv[3] ?? 'docs/reports/veneer-bots/screenshots');
const screenshot = async (name) => {
  await page.screenshot({ path: path.join(output, process.argv[3] ? 'regression-' + name : name) });
};
const overflow = async () =>
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
try {
  await page.goto('http://127.0.0.1:3297/#/bots');
  await page
    .getByRole('button', { name: 'All I can access', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Is the Friday draft ready for review?' })
    .waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: 'Needs your input', exact: true })
      .getByRole('button')
      .count(),
    6,
  );
  await overflow();
  await screenshot('desktop.png');
  await page
    .getByRole('button', {
      name: /Atlas Needs your input Which internal rollout checklist/,
    })
    .click();
  await page
    .getByLabel('Message to bot')
    .fill('What does the verification step cover?');
  await page
    .getByRole('button', { name: 'Send to Atlas', exact: true })
    .click();
  await page
    .getByText('The recommendation uses the reviewed internal draft.', {
      exact: false,
    })
    .first()
    .waitFor({ timeout: 15000 });
  await screenshot('desktop-thread.png');
  await page
    .getByLabel('Answer or reasoning')
    .fill('Approve this internal checklist only.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page
    .getByRole('region', { name: 'Decision thread' })
    .getByText('Verified complete', { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
  assert.equal(
    await page.getByRole('button', { name: 'Approve', exact: true }).count(),
    0,
  );
  await page
    .getByRole('button', { name: 'Dismiss from my input queue' })
    .click();
  await page
    .getByText('Dismissed from your input queue.', { exact: false })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.overflow-y-auto.bg-background').evaluate((e) => {
    e.scrollTop = 0;
  });
  await overflow();
  await screenshot('mobile-completed.png');
  await page
    .getByRole('button', { name: 'All questions', exact: true })
    .click();
  await page.getByRole('button', { name: 'My team', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Is the Friday draft ready for review?' })
    .waitFor();
  await page.locator('.overflow-y-auto.bg-background').evaluate((e) => {
    e.scrollTop = 0;
  });
  await screenshot('mobile.png');
  await page
    .getByRole('button', { name: /Robin Needs your input Is the Friday/ })
    .click();
  await page.getByText('Only Jordan can answer this proposal.').waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Approve', exact: true }).count(),
    0,
  );
  await screenshot('mobile-viewer.png');
  await page
    .getByRole('button', { name: 'All questions', exact: true })
    .click();
  await page
    .getByRole('button', { name: /Atlas Needs your input Who should review/ })
    .click();
  await page
    .getByLabel('Answer or reasoning')
    .fill('A draft answer to the original version');
  const id = page.url().split('/').at(-1);
  await page.evaluate(async (id) => {
    const d = (await (await fetch(`/api/bots/decisions/${id}`)).json())
      .decision;
    await fetch(`/api/bots/decisions/${id}/proposal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_version: d.version,
        request_key: 'browser-material-revision',
        proposal: {
          ...d.proposal,
          recommendation: 'Revised after the reviewer changed.',
        },
      }),
    });
  }, id);
  await page
    .getByText('This proposal has changed.', { exact: false })
    .waitFor({ timeout: 15000 });
  assert.equal(
    await page
      .getByRole('button', { name: 'Approve', exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'Review the new version' }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('textarea')].some(
      (e) => e.id !== 'bot-message' && e.value === '',
    ),
  );
  assert.equal(await page.getByLabel('Answer or reasoning').inputValue(), '');
  await page
    .getByLabel('Answer or reasoning')
    .fill('Defer this internal draft until tomorrow.');
  await page.getByRole('button', { name: 'Defer', exact: true }).click();
  await page
    .getByRole('region', { name: 'Decision thread' })
    .getByText('Decision recorded', { exact: true })
    .waitFor();
  await screenshot('mobile-thread.png');
  await page
    .getByRole('button', { name: 'All questions', exact: true })
    .click();
  await page
    .getByRole('region', { name: 'Your bots 2' })
    .scrollIntoViewIfNeeded();
  await screenshot('mobile-roster.png');
  await page
    .getByRole('button', { name: 'Register a bot', exact: true })
    .click();
  await page.getByRole('combobox').selectOption('unregistered');
  await page.getByLabel('Bot name', { exact: true }).fill('Fixture Charlie');
  await page.getByRole('button', { name: 'Register bot', exact: true }).click();
  await page.getByRole('region', { name: 'Your bots 3' }).getByRole('button', { name: /Fixture Charlie/ }).waitFor();
  assert.equal(
    (await page.request.get('http://127.0.0.1:3297/api/bots')).status(),
    200,
  );
  await page
    .getByRole('region', { name: 'Your bots 3' }).getByRole('button', { name: /Fixture Charlie/ })
    .locator('..')
    .getByRole('button', { name: 'Return to Chats', exact: true })
    .click();
  await page.getByRole('region', { name: 'Your bots 2' }).waitFor();
  await overflow();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: desktop + mobile; six persistent questions; thread reply; approve -> verified complete; dismiss preserves result; team filter; viewer cannot approve; stale proposal disables approval and clears draft on review; defer does not execute; reversible registration; no horizontal overflow or browser exceptions.',
  );
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}
