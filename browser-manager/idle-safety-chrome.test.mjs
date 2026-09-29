import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { freeLoopbackPort, waitForCdp } from './backends/common.mjs';
import { browserSocketUrl } from './webauthn.mjs';
import { inspectIdlePages } from './idle-safety.mjs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('real isolated Chrome protects forms, shadow DOM, and page beforeunload handlers', { skip: !fs.existsSync(chrome) }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-idle-check-'));
  const port = await freeLoopbackPort();
  const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitForCdp(port);
  const url = await browserSocketUrl(port);
  const socket = new WebSocket(url); const pending = new Map(); let next = 0;
  t.after(() => socket.terminate());
  socket.on('message', bytes => { const m = JSON.parse(String(bytes)); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(resolve => socket.once('open', resolve));
  const send = (method, params = {}, sessionId) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId } = await send('Target.attachToTarget', { targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true });
  const evaluate = expression => send('Runtime.evaluate', { expression }, sessionId);
  assert.deepEqual(await inspectIdlePages(url), { safe: true });
  await evaluate(`document.body.innerHTML='<input id="test">'; document.querySelector('input').value='unfinished fixture';`);
  assert.equal((await inspectIdlePages(url)).reason, 'unfinished_page');
  // React can update defaultValue alongside value. A nonempty field remains protected.
  await evaluate(`document.querySelector('input').defaultValue='unfinished fixture'`);
  assert.equal((await inspectIdlePages(url)).reason, 'unfinished_page');
  await evaluate(`document.body.innerHTML=''; window.addEventListener('beforeunload', window.fixtureHandler = e => e.preventDefault());`);
  assert.equal((await inspectIdlePages(url)).reason, 'unfinished_page');
  await evaluate(`window.removeEventListener('beforeunload', window.fixtureHandler); const host=document.createElement('div'); document.body.append(host); host.attachShadow({mode:'open'}).innerHTML='<div contenteditable>unfinished fixture</div>';`);
  assert.equal((await inspectIdlePages(url)).reason, 'unfinished_page');
  await evaluate(`document.body.innerHTML=''`);
  assert.deepEqual(await inspectIdlePages(url), { safe: true });
  // A standard checkbox has value="on" and defaultValue=""; that is not a draft.
  await evaluate(`document.body.innerHTML='<input type="checkbox"><input type="radio">'`);
  assert.deepEqual(await inspectIdlePages(url), { safe: true });
  await evaluate(`document.querySelector('input').checked=true`);
  assert.equal((await inspectIdlePages(url)).reason, 'unfinished_page');
  await send('Page.navigate', { url: 'about:blank?q=saved-query' }, sessionId);
  await new Promise(resolve => setTimeout(resolve,100));
  await evaluate(`document.body.innerHTML='<form role="search"><textarea>saved-query</textarea></form>'`);
  assert.deepEqual(await inspectIdlePages(url), { safe: true });
  await evaluate(`document.querySelector('textarea').value='new-query'`);
  assert.equal((await inspectIdlePages(url)).reason, 'unfinished_page');
  await evaluate(`document.body.innerHTML='<textarea>saved-query</textarea>'`);
  assert.equal((await inspectIdlePages(url)).reason, 'unfinished_page');

});
