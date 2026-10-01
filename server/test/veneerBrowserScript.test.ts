import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectCdp, type CdpConnection } from '../src/channels/cdpClient.js';
import { SCRIPT_CDP_METHODS, ScriptSchema, runBrowserScript, scriptMutates, scriptReadsPage, type ScriptInput } from '../src/veneerBrowser/script.js';

describe('browser script request boundary', () => {
  const valid = (steps: unknown[]): boolean => ScriptSchema.safeParse({ steps }).success;

  it('accepts only the fixed step vocabulary', () => {
    expect(valid([{ op: 'open', url: 'https://example.com' }, { op: 'wait', text: 'Ready' }, { op: 'text', selector: 'main', as: 'status' }])).toBe(true);
    expect(valid([{ op: 'click', text: 'Search', role: 'button' }, { op: 'fill', label: 'Order number', value: '123', submit: true }])).toBe(true);
    expect(valid([{ op: 'click', text: 'Search', timeout_ms: 2000 }, { op: 'text', selector: 'main', timeout_ms: 30000 }])).toBe(true);
    expect(valid([{ op: 'text', selector: 'main', timeout_ms: 30001 }])).toBe(false);
    for (const step of [
      { op: 'eval', code: 'document.cookie' }, { op: 'js', code: '1' }, { op: 'cookies' }, { op: 'storage' }, { op: 'network' },
      { op: 'text', selector: 'main', script: 'x' }, { op: 'wait', fn: '() => true' },
      { op: 'attr', selector: 'input', name: 'value' }, { op: 'attr', selector: 'input', name: 'onclick' },
      { op: 'click' }, { op: 'click', x: 5 }, { op: 'click', selector: 'a', x: 1, y: 1 },
      { op: 'wait' }, { op: 'wait', text: 'a', selector: 'b' }, { op: 'fill', value: 'x' }, { op: 'scroll' },
      { op: 'press', key: 'F12' }, { op: 'text', as: '<b>' },
    ]) expect(valid([step]), JSON.stringify(step)).toBe(false);
  });

  it('refuses non-web, credentialed and loopback addresses, and oversized scripts', () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,hi', 'view-source:https://example.com',
      'http://localhost:3100', 'http://127.0.0.1', 'http://[::1]', 'http://2130706433', 'https://user:pass@example.com']) {
      expect(valid([{ op: 'open', url }]), url).toBe(false);
      expect(valid([{ op: 'goto', url }]), url).toBe(false);
    }
    expect(valid([])).toBe(false);
    expect(valid(Array.from({ length: 41 }, () => ({ op: 'url' })))).toBe(false);
    expect(ScriptSchema.safeParse({ steps: [{ op: 'url' }], timeout_ms: 120001 }).success).toBe(false);
    expect(ScriptSchema.safeParse({ steps: [{ op: 'url' }], max_chars: 50001 }).success).toBe(false);
    expect(ScriptSchema.safeParse({ steps: [{ op: 'url' }], code: 'x' }).success).toBe(false);
  });

  it('classifies scripts that act and scripts that return page content', () => {
    const reading = ScriptSchema.parse({ steps: [{ op: 'open', url: 'https://example.com' }, { op: 'text' }] });
    const acting = ScriptSchema.parse({ steps: [{ op: 'tab', url_contains: 'example' }, { op: 'click', text: 'Sign in' }, { op: 'exists', text: 'Welcome' }] });
    expect([scriptMutates(reading), scriptReadsPage(reading)]).toEqual([false, true]);
    expect([scriptMutates(acting), scriptReadsPage(acting)]).toEqual([true, false]);
  });

  it('can only send CDP methods that never read cookies, storage, traffic or run supplied code', () => {
    for (const method of SCRIPT_CDP_METHODS) {
      expect(method).not.toMatch(/^(Network|Storage|DOMStorage|IndexedDB|CacheStorage|Browser|IO|Debugger|DOMSnapshot|Audits)\./);
      expect(method).not.toMatch(/cookie/i);
    }
    for (const method of ['Runtime.evaluate', 'Runtime.compileScript', 'Runtime.runScript', 'Page.addScriptToEvaluateOnNewDocument',
      'Page.setDownloadBehavior', 'Page.captureScreenshot', 'Page.printToPDF', 'DOM.getOuterHTML', 'DOM.setFileInputFiles', 'Fetch.getResponseBody',
      'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree', 'DOM.getDocument', 'DOM.describeNode', 'DOM.getAttributes']) {
      expect(SCRIPT_CDP_METHODS.has(method), method).toBe(false);
    }
  });
});

