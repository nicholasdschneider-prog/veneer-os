import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectCdp, type CdpConnection } from '../src/channels/cdpClient.js';
import { ReadUrlSchema, readBrowserUrl } from '../src/veneerBrowser/readUrl.js';

describe('URL reader request boundary', () => {
  it('rejects non-web schemes, embedded credentials, loopback aliases and arbitrary code', () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,hello', 'javascript:alert(1)',
      'http://localhost', 'http://127.1', 'http://2130706433', 'http://[::1]', 'http://[::ffff:127.0.0.1]',
      'https://user:password@example.com']) {
      expect(ReadUrlSchema.safeParse({ url }).success).toBe(false);
    }
    expect(ReadUrlSchema.safeParse({ url: 'https://example.com', script: 'document.cookie' }).success).toBe(false);
    expect(ReadUrlSchema.safeParse({ url: 'https://example.com', timeout_ms: 60001 }).success).toBe(false);
    expect(ReadUrlSchema.safeParse({ url: 'https://example.com', wait_for: { min_rows: 2 } }).success).toBe(true);
  });
});

// Opt-in real Chrome fixture. It never uses a personal Chrome profile or network
// site; reader.test is mapped to the fixture server by this disposable Chrome.
describe.skipIf(!process.env.VENEER_BROWSER_TEST_CHROME)('rendered URL reader in Chrome', () => {
  let browser: ChildProcess;
  let directory: string;
  let server: http.Server;
  let base: string;
  let cdpUrl: string;
  let observer: CdpConnection;
  let originalTargets: string[];

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-reader-chrome-'));
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { location: `${base.replace('reader.test', 'other.test')}/ready` }); res.end(); return; }
      res.setHeader('content-type', 'text/html');
      if (req.url === '/empty') { res.end('<body></body>'); return; }
      if (req.url === '/loading') { res.end('<body>Loading...</body>'); return; }
      if (req.url === '/large') { res.end(`<body>${'x'.repeat(10000)}</body>`); return; }
      if (req.url === '/same-redirect') { res.end('<script>location.replace("/ready")</script>'); return; }
      res.end(`<title>Fixture</title><body>Loading...<script>
        setTimeout(() => { if (document.hidden) return; document.body.innerHTML = '<h1>Pools ready</h1><table><tr><th>Pool</th><th>Volume</th></tr><tr><td>AI/USDG</td><td>123</td></tr></table><input type="password" value="do-not-return">'; }, 350);
      </script></body>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://reader.test:${(server.address() as AddressInfo).port}`;
    browser = spawn(process.env.VENEER_BROWSER_TEST_CHROME!, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${directory}`,
      '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      '--host-resolver-rules=MAP reader.test 127.0.0.1, MAP other.test 127.0.0.1', 'about:blank',
    ], { stdio: 'ignore' });
    const file = path.join(directory, 'DevToolsActivePort');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const [port, wsPath] = fs.readFileSync(file, 'utf8').trim().split('\n');
    cdpUrl = `ws://127.0.0.1:${port}${wsPath}`;
    observer = await connectCdp(cdpUrl);
    originalTargets = (await observer.send('Target.getTargets')).targetInfos.filter((target: any) => target.type === 'page').map((target: any) => target.targetId);
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

  const read = (route: string, options = {}) => readBrowserUrl(ReadUrlSchema.parse({ url: `${base}${route}`, timeout_ms: 3000, ...options }), { cdpUrl });

  it('waits for SPA data and extracts cells without returning form credentials', async () => {
    const result = await read('/ready', { wait_for: { selector: 'table', text: 'AI/USDG', min_rows: 2 } });
    expect(result).toMatchObject({ ok: true, final_url: `${base}/ready`, title: 'Fixture', truncated: false,
      tables: [[['Pool', 'Volume'], ['AI/USDG', '123']]] });
    expect(result.text).toContain('AI/USDG');
    expect(JSON.stringify(result)).not.toContain('do-not-return');
  });

  it('reports readiness, empty page, invalid selector and blocked redirect failures', async () => {
    expect((await read('/ready', { wait_for: { text: 'never appears' }, timeout_ms: 1000 })).error?.code).toBe('timeout');
    expect((await read('/empty', { timeout_ms: 1000 })).ok).toBe(false);
    expect((await read('/loading', { timeout_ms: 1000 })).ok).toBe(false);
    expect((await read('/ready', { wait_for: { selector: '[' } })).error?.code).toBe('invalid_selector');
    expect((await read('/redirect')).error?.code).toBe('redirect_blocked');
  }, 10000);

  it('supports same-origin SPA redirects and labels truncated output', async () => {
    expect(await read('/same-redirect', { wait_for: { text: 'Pools ready' } })).toMatchObject({ ok: true, final_url: `${base}/ready` });
    const large = await read('/large', { max_chars: 100 });
    expect(large).toMatchObject({ ok: true, truncated: true });
    expect(large.text).toHaveLength(100);
  });

  it('closes all request targets after success and failure and preserves existing tabs', async () => {
    const targets = (await observer.send('Target.getTargets')).targetInfos.filter((target: any) => target.type === 'page').map((target: any) => target.targetId);
    expect(targets.sort()).toEqual(originalTargets.sort());
  });
});
