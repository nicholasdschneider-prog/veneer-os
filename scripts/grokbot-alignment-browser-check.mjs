// Isolated UI: mocked APIs, no customer sends, production records, or microphone calls.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {MobileChatHeader} from '/src/components/chat/MobileChatHeader.tsx';
import {DropdownMenuItem} from '/src/components/ui/dropdown-menu.tsx';
import {VoiceSessions} from '/src/components/VoiceSessions.tsx';
import {BotComposer} from '/src/components/BotComposer.tsx';
import {VoiceProvider} from '/src/components/VoiceProvider.tsx';
import {Bots} from '/src/screens/Bots.tsx';
import '/src/styles.css';
const h=React.createElement;
const root=ReactDOM.createRoot(document.getElementById('root'));
window.showDecision=()=>root.render(h(VoiceProvider,null,h('div',{style:{height:'100dvh'}},h(Bots,{decisionId:'decision',onNavigate:()=>{},canCall:true}))));
root.render(h(VoiceProvider,null,h('main',{className:'conversation-surface',style:{maxWidth:600,margin:'auto',minHeight:'100dvh'}},
h(MobileChatHeader,{id:'fixture',name:'Avery',status:'Available',onBack:()=>{},onComputer:()=>{}},h(DropdownMenuItem,{onSelect:()=>{}},'Chat details')),
h('div',{style:{padding:16}},h('p',{className:'rounded-3xl bg-muted p-4'},'The replacement is ready for review. The $45 cost still needs your approval.'),
h(VoiceSessions,{conversationId:'fixture'}),h(BotComposer,{conversationId:'fixture',botName:'Avery',onSend:async()=>{}})))));`;
const vite = await createServer({
  root: new URL('../web', import.meta.url).pathname,
  server: {
    host: '127.0.0.1',
    port: 3299,
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
                  '<html data-color-mode="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>',
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
const output = new URL('../docs/reports/grokbot-alignment/', import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
const base = {
  id: 'decision',
  conversation_id: 'fixture',
  version: 3,
  state: 'needs_input',
  bot_name: 'Avery',
  assignee_name: 'Alex',
  can_answer: true,
  can_amend: false,
  created_at: '2026-09-23T00:00:00Z',
  updated_at: '2026-09-23T00:00:00Z',
  answer: null,
  result: null,
  parked: null,
  proposal: {
    question: 'Approve the $45 replacement?',
    recommendation: 'Replace the damaged part after confirming the address.',
    consequence:
      '$45 total. Delivery date remains uncertain. Approval does not send a customer message.',
    blocked_action: 'Verify address before execution.',
    blocks_scope: 'task',
    evidence: [],
    deadline: null,
    team: 'Support',
    choices: [
      { id: 'yes', label: 'Approve replacement', action: 'approve' },
      { id: 'hold', label: 'Hold for address', action: 'defer' },
    ],
  },
};
try {
  for (const width of [320, 375, 414, 768]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    const actions = [];
    let decision = structuredClone(base);
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      const json = (data) => route.fulfill({ json: data });
      if (p === '/api/live-voice/sessions')
        return json({
          sessions: [
            {
              id: 'call',
              started_ms: Date.now() - 90000,
              connected_ms: Date.now() - 53000,
              duration_ms: 53000,
              outcome: 'ended',
            },
          ],
        });
      if (p === '/api/live-voice/sessions/call')
        return json({
          entries: [
            { id: 1, role: 'user', text: 'Explain the proposed replacement.' },
            {
              id: 2,
              role: 'assistant',
              text: 'The replacement costs $45. Please confirm the address before approving.',
            },
          ],
          next: null,
        });
      if (p === '/api/live-voice')
        return json({
          callerName: 'Alex Smith',
          configuration: { ready: false, missing: ['Live voice connection'] },
          bot: { name: 'Avery', canMessage: true },
          history: [],
          decisions: [],
          chats: [],
          blockers: [],
        });
      if (p === '/api/conversations/fixture')
        return json({
          conversation: { provider: 'codex', model: null, effort: null },
          status: 'idle',
        });
      if (p.includes('/models')) return json({ models: [] });
      if (p === '/api/bots/decisions/decision/choice') {
        actions.push(route.request().postDataJSON());
        decision = {
          ...decision,
          state: 'decided',
          answer: {
            action: 'defer',
            text: 'Hold for address',
            scope: 'this_case',
            choice_label: 'Hold for address',
          },
        };
        return json({ decision });
      }
      if (p === '/api/bots/decisions/decision')
        return json({
          decision,
          messages: [
            {
              id: 'm',
              actor_name: 'Alex',
              text: 'Please check the address.',
              created_at: '2026-09-23T00:00:00Z',
            },
          ],
          events: [],
        });
      if (p === '/api/bots')
        return json({ bots: [], decisions: [decision], teams: [] });
      if (p === '/api/bot-workflows/guide') return json({ features: [] });
      if (p.startsWith('/api/bot-communication/'))
        return json({ drafts: [], briefings: [], threads: [] });
      return json({});
    });
    await page.goto('http://127.0.0.1:3299/__fixture');
    await page.getByRole('button', { name: /Voice chat/ }).waitFor();
    if (width < 768) {
      await page
        .getByRole('button', { name: 'Chat actions for Avery' })
        .click();
      await page.getByRole('menuitem', { name: 'Chat details' }).waitFor();
      await page.keyboard.press('Escape');
      await page
        .getByRole('menuitem', { name: 'Chat details' })
        .waitFor({ state: 'hidden' });
    }
    await page.screenshot({
      path: output + `chat-${width}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: /Voice chat/ }).click();
    await page
      .getByText(
        'The replacement costs $45. Please confirm the address before approving.',
      )
      .waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Live voice', exact: true }).click();
    await page.getByLabel('You · Alex Smith').waitFor();
    await page.getByRole('button', { name: 'Close and end voice' }).click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.evaluate(() => window.showDecision());
    await page.getByRole('button', { name: /Approve replacement/ }).waitFor();
    const choiceY = await page
      .getByRole('button', { name: /Approve replacement/ })
      .evaluate((e) => e.getBoundingClientRect().top);
    const discussionY = await page
      .getByRole('heading', { name: 'Discussion with Avery' })
      .evaluate((e) => e.getBoundingClientRect().top);
    assert.ok(choiceY < discussionY);
    await page
      .getByText(
        '$45 total. Delivery date remains uncertain. Approval does not send a customer message.',
        { exact: true },
      )
      .last()
      .waitFor();
    await page.screenshot({
      path: output + `decision-${width}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: /Hold for address/ }).click();
    assert.equal(actions[0].expected_version, 3);
    assert.equal(actions[0].choice_id, 'hold');
    assert.equal(actions[0].note, '');
    assert.equal(actions[0].scope, 'this_case');
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Mobile header/menu, session transcript, real initials, composer call controls, decision order/material risks and version-bound no-note submission passed at 320/375/414/768px.',
  );
} finally {
  await browser.close();
  await vite.close();
}