// Opt-in real Chrome fixture. It never uses a personal Chrome profile or a
// network site; script.test is mapped to the fixture server by this disposable Chrome.
describe.skipIf(!process.env.VENEER_BROWSER_TEST_CHROME)('browser scripts in Chrome', () => {
  let browser: ChildProcess;
  let directory: string;
  let server: http.Server;
  let base: string;
  let loopback: string;
  let cdpUrl: string;
  let observer: CdpConnection;
  const sent: string[] = [];

  const listTargets = async (): Promise<string[]> => ((await observer.send('Target.getTargets')).targetInfos as { type: string; url: string }[])
    .filter(target => target.type === 'page').map(target => target.url).sort();
  // A closed tab leaves the target list a moment after its close is acknowledged.
  const pageTargets = async (): Promise<string[]> => {
    let previous = await listTargets();
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const next = await listTargets();
      if (JSON.stringify(next) === JSON.stringify(previous)) return next;
      previous = next;
    }
    return previous;
  };

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-script-chrome-'));
    server = http.createServer((req, res) => {
      if (req.url === '/to-loopback') { res.writeHead(302, { location: `${loopback}/form` }); res.end(); return; }
      res.setHeader('content-type', 'text/html');
      if (req.url === '/dialog') { res.end('<title>Dialog</title><body><button onclick="alert(1)">Delete</button></body>'); return; }
      if (req.url === '/large') { res.end(`<title>Large</title><body><main>${'x'.repeat(5000)}</main></body>`); return; }
      if (req.url === '/checkout') {
        res.end(`<title>Checkout</title><style>label.required::after { content: " *"; }</style><body><main>
          <label class="required" for="first">First Name</label><input id="first" required>
          <input type="password" value="do-not-return">
          <button id="proceed">Proceed to Review &amp; Payments <i role="img" aria-label="arrow-right-alt"></i></button>
          <div role="button" tabindex="0" id="plain" onclick="document.title='Plain clicked'"><span>Save for later</span></div>
          <script>
            document.cookie = 'session=secret-cookie';
            localStorage.setItem('token', 'secret-storage');
            document.getElementById('proceed').addEventListener('click', e => {
              if (!e.isTrusted) return;
              setTimeout(() => {
                const review = document.createElement('div');
                review.id = 'review';
                review.innerText = 'Review ready for ' + document.getElementById('first').value;
                document.body.appendChild(review);
              }, 800);
            });
          </script></main></body>`);
        return;
      }
      if (req.url === '/details') { res.end('<title>Details</title><body><main>Detail page</main></body>'); return; }
      res.end(`<title>Orders</title><body>
        <div id="banner">Promo <button id="dismiss" onclick="this.parentNode.remove()">No thanks</button></div>
        <label for="order">Order number</label><input id="order" value="old">
        <input type="password" id="secret" value="do-not-return">
        <select id="carrier" aria-label="Carrier"><option value="">Pick</option><option value="ups">UPS Ground</option><option value="usps">USPS</option></select>
        <button id="go">Search</button>
        <a id="more" href="/details">More details</a>
        <div id="result" style="display:none"></div>
        <table id="history" style="display:none"><tr><th>Event</th><th>When</th></tr><tr><td>Shipped</td><td>Mon</td></tr></table>
        <script>
          document.cookie = 'session=secret-cookie';
          localStorage.setItem('token', 'secret-storage');
          document.getElementById('go').addEventListener('click', e => {
            if (!e.isTrusted) return;
            setTimeout(() => {
              const out = document.getElementById('result');
              out.style.display = 'block';
              out.innerText = 'Order ' + document.getElementById('order').value + ' via ' + document.getElementById('carrier').value + ': Delivered';
              document.getElementById('history').style.display = 'table';
            }, 300);
          });
        </script></body>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://script.test:${port}`;
    loopback = `http://127.0.0.1:${port}`;
    browser = spawn(process.env.VENEER_BROWSER_TEST_CHROME!, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${directory}`,
      '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      '--host-resolver-rules=MAP script.test 127.0.0.1', 'about:blank',
    ], { stdio: 'ignore' });
    const file = path.join(directory, 'DevToolsActivePort');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const [debugPort, wsPath] = fs.readFileSync(file, 'utf8').trim().split('\n');
    cdpUrl = `ws://127.0.0.1:${debugPort}${wsPath}`;
    observer = await connectCdp(cdpUrl);
  }, 20000);

  afterAll(async () => {
    observer?.close();
    if (browser && browser.exitCode === null) {
      browser.kill('SIGTERM');
      await new Promise<void>(resolve => browser.once('exit', () => resolve()));
    }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  // Records every method the engine sends, so the tests can prove what it used.
  const recording: typeof connectCdp = async (url, options) => {
    const real = await connectCdp(url, options);
    return {
      send: (method, params, sessionId) => { sent.push(method); return real.send(method, params, sessionId); },
      post: (method, params, sessionId) => { sent.push(method); real.post(method, params, sessionId); },
      on: handler => real.on(handler), onClose: handler => real.onClose(handler), close: () => real.close(),
      get closed() { return real.closed; },
    };
  };
  const run = (input: ScriptInput) => runBrowserScript(ScriptSchema.parse({ timeout_ms: 8000, ...input }), { cdpUrl }, recording);

  it('fills, selects, clicks and returns only the requested text, then closes its tab', async () => {
    const before = await pageTargets();
    const result = await run({ steps: [
      { op: 'open', url: `${base}/form` },
      { op: 'click', text: 'No thanks', optional: true },
      { op: 'click', text: 'Not on this page', optional: true },
      { op: 'fill', label: 'Order number', value: 'A-1001' },
      { op: 'select', label: 'Carrier', option: 'UPS Ground' },
      { op: 'click', text: 'Search', role: 'button' },
      { op: 'wait', text: 'Delivered' },
      { op: 'text', selector: '#result', as: 'status' },
      { op: 'table', selector: '#history' },
      { op: 'links', contains: 'details' },
      { op: 'attr', selector: '#more', name: 'href' },
      { op: 'exists', selector: '#banner' },
      { op: 'text' },
      { op: 'url' },
    ] });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, steps_run: 14, truncated: false, url: `${base}/form`, title: 'Orders', kept_tabs: [], page_opened_tabs: [] });
    const byStep = new Map(result.results.map(item => [item.step, item]));
    expect(byStep.get(3)?.value).toBe('skipped');
    expect(byStep.get(8)).toEqual({ step: 8, op: 'text', as: 'status', value: 'Order A-1001 via ups: Delivered' });
    expect(byStep.get(9)?.value).toEqual([['Event', 'When'], ['Shipped', 'Mon']]);
    expect(byStep.get(10)?.value).toEqual([{ text: 'More details', href: `${base}/details` }]);
    expect(byStep.get(11)?.value).toBe(`${base}/details`);
    expect(byStep.get(12)?.value).toBe(false);
    const everything = JSON.stringify(result);
    for (const secret of ['do-not-return', 'secret-cookie', 'secret-storage']) expect(everything).not.toContain(secret);
    expect(await pageTargets()).toEqual(before);
    for (const method of sent) expect(SCRIPT_CDP_METHODS.has(method), method).toBe(true);
  });

  it('keeps a tab on request and a later script continues on it', async () => {
    const before = await pageTargets();
    const opened = await run({ steps: [{ op: 'open', url: `${base}/details`, keep: true }] });
    expect(opened).toMatchObject({ ok: true, kept_tabs: [`${base}/details`] });
    expect(await pageTargets()).toEqual([...before, `${base}/details`].sort());
    const continued = await run({ steps: [{ op: 'tab', url_contains: '/details' }, { op: 'goto', url: `${base}/form` }, { op: 'click', selector: '#more' }, { op: 'wait', url_contains: '/details' }, { op: 'text', selector: 'main' }] });
    expect(continued.results.at(-1)?.value).toBe('Detail page');
    // A tab the script only attached to is left open.
    expect(await pageTargets()).toEqual([...before, `${base}/details`].sort());
    expect((await run({ steps: [{ op: 'tab', url_contains: 'no-such-tab' }] })).error?.code).toBe('tab_not_found');
  });

  it('stops at the failing step with a fixed message and no unknown outcome before anything was pressed', async () => {
    const result = await run({ steps: [{ op: 'open', url: `${base}/form` }, { op: 'click', text: 'Place order', timeout_ms: 300 }, { op: 'text' }] });
    expect(result).toMatchObject({ ok: false, steps_run: 1, steps_total: 3, results: [],
      error: { step: 2, op: 'click', code: 'not_found', outcome_unknown: false } });
    expect((await run({ steps: [{ op: 'open', url: `${base}/form` }, { op: 'text', selector: 'a[' }] })).error?.code).toBe('invalid_selector');
    expect((await run({ steps: [{ op: 'open', url: `${base}/form` }, { op: 'wait', text: 'Never', timeout_ms: 400 }] })).error?.code).toBe('wait_timeout');
  });

  it('finds fields and buttons by the names a bot reads, and waits for what a click reveals', async () => {
    sent.length = 0;
    const result = await run({ steps: [
      { op: 'open', url: `${base}/checkout` },
      { op: 'fill', label: 'First Name *', value: 'Ada' },
      { op: 'exists', text: 'Proceed to Review & Payments arrow-right-alt', as: 'button' },
      { op: 'click', text: 'Proceed to Review & Payments arrow-right-alt' },
      { op: 'text', selector: '#review', as: 'review' },
      { op: 'click', text: 'Save for later', role: 'button' },
      { op: 'url' },
    ] });
    expect(result.error).toBeUndefined();
    const values = Object.fromEntries(result.results.map(item => [item.as ?? item.op, item.value]));
    expect(values.button).toBe(true);
    expect(values.review).toBe('Review ready for Ada');
    expect(values.url).toMatchObject({ title: 'Plain clicked' });
    const everything = JSON.stringify(result);
    for (const secret of ['do-not-return', 'secret-cookie', 'secret-storage']) expect(everything).not.toContain(secret);
    expect(sent).toContain('Accessibility.queryAXTree');
    for (const method of sent) expect(SCRIPT_CDP_METHODS.has(method), method).toBe(true);
  });

  it('gives up on a missing element only after its wait, and skips an optional one quickly', async () => {
    const slow = await run({ steps: [{ op: 'open', url: `${base}/checkout` }, { op: 'fill', label: 'Company *', value: 'x', timeout_ms: 600 }] });
    expect(slow.error).toMatchObject({ step: 2, op: 'fill', code: 'not_found', outcome_unknown: false });
    expect(slow.duration_ms).toBeGreaterThan(600);
    const quick = await run({ steps: [{ op: 'open', url: `${base}/checkout` }, { op: 'click', text: 'Accept cookies', optional: true }, { op: 'exists', text: 'Accept cookies' }] });
    expect(quick.results.map(item => item.value)).toEqual(['skipped', false]);
    expect(quick.duration_ms).toBeLessThan(3500);
  });

  it('uses the one open web page when a script names none, and refuses to guess among several', async () => {
    for (const target of (await observer.send('Target.getTargets')).targetInfos as { targetId: string; type: string; url: string }[]) {
      if (target.type === 'page' && target.url.startsWith('http')) await observer.send('Target.closeTarget', { targetId: target.targetId });
    }
    await pageTargets();
    expect((await run({ steps: [{ op: 'text' }] })).error).toMatchObject({ code: 'no_page', message: 'No web page is open in this browser. Start with an open step.' });
    await run({ steps: [{ op: 'open', url: `${base}/details`, keep: true }] });
    const only = await run({ steps: [{ op: 'text', selector: 'main' }] });
    expect(only).toMatchObject({ ok: true, results: [{ step: 1, op: 'text', value: 'Detail page' }] });
    // The page the script adopted is the user's own tab: it is left open.
    expect((await pageTargets()).filter(url => url.startsWith('http'))).toEqual([`${base}/details`]);
    await run({ steps: [{ op: 'open', url: `${base}/large?order=PRIVATE-9`, keep: true }] });
    const several = await run({ steps: [{ op: 'text', selector: 'main' }] });
    expect(several.error?.code).toBe('no_page');
    expect(several.error?.message).toContain('2 tabs are open');
    expect(several.error?.message).toContain('/details');
    expect(several.error?.message).not.toContain('PRIVATE-9');
    for (const target of (await observer.send('Target.getTargets')).targetInfos as { targetId: string; type: string; url: string }[]) {
      if (target.type === 'page' && target.url.startsWith('http')) await observer.send('Target.closeTarget', { targetId: target.targetId });
    }
    await pageTargets();
  });

  it('refuses a redirect to a loopback address', async () => {
    const before = await pageTargets();
    const result = await run({ steps: [{ op: 'open', url: `${base}/to-loopback` }, { op: 'text' }] });
    expect(result.ok).toBe(false);
    expect(['navigation_blocked', 'navigation_failed']).toContain(result.error?.code);
    expect(JSON.stringify(result)).not.toContain('Order number');
    expect(await pageTargets()).toEqual(before);
  });

  it('caps the returned text and says so', async () => {
    const result = await run({ max_chars: 300, steps: [{ op: 'open', url: `${base}/large` }, { op: 'text', selector: 'main' }, { op: 'text', selector: 'main' }] });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.results.map(item => String(item.value).length)).toEqual([300, 0]);
  });

  it('stops on a page dialog and reports the click as unconfirmed', async () => {
    const before = await pageTargets();
    const result = await run({ steps: [{ op: 'open', url: `${base}/dialog` }, { op: 'click', text: 'Delete' }, { op: 'text' }] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ op: 'click', code: 'dialog_blocking', outcome_unknown: true });
    expect(result.duration_ms).toBeLessThan(4000);
    // The tab holding the dialog is left for the dialog tool, not discarded.
    expect(result.kept_tabs).toEqual([`${base}/dialog`]);
    expect(await pageTargets()).toEqual([...before, `${base}/dialog`].sort());
  });

  it('honors the overall time limit', async () => {
    const result = await run({ timeout_ms: 1000, steps: [{ op: 'open', url: `${base}/form` }, { op: 'wait', ms: 900 }, { op: 'wait', ms: 900 }, { op: 'text' }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });
});
