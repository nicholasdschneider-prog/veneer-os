#!/usr/bin/env node
// veneer-pdf — turn Markdown or HTML into a PDF the user can download.
//
// Primary path: render with the Chrome the client already runs (high fidelity,
// modern CSS, web fonts). It tries, in order:
//   1. the shared desktop Chrome's CDP endpoint (127.0.0.1:VP_DESKTOP_CDP_PORT),
//      using its OWN isolated target so it never touches the user's visible tab;
//   2. a private, ephemeral headless Chrome launched from the managed binary.
// Fallback path: a pure-Python renderer (fpdf2 if present, else a stdlib-only
// writer) so the tool still produces a valid PDF when no Chrome is available.
//
// It writes the PDF into the working directory (or -o path) and prints the
// absolute output path on stdout so the calling agent can link it.
//
// Self-contained: it imports only Node built-ins and relies on Node 24 globals
// (fetch, WebSocket). Do not add npm dependencies — it is copied standalone to
// ~/.local/bin on every client.

import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LETTER = { width: 8.5, height: 11 };
const MARGIN_IN = { top: 0.6, bottom: 0.7, left: 0.7, right: 0.7 };

// ---------------------------------------------------------------------------
// Input handling and HTML assembly
// ---------------------------------------------------------------------------

export function detectFormat(source, hint) {
  if (hint && hint !== 'auto') return hint;
  const head = source.slice(0, 2000).toLowerCase();
  if (/<!doctype html|<html[\s>]/.test(head)) return 'html';
  return 'md';
}

export function isFullHtmlDocument(source) {
  return /<!doctype html|<html[\s>]/i.test(source.slice(0, 2000));
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMarkdown(text) {
  // Escape first, then re-introduce a small set of inline tags.
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const safeHref = /^(https?:|mailto:)/i.test(href) ? href : '#';
    return `<a href="${safeHref}">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  return out;
}

// A small, dependency-free Markdown-to-HTML converter. It covers the blocks a
// business report needs: headings, paragraphs, unordered/ordered lists, code
// fences, blockquotes, and horizontal rules. It is intentionally minimal.
export function markdownToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(escapeHtml(lines[i]));
        i += 1;
      }
      i += 1; // skip closing fence
      html.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      html.push('<hr>');
      i += 1;
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const wanted = ul ? 'ul' : 'ol';
      if (listType && listType !== wanted) closeList();
      if (!listType) {
        listType = wanted;
        html.push(`<${wanted}>`);
      }
      html.push(`<li>${inlineMarkdown((ul ? ul[1] : ol[1]).trim())}</li>`);
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      closeList();
      i += 1;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-block lines.
    closeList();
    const para = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s|^```|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*>\s?|^\s*([-*_])\2{2,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${inlineMarkdown(para.join(' ').trim())}</p>`);
  }

  closeList();
  return html.join('\n');
}

const BRAND_CSS = `
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Inter", ui-sans-serif, system-ui, sans-serif;
    color: #26221c;
    background: #faf7f2;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    font-size: 13.5px;
    line-height: 1.6;
  }
  .veneer-pdf-page { padding: 0.2in 0.1in; }
  h1, h2, h3, h4 {
    font-family: "Iowan Old Style", Palatino, Georgia, serif;
    color: #26221c;
    line-height: 1.2;
  }
  h1 { font-size: 30px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 24px 0 8px; }
  h3 { font-size: 16px; margin: 18px 0 6px; }
  p { margin: 0 0 12px; }
  a { color: #8a6d47; }
  ul, ol { margin: 6px 0 14px; padding-left: 22px; }
  li { margin: 3px 0; }
  hr { border: none; border-top: 1px solid #e6ddce; margin: 20px 0; }
  blockquote {
    margin: 12px 0; padding: 8px 16px;
    background: #f0e7d8; border-radius: 8px; color: #6f675c;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #f0e7d8; padding: 1px 5px; border-radius: 4px; font-size: 0.9em;
  }
  pre {
    background: #f0e7d8; padding: 14px 16px; border-radius: 8px;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #e6ddce; padding: 8px 10px; text-align: left; }
  th { background: #f0e7d8; }
`;

export function buildHtmlDocument(source, format, title) {
  if (format === 'html' && isFullHtmlDocument(source)) return source;
  const body = format === 'md' ? markdownToHtml(source) : source;
  const titleTag = title ? `<title>${escapeHtml(title)}</title>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${titleTag}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap">
<style>${BRAND_CSS}</style>
</head>
<body><div class="veneer-pdf-page">${body}</div></body>
</html>`;
}

// ---------------------------------------------------------------------------
// Chrome resolution + a tiny CDP client over the Node 24 global WebSocket
// ---------------------------------------------------------------------------

function isExecutable(file) {
  try {
    return Boolean(fs.statSync(file).mode & 0o111);
  } catch {
    return false;
  }
}

function findManagedChrome(home) {
  const browsers = path.join(home, '.agent-browser', 'browsers');
  let versions = [];
  try {
    versions = fs
      .readdirSync(browsers, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('chrome-'))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return null;
  }
  for (const version of versions) {
    const root = path.join(browsers, version);
    const candidates = [
      path.join(root, 'chrome-linux64', 'chrome'),
      path.join(root, 'chrome-linux', 'chrome'),
      path.join(root, 'chrome'),
      path.join(root, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveChrome(home = os.homedir(), env = process.env) {
  const explicit = env.VENEER_PDF_CHROME || env.VP_CHROME_BIN;
  if (explicit && isExecutable(explicit)) return explicit;
  // The trusted Agent Browser config is the most reliable pointer.
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home, '.agent-browser', 'config.json'), 'utf8'));
    if (typeof config.executablePath === 'string' && isExecutable(config.executablePath)) {
      return config.executablePath;
    }
  } catch {
    /* fall through */
  }
  const managed = findManagedChrome(home);
  if (managed) return managed;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' });
    const resolved = found.stdout?.trim();
    if (resolved && isExecutable(resolved)) return resolved;
  }
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message ?? 'CDP error'} (${msg.error.code ?? '?'})`));
        else resolve(msg.result ?? {});
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect timed out')), 10_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP connect failed'));
    }, { once: true });
  });
  return new Cdp(ws);
}

