import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildHtmlDocument,
  detectFormat,
  isFullHtmlDocument,
  markdownToHtml,
  parseArgs,
  resolveOutputPath,
} from '../../installer/veneer-pdf/veneer-pdf.mjs';
import { ensurePathEntry } from '../../installer/provision-veneer-pdf.mjs';

describe('veneer-pdf helpers', () => {
  it('detects format by content and hint', () => {
    expect(detectFormat('# Title', 'auto')).toBe('md');
    expect(detectFormat('<!DOCTYPE html><html></html>', 'auto')).toBe('html');
    expect(detectFormat('# Title', 'html')).toBe('html');
    expect(isFullHtmlDocument('<html><body>hi</body></html>')).toBe(true);
    expect(isFullHtmlDocument('# just markdown')).toBe(false);
  });

  it('converts core Markdown blocks to HTML', () => {
    const html = markdownToHtml('# Head\n\nA **bold** word.\n\n- one\n- two\n\n---\n');
    expect(html).toContain('<h1>Head</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<hr>');
  });

  it('escapes HTML in Markdown text', () => {
    const html = markdownToHtml('a < b & c');
    expect(html).toContain('a &lt; b &amp; c');
    expect(html).not.toContain('<b ');
  });

  it('wraps Markdown in a branded document but passes full HTML through', () => {
    const wrapped = buildHtmlDocument('# Hi', 'md', 'My Title');
    expect(wrapped).toContain('<!DOCTYPE html>');
    expect(wrapped).toContain('Inter');
    expect(wrapped).toContain('<title>My Title</title>');
    expect(wrapped).toContain('<h1>Hi</h1>');

    const full = '<!DOCTYPE html><html><body>kept</body></html>';
    expect(buildHtmlDocument(full, 'html')).toBe(full);
  });

  it('parses CLI arguments and resolves output paths', () => {
    const opts = parseArgs(['in.md', '-o', 'out.pdf', '--title', 'T', '--force-fallback']);
    expect(opts.input).toBe('in.md');
    expect(opts.output).toBe('out.pdf');
    expect(opts.title).toBe('T');
    expect(opts.forceFallback).toBe(true);

    expect(resolveOutputPath({ output: '/tmp/x.pdf' }, 'body')).toBe('/tmp/x.pdf');
    expect(resolveOutputPath({ input: '/docs/report.md' }, 'body')).toBe(path.resolve('report.pdf'));
    expect(resolveOutputPath({ input: '-' }, 'body')).toMatch(/document-[0-9a-f]{8}\.pdf$/);
  });
});

describe('veneer-pdf PATH wiring', () => {
  let dir: string;
  let envFile: string;
  const binDir = '/home/veneer/.local/bin';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-pdf-env-'));
    envFile = path.join(dir, 'env');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds a PATH line when none exists', () => {
    fs.writeFileSync(envFile, 'DATA_DIR=/x\n');
    expect(ensurePathEntry(envFile, binDir)).toBe(true);
    const body = fs.readFileSync(envFile, 'utf8');
    expect(body).toContain(`PATH=${binDir}:/usr/local/sbin`);
    expect(body).toContain('DATA_DIR=/x');
  });

  it('prepends bin dir to an existing PATH and strips quotes', () => {
    fs.writeFileSync(envFile, 'PATH="/usr/bin:/bin"\n');
    expect(ensurePathEntry(envFile, binDir)).toBe(true);
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`PATH=${binDir}:/usr/bin:/bin`);
  });

  it('is idempotent when bin dir is already present', () => {
    fs.writeFileSync(envFile, `PATH=${binDir}:/usr/bin\n`);
    expect(ensurePathEntry(envFile, binDir)).toBe(false);
  });
});
