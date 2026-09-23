// Isolated fixtures only: never contacts teammates, providers, or business systems.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {TeamMessages} from '/src/screens/TeamMessages.tsx';
import '/src/styles.css';
const h=React.createElement;function Fixture(){const [hash,setHash]=React.useState('#/messages/fixture');return h('main',{style:{height:'100dvh'}},h(TeamMessages,{roomId:hash.split('/')[2],onNavigate:setHash}));}ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));`;
const vite = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  server: {
    host: "127.0.0.1",
    port: 3299,
    strictPort: true,
    preTransformRequests: false,
  },
  plugins: [
    {
      name: "fixture",
      configureServer(s) {
        s.middlewares.use("/__fixture", async (req, res) => {
          res.setHeader(
            "Content-Type",
            req.url?.includes("entry") ? "application/javascript" : "text/html",
          );
          res.end(
            req.url?.includes("entry")
              ? source
              : await s.transformIndexHtml(
                  "/__fixture",
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
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
try {
  for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: touch ? 375 : 1280, height: 900 }, hasTouch: touch });
    page.setDefaultTimeout(10000);
    const errors = [], sends = [], uploads = [];
    let failUpload = false, failSend = false, hold = false, release;
    page.on('pageerror', e => errors.push(e.message));
    const room = { id: 'fixture', kind: 'dm', team_id: 'team', name: '', revision: 1, last_seq: 0,
      members: [{ key: 'user:1', name: 'Alex', kind: 'human' }, { key: 'user:2', name: 'Ali', kind: 'human' }],
      self_key: 'user:1', can_send: true, can_manage: true, messages: [], next: null, unread: 0 };
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      let body = {};
      if (p.endsWith('/files')) {
        uploads.push(url.searchParams.get('name'));
        if (hold) await new Promise(r => release = r);
        if (failUpload) { failUpload = false; return route.fulfill({ status: 500, json: { error: 'Fixture upload failed' } }); }
        body = { file: { id: String(uploads.length), name: uploads.at(-1), size: 68, url: `/api/team-rooms/fixture/files/${uploads.length}` } };
      } else if (p.includes('/files/')) return route.fulfill({ contentType: 'image/png', body: png });
      else if (p.endsWith('/messages')) {
        sends.push(route.request().postDataJSON());
        if (failSend) { failSend = false; return route.fulfill({ status: 503, json: { error: 'Fixture send failed' } }); }
        const sent = sends.at(-1);
        room.last_seq++;
        room.messages = [{ id: String(room.last_seq), seq: room.last_seq, author_key: 'user:1', author_name: 'Alex',
          created_at: '2026-09-23 14:00:00', text: sent.text, mentions: [],
          attachments: sent.attachments.map(id => ({ id, name: uploads[Number(id) - 1], size: 68, url: `/api/team-rooms/fixture/files/${id}` })) }];
        body = { id: 'sent' };
      } else if (p === '/api/team-rooms') body = { rooms: [room] };
      else if (p.endsWith('/directory')) body = { self_key: 'user:1', teams: [] };
      else if (p === '/api/bots') body = { bots: [], teams: [] };
      else if (p === '/api/huddles') body = { huddles: [] };
      else if (p.includes('/organization')) body = { revision: 0, groups: [], placements: {}, fallback: null };
      else body = { room };
      await route.fulfill({ json: body });
    });
    await page.goto('http://127.0.0.1:3299/__fixture');
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await input.waitFor();
    const paste = () => input.evaluate(el => {
      const data = new DataTransfer(); data.items.add(new File(['image'], 'image.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      el.dispatchEvent(event); return event.defaultPrevented;
    });
    // Plain text pastes must retain the browser's default behavior.
    assert.equal(await input.evaluate(el => {
      const data = new DataTransfer(); data.setData('text/plain', 'hello');
      const e = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      el.dispatchEvent(e); return e.defaultPrevented;
    }), false);
    hold = true;
    assert.equal(await paste(), true);
    await page.getByRole('status').filter({ hasText: 'Uploading' }).waitFor();
    assert.equal(await send.isDisabled(), true);
    await input.press(touch ? 'Control+Enter' : 'Enter'); assert.equal(sends.length, 0);
    await paste(); await page.getByText('Files are still uploading. Try again when they finish.').waitFor();
    assert.equal(uploads.length, 1);
    hold = false; release();
    await page.getByRole('button', { name: /^Remove pasted-image-/ }).waitFor();
    assert.match(uploads[0], /^pasted-image-.*\.png$/);
    await page.waitForFunction(() => [...document.images].some(img => img.alt.startsWith('pasted-image-') && img.naturalWidth > 0));
    failSend = true; await send.click();
    await page.getByText('Fixture send failed').waitFor();
    assert.equal(await page.getByRole('button', { name: /^Remove pasted-image-/ }).count(), 1);
    await send.click();
    await page.getByRole('button', { name: /^Remove pasted-image-/ }).waitFor({ state: 'detached' });
    assert.equal(sends[1].text, ''); assert.deepEqual(sends[1].attachments, ['1']);
    assert.equal(sends[0].request_key, sends[1].request_key);
    await page.waitForFunction(() => [...document.querySelectorAll('article img')].some(img => img.naturalWidth > 0));
    // File picker, upload failure, and retry.
    await input.fill('Keep this draft'); failUpload = true;
    await page.locator('input[type=file]').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('fixture') });
    await page.getByText('Fixture upload failed').waitFor();
    assert.equal(await input.inputValue(), 'Keep this draft');
    await page.locator('input[type=file]').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('fixture') });
    await page.getByRole('button', { name: 'Remove report.pdf' }).waitFor();
    await send.click(); await page.getByRole('button', { name: 'Remove report.pdf' }).waitFor({ state: 'detached' });
    assert.equal(sends.at(-1).text, 'Keep this draft');
    // Dropped files use the same uploader.
    await input.evaluate(el => {
      const data = new DataTransfer(); data.items.add(new File(['fixture'], 'dropped.png', { type: 'image/png' }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await page.getByRole('button', { name: 'Remove dropped.png' }).waitFor();
    await page.getByRole('button', { name: 'Remove dropped.png' }).click();
    assert.equal(await send.isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const count = uploads.length;
    await page.locator('input[type=file]').setInputFiles(Array.from({ length: 11 }, (_, i) => ({ name: `file-${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('fixture') })));
    await page.getByText('Attach up to 10 files.', { exact: true }).waitFor();
    assert.equal(uploads.length, count);
    room.can_send = false;
    await page.reload(); await input.waitFor();
    assert.equal(await input.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Attach files', exact: true }).isDisabled(), true);
    await paste(); assert.equal(uploads.length, count);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Human chat attachments: desktop and mobile paste, previews, picker, drop, upload/send failures, and attachment-only sends passed.');
} finally { await browser.close(); await vite.close(); }