async function browserWsUrl(port, host = '127.0.0.1') {
  const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(4_000) });
  if (!res.ok) throw new Error(`CDP /json/version returned ${res.status}`);
  const body = await res.json();
  if (!body.webSocketDebuggerUrl) throw new Error('CDP endpoint exposed no webSocketDebuggerUrl');
  return body.webSocketDebuggerUrl;
}

// Render `html` to a PDF buffer using an already-connected CDP browser socket.
// A fresh isolated target is created and disposed, so the user's other tabs are
// never disturbed.
async function renderWithBrowserSocket(wsUrl, html) {
  const cdp = await connect(wsUrl);
  let targetId;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
    await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId);
    // Give layout, images, and web fonts a moment to settle.
    await cdp
      .send(
        'Runtime.evaluate',
        {
          expression: 'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    const { data } = await cdp.send(
      'Page.printToPDF',
      {
        printBackground: true,
        paperWidth: LETTER.width,
        paperHeight: LETTER.height,
        marginTop: MARGIN_IN.top,
        marginBottom: MARGIN_IN.bottom,
        marginLeft: MARGIN_IN.left,
        marginRight: MARGIN_IN.right,
        preferCSSPageSize: false,
      },
      sessionId,
    );
    return Buffer.from(data, 'base64');
  } finally {
    try {
      if (targetId) await cdp.send('Target.closeTarget', { targetId });
    } catch {
      /* best effort */
    }
    try {
      cdp.ws.close();
    } catch {
      /* already closing */
    }
  }
}

async function renderWithSharedChrome(html, env) {
  const port = Number(env.VP_DESKTOP_CDP_PORT || 9223);
  const wsUrl = await browserWsUrl(port);
  return renderWithBrowserSocket(wsUrl, html);
}

async function renderWithPrivateChrome(html, chromeBin, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-pdf-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    'about:blank',
  ];
  const child = spawn(chromeBin, args, {
    stdio: 'ignore',
    env: { HOME: env.HOME || os.homedir(), PATH: env.PATH || '/usr/bin:/bin', LANG: env.LANG || 'C.UTF-8' },
  });
  try {
    const portFile = path.join(dir, 'DevToolsActivePort');
    let port = 0;
    for (let attempt = 0; attempt < 100 && !port; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const [line] = fs.readFileSync(portFile, 'utf8').split('\n');
        const parsed = Number(line);
        if (Number.isInteger(parsed) && parsed > 0) port = parsed;
      } catch {
        /* not ready yet */
      }
    }
    if (!port) throw new Error('private Chrome did not report a debugging port');
    const wsUrl = await browserWsUrl(port);
    return await renderWithBrowserSocket(wsUrl, html);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Python fallback
