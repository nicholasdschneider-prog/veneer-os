// Isolated fixtures: no live customer messages, audio generation, or production data.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
const {createRoot}=ReactDOM;
import {BotCommunication,MessageThreadDialog} from '/src/components/BotCommunication.tsx';
import '/src/styles.css';
const root=createRoot(document.getElementById('root'));
window.showThread=()=>root.render(React.createElement(MessageThreadDialog,{conversationId:'fixture',anchor:{turn:'t',at:'2026-09-23T00:00:00Z'},onClose:()=>{}}));
root.render(React.createElement('main',{style:{maxWidth:650,margin:'20px auto',padding:16}},React.createElement('h1',null,'Needs your input · Order 10482'),React.createElement(BotCommunication,{conversationId:'fixture',decisionId:'decision',version:1})));`;
const vite = await createServer({
  root: new URL('../web', import.meta.url).pathname,
  server: {
    host: '127.0.0.1',
    port: 3297,
    strictPort: true,
    preTransformRequests: false,
  },
  plugins: [
    {
      name: 'fixture',
      configureServer(s) {
        s.middlewares.use('/__fixture', async (req, res) => {
          res.setHeader(
            'Content-Type',
            req.url?.includes('entry') ? 'application/javascript' : 'text/html',
          );
          res.end(
            req.url?.includes('entry')
              ? source
              : await s.transformIndexHtml(
                  '/__fixture',
                  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>',
                ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const output = new URL('../docs/reports/bot-communication/', import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.error('Fixture browser:', e.message);
    });
    let draft = {
      id: 'draft',
      version: 1,
      decision_id: 'decision',
      decision_version: 1,
      state: 'draft',
      stale: false,
      receipt: null,
      payload: {
        channel: 'sms',
        account: 'OrderOps support',
        recipients: ['+15555550123'],
        subject: '',
        body: 'Hi Sam, we can offer a replacement. Please confirm your preferred option.',
        attachments: [{ name: 'Part photo', reference: 'fixture:photo' }],
        customer: 'Sam (fixture)',
        ticket: '10482',
        context:
          'Customer reported a damaged part. Replacement approval is a separate decision.',
      },
    };
    let thread = {
      id: 'thread',
      source_text:
        'The shipment scan is missing. The carrier lookup is inconclusive.',
      messages: [],
      reactions: [],
    };
    await page.route('**/fixture-audio.wav', (route) => {
      const wav = Buffer.alloc(16044);
      wav.write('RIFF');
      wav.writeUInt32LE(16036, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(16000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(16000, 40);
      return route.fulfill({ contentType: 'audio/wav', body: wav });
    });
    let audioFails = true;
    const actions = [];
    await page.route('**/api/bot-communication/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      const body =
        route.request().method() === 'POST'
          ? route.request().postDataJSON()
          : null;
      if (p.endsWith('/chats/fixture'))
        return route.fulfill({ json: { drafts: [draft], briefings: [] } });
      if (p.endsWith('/drafts/draft')) {
        actions.push(body);
        if (body.action === 'save')
          draft = {
            ...draft,
            version: draft.version + 1,
            payload: body.payload,
          };
        else
          draft = {
            ...draft,
            version: draft.version + 1,
            state: body.action === 'send' ? 'queued' : 'discarded',
          };
        return route.fulfill({ json: draft });
      }
      if (p.endsWith('/decisions/decision/briefing'))
        return route.fulfill({
          json: {
            id: 'brief',
            transcript:
              'Sam reported a damaged part. We recommend reviewing a replacement. No refund is authorized. Please decide whether to approve the replacement; the customer message needs a separate send.',
          },
        });
      if (p.endsWith('/briefings/brief/audio'))
        return route.fulfill(
          audioFails
            ? {
                status: 503,
                json: {
                  error: 'Voice service unavailable. Try again shortly.',
                },
              }
            : { json: { url: '/fixture-audio.wav' } },
        );
      if (p.endsWith('/chats/fixture/threads') || p.endsWith('/threads/thread'))
        return route.fulfill({ json: thread });
      if (p.endsWith('/seen')) return route.fulfill({ json: { ok: true } });
      if (p.endsWith('/replies')) {
        thread = {
          ...thread,
          messages: [
            ...thread.messages,
            {
              id: 'reply',
              seq: 1,
              actor_name: 'Alex',
              actor_conversation_id: null,
              text: body.text,
              created_at: '2026-09-23 12:00:00',
            },
          ],
        };
        return route.fulfill({ json: thread });
      }
      if (p.endsWith('/reactions')) {
        thread = {
          ...thread,
          reactions: [{ emoji: body.emoji, mine: 1, count: 1 }],
        };
        return route.fulfill({ json: thread });
      }
      return route.fulfill({
        status: 404,
        json: { error: 'Fixture route not found' },
      });
    });
    await page.goto('http://127.0.0.1:3297/__fixture');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .waitFor();
    await page
      .getByLabel('Message', { exact: true })
      .fill('Hi Sam, please confirm which replacement option you prefer.');
    await page.getByRole('button', { name: 'Save edits' }).click();
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .waitFor();
    assert.equal(
      actions[0].payload.body,
      'Hi Sam, please confirm which replacement option you prefer.',
    );
    await page
      .getByRole('button', { name: 'Play briefing', exact: true })
      .click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'Voice service unavailable' })
      .waitFor();
    await page.getByText('Read briefing transcript', { exact: true }).click();
    await page.getByText(/Sam reported a damaged part/).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `${output}/${width === 390 ? 'mobile-error' : 'desktop-error'}.png`,
      fullPage: true,
    });
    audioFails = false;
    await page
      .getByRole('button', { name: 'Play briefing', exact: true })
      .click();
    await page.locator('audio').waitFor();
    assert.equal(await page.locator('audio').getAttribute('autoplay'), null);
    await page.screenshot({
      path: `${output}/${width === 390 ? 'mobile' : 'desktop'}.png`,
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    assert.equal(actions.length, 1);
    await page
      .getByRole('button', { name: 'Confirm send message', exact: true })
      .click();
    await page.getByText('Queued for sending', { exact: true }).waitFor();
    assert.equal(actions.length, 2);
    assert.equal(actions[1].expected_version, 2);
    await page.evaluate(() => window.showThread());
    await page.getByRole('dialog').waitFor();
    await page
      .getByLabel('Reply', { exact: true })
      .fill('Please check the carrier scan again.');
    await page
      .getByRole('button', { name: 'Reply in thread', exact: true })
      .click();
    await page
      .getByText('Please check the carrier scan again.', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'React 👍', exact: true }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="React 👍"]')
          ?.getAttribute('aria-pressed') === 'true',
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `${output}/${width === 390 ? 'thread-mobile' : 'thread-desktop'}.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Passed desktop/mobile: editable draft, versioned save/send confirmation, contextual transcript, audio failure/retry, no autoplay, thread reply/reaction and no overflow.',
  );
} finally {
  await browser.close();
  await vite.close();
}
