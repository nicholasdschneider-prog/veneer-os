import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { parse } from 'parse5';
import { z } from 'zod';
import { readUrlFailure, type ReadUrlResult } from './readUrl.js';

export const PublicReadSchema = z.object({
  url: z.string().max(4000), max_chars: z.number().int().min(100).max(100000).default(40000),
  timeout_ms: z.number().int().min(1000).max(30000).default(15000),
}).strict();
export type PublicRead = z.output<typeof PublicReadSchema>;
export type PublicReadResult = ReadUrlResult & { mode: 'public_http'; rendered: false };
export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function publicUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') && !isIP(host)
    || /\.(localhost|local|internal|test|invalid)$/.test(host) || (isIP(host) && !publicAddress(host))) throw new Error('blocked_url');
  url.hash = '';
  return url;
}

// Parse markup without executing it or loading any subresources. No form values,
// scripts, hidden nodes, cookies or profile data are returned to the caller.
export function extractPublicHtml(html: string, maxChars: number): { title: string; text: string; truncated: boolean } {
  const doc = parse(html); let title = '', text = '';
  const skip = new Set(['script', 'style', 'noscript', 'template', 'input', 'textarea', 'select', 'svg']);
  function visit(node: any, inTitle = false): void {
    if (node.tagName && skip.has(node.tagName)) return;
    if (node.attrs?.some((a: any) => a.name === 'hidden' || a.name === 'aria-hidden' && a.value === 'true')) return;
    if (node.nodeName === '#text') {
      if (inTitle) title += node.value;
      else if (text.length <= maxChars) text += node.value;
      return;
    }
    const block = /^(p|div|h[1-6]|br|li|tr|article|section)$/.test(node.tagName ?? '');
    if (block && text.length <= maxChars) text += '\n';
    for (const child of node.childNodes ?? []) visit(child, inTitle || node.tagName === 'title');
    if (block && text.length <= maxChars) text += '\n';
  }
  visit(doc);
  const clean = text.replace(/[\t ]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
  return { title: title.trim().slice(0, 1000), text: clean.slice(0, maxChars), truncated: text.length > maxChars };
}

export type PublicTransport = (url: URL, signal: AbortSignal) => Promise<{ status: number; location?: string; contentType: string; body: string }>;
// DNS is validated AND pinned to the connection. Revalidate every redirect;
// there is no cookie jar, Authorization header, proxy, profile or Chrome process.
export const requestPublic: PublicTransport = async (url, signal) => {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(a => !publicAddress(a.address))) throw new Error('blocked_address');
  signal.throwIfAborted();
  const address = answers[0]!;
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false, signal,
      headers: { accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'Veneer-Public-Reader/1.0' },
      lookup: (_host, options, cb) => {
        const callback = cb as any;
        if ((options as { all?: boolean }).all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, res => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      const contentType = String(res.headers['content-type'] ?? '');
      if (status >= 300 && status < 400 || status !== 200 || !/^(text\/html|text\/plain|application\/xhtml\+xml)\b/i.test(contentType)) {
        res.destroy(); resolve({ status, location, contentType, body: '' }); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) res.destroy(new Error('response_too_large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ status, location, contentType, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
};

let inFlight = 0;
export async function readPublicUrl(request: PublicRead, transport: PublicTransport = requestPublic): Promise<PublicReadResult> {
  const failure = (code: string, message: string): PublicReadResult => ({ ...readUrlFailure(code, message), mode: 'public_http', rendered: false });
  if (inFlight >= 4) return failure('reader_busy', 'Four public reads are running. Retry this read after they complete.');
  inFlight++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeout_ms);
  try {
    const work = async (): Promise<PublicReadResult> => {
      let url = publicUrl(request.url);
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await transport(url, controller.signal);
        controller.signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(response.status) && response.location) { url = publicUrl(new URL(response.location, url).href); continue; }
        if (response.status !== 200) return failure('http_error', `The public site returned HTTP ${response.status}. No signed-in fallback was attempted.`);
        if (!/^(text\/html|text\/plain|application\/xhtml\+xml)\b/i.test(response.contentType)) return failure('unsupported_content', 'Public reads support HTML and plain text, not video, PDF, or binary content.');
        const result = /^text\/plain\b/i.test(response.contentType)
          ? { title: '', text: response.body.slice(0, request.max_chars), truncated: response.body.length > request.max_chars }
          : extractPublicHtml(response.body, request.max_chars);
        if (!result.text.trim()) return failure('empty_public_page', 'No public text was returned. JavaScript, sign-in, or a rendered browser may be required.');
        return { ok: true, final_url: url.href, fetched_at: new Date().toISOString(), ...result, tables: [], mode: 'public_http', rendered: false };
      }
      return failure('redirect_limit', 'The public site redirected too many times.');
    };
    return await Promise.race([work(), new Promise<PublicReadResult>(resolve => controller.signal.addEventListener('abort', () => resolve(failure('timeout', 'The public read timed out.')), { once: true }))]);
  } catch { return failure('public_read_failed', 'The public URL was blocked or unavailable. No credentials or signed-in browser were used.'); }
  finally { clearTimeout(timer); controller.abort(); inFlight--; }
}
