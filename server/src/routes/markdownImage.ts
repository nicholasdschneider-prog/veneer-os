import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import type { Response } from 'express';
import { parseProjectFileLinkTarget, resolveProjectFileLink } from '../files/projectFileLinks.js';
import { inlineContentSecurityPolicy, inlineContentType } from './inlineContentType.js';

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

/** Called only after the containing document passes its usual access check. */
export function serveMarkdownImage(res: Response, documentPath: string, image: unknown): boolean {
  if (image === undefined) return false;
  const unavailable = () => {
    res.status(404).json({ ok: false, error: 'Image not available in this document' });
    return true;
  };
  if (typeof image !== 'string' || !/\.(?:md|markdown)$/i.test(documentPath)) return unavailable();
  const target = parseProjectFileLinkTarget(image);
  if (!target || target.line || target.column) return unavailable();

  try {
    // Match the largest text preview cap and support raw absolute paths with spaces
    // that Veneer accepts in chat and document Markdown.
    const fd = fs.openSync(documentPath, 'r');
    let content: string;
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_MARKDOWN_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    content = content.replace(/\]\(((?:file:\/\/|~\/|\/)[^()\r\n]{1,4096})\)/g, (whole, raw: string) => {
      const trimmed = raw.trim();
      const title = trimmed.match(/\s+"[^"]*"$/)?.[0] ?? '';
      const destination = title ? trimmed.slice(0, -title.length) : trimmed;
      return /\s/.test(raw) ? `](${destination.replaceAll(' ', '%20')}${title})` : whole;
    });
    let referenced = false;
    marked.walkTokens(marked.lexer(content), (token) => {
      if (token.type !== 'image') return;
      const parsed = parseProjectFileLinkTarget(token.href);
      if (parsed && !parsed.line && !parsed.column && parsed.path === target.path) referenced = true;
    });
    if (!referenced) return unavailable();

    // A document grants its referenced images, not a general project file
    // browser. realpath containment also refuses symlinks into another folder.
    const root = path.dirname(fs.realpathSync(documentPath));
    const found = resolveProjectFileLink(root, image);
    if (!found.ok || found.kind !== 'file') return unavailable();
    const contentType = inlineContentType(found.absolutePath);
    if (!contentType?.startsWith('image/')) return unavailable();
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    const csp = inlineContentSecurityPolicy(contentType);
    if (csp) res.setHeader('Content-Security-Policy', csp);
    res.sendFile(found.absolutePath);
    return true;
  } catch {
    return unavailable();
  }
}
