import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveMarkdownImage } from '../src/routes/markdownImage.js';

let root: string;
let report: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown images '));
  const folder = path.join(root, 'Crew Seating');
  fs.mkdirSync(folder);
  report = path.join(folder, 'verification.md');
  fs.writeFileSync(path.join(folder, 'shot.png'), 'image bytes');
  fs.writeFileSync(path.join(folder, 'unlisted.png'), 'private image');
  fs.writeFileSync(path.join(root, 'outside.png'), 'outside image');
  fs.writeFileSync(path.join(folder, 'code.ts'), 'private code');
  fs.writeFileSync(path.join(folder, 'diagram.svg'), '<svg/>');
  fs.symlinkSync(path.join(root, 'outside.png'), path.join(folder, 'escape.png'));
  fs.writeFileSync(report, [
    `![Absolute](${folder}/shot.png)`,
    '![Relative](./shot.png)',
    '![Reference][image]\n\n[image]: <./shot.png>',
    '![Outside](../outside.png)',
    `![Absolute outside](${root}/outside.png)`,
    '![Symlink](escape.png)',
    '![Code](code.ts)',
    '![Vector](diagram.svg)',
    '`![Example](unlisted.png)`',
    '```md\n![Example](unlisted.png)\n```',
  ].join('\n\n'));
  const app = express();
  app.get('/', (req, res) => {
    if (!serveMarkdownImage(res, report, req.query.image)) res.json({ content: 'normal preview' });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('document image access', () => {
  it('leaves ordinary text previews alone', async () => {
    expect(await (await fetch(base)).json()).toEqual({ content: 'normal preview' });
  });
  it('serves raw and encoded absolute paths with spaces and relative references', async () => {
    for (const target of [path.join(path.dirname(report), 'shot.png'), path.join(path.dirname(report), 'shot.png').replaceAll(' ', '%20'), './shot.png']) {
      const res = await fetch(`${base}?image=${encodeURIComponent(target)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.text()).toBe('image bytes');
    }
  });
  it.each(['../outside.png', 'escape.png', 'unlisted.png', 'code.ts', 'missing.png', 'https://example.com/image.png', '%00.png', '%ZZ'])('rejects unsafe or unreferenced image %s', async (target) => {
    expect((await fetch(`${base}?image=${encodeURIComponent(target)}`)).status).toBe(404);
  });
  it('rejects a referenced absolute path outside the report folder', async () => {
    expect((await fetch(`${base}?image=${encodeURIComponent(path.join(root, 'outside.png'))}`)).status).toBe(404);
  });
  it('sandboxes SVGs even when their URL is opened directly', async () => {
    const res = await fetch(`${base}?image=diagram.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