// ---------------------------------------------------------------------------

function fallbackScriptPath() {
  if (process.env.VP_VENEER_PDF_LIB) {
    return path.join(process.env.VP_VENEER_PDF_LIB, 'fallback_pdf.py');
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const beside = path.join(here, 'fallback_pdf.py');
  if (fs.existsSync(beside)) return beside;
  return path.join(os.homedir(), '.local', 'lib', 'veneer-pdf', 'fallback_pdf.py');
}

function renderWithPython(html, outputPath, title) {
  const script = fallbackScriptPath();
  if (!fs.existsSync(script)) throw new Error(`fallback renderer missing at ${script}`);
  const htmlFile = `${outputPath}.veneer-pdf-source.html`;
  fs.writeFileSync(htmlFile, html, 'utf8');
  try {
    const result = spawnSync(
      'python3',
      [script, '--html', htmlFile, '-o', outputPath, ...(title ? ['--title', title] : [])],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`fallback renderer failed: ${(result.stderr || result.stdout || '').trim()}`);
    }
  } finally {
    try {
      fs.unlinkSync(htmlFile);
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { input: null, output: null, from: 'auto', title: null, forceFallback: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--output') opts.output = argv[++i];
    else if (arg === '--from') opts.from = argv[++i];
    else if (arg === '--title') opts.title = argv[++i];
    else if (arg === '--force-fallback') opts.forceFallback = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-') opts.input = '-';
    else if (!arg.startsWith('-') && opts.input === null) opts.input = arg;
  }
  return opts;
}

function readInput(input) {
  if (input === null || input === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(input, 'utf8');
}

export function resolveOutputPath(opts, source) {
  if (opts.output) return path.resolve(opts.output);
  if (opts.input && opts.input !== '-') {
    const base = path.basename(opts.input).replace(/\.[^.]+$/, '');
    return path.resolve(`${base || 'document'}.pdf`);
  }
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 8);
  return path.resolve(`document-${hash}.pdf`);
}

const HELP = `veneer-pdf — make a PDF from Markdown or HTML.

Usage:
  veneer-pdf <input.md|input.html> [-o output.pdf] [--from md|html|auto] [--title "..."]
  cat report.md | veneer-pdf -o /abs/path/report.pdf

The PDF is written to the working directory (or -o path). The absolute path is
printed on stdout. It renders with the client's Chrome, and falls back to a
pure-Python renderer automatically if Chrome is unavailable.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  let source;
  try {
    source = readInput(opts.input);
  } catch (error) {
    process.stderr.write(`veneer-pdf: cannot read input: ${error.message}\n`);
    return 1;
  }
  if (!source.trim()) {
    process.stderr.write('veneer-pdf: input is empty.\n');
    return 1;
  }

  const format = detectFormat(source, opts.from);
  const html = buildHtmlDocument(source, format, opts.title);
  const outputPath = resolveOutputPath(opts, source);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const attempts = [];
  if (!opts.forceFallback) {
    attempts.push(['chrome (shared)', () => renderWithSharedChrome(html, process.env)]);
    const chromeBin = resolveChrome();
    if (chromeBin) {
      attempts.push(['chrome (private)', () => renderWithPrivateChrome(html, chromeBin, process.env)]);
    }
  }

  const problems = [];
  for (const [name, run] of attempts) {
    try {
      const pdf = await run();
      if (!pdf || pdf.length < 100) throw new Error('renderer produced an empty PDF');
      fs.writeFileSync(outputPath, pdf);
      process.stderr.write(`veneer-pdf: rendered with ${name}.\n`);
      process.stdout.write(`${outputPath}\n`);
      return 0;
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }

  // Fallback: pure-Python renderer (fpdf2 if installed, else stdlib writer).
  try {
    renderWithPython(html, outputPath, opts.title);
    process.stderr.write('veneer-pdf: rendered with python fallback.\n');
    if (problems.length) process.stderr.write(`veneer-pdf: chrome unavailable (${problems.join('; ')}).\n`);
    process.stdout.write(`${outputPath}\n`);
    return 0;
  } catch (error) {
    problems.push(`python fallback: ${error.message}`);
    process.stderr.write(`veneer-pdf: could not create a PDF.\n  ${problems.join('\n  ')}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`veneer-pdf: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
