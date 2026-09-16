import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { connectCdp, type CdpConnection } from '../channels/cdpClient.js';

export function readableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !['localhost', '::1', '::', '0.0.0.0'].includes(host)
      && !host.endsWith('.localhost') && !/^127\./.test(host)
      && !/^::ffff:(?:127\.|7f)/.test(host);
  } catch { return false; }
}

export const ReadUrlSchema = z.object({
  url: z.string().max(4000).refine(readableUrl, 'Use a network-accessible HTTP(S) URL without embedded credentials.'),
  wait_for: z.object({
    selector: z.string().trim().min(1).max(500).optional(),
    text: z.string().trim().min(1).max(1000).optional(),
    min_rows: z.number().int().min(1).max(1000).optional(),
  }).strict().optional(),
  timeout_ms: z.number().int().min(1000).max(60000).default(30000),
  max_chars: z.number().int().min(100).max(200000).default(50000),
}).strict();

export type ReadUrlInput = z.input<typeof ReadUrlSchema>;
export type ReadUrlRequest = z.output<typeof ReadUrlSchema>;
export interface ReadUrlResult {
  ok: boolean;
  final_url: string | null;
  fetched_at: string;
  title: string;
  text: string;
  tables: string[][][];
  truncated: boolean;
  error?: { code: string; message: string };
}

export function readUrlFailure(code: string, message: string): ReadUrlResult {
  return { ok: false, final_url: null, fetched_at: new Date().toISOString(), title: '', text: '', tables: [], truncated: false, error: { code, message } };
}

// Fixed platform code, run in an isolated world. Callers supply data only;
// page scripts cannot replace the DOM methods used by this reader.
const READ_DOCUMENT = `function(options) {
  const visible = el => el && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  let root = document.body;
  try { if (options.wait_for?.selector) root = document.querySelector(options.wait_for.selector); }
  catch { return { invalidSelector: true }; }
  const fullText = visible(root) ? root.innerText || '' : '';
  const wanted = options.wait_for?.text;
  const tables = [];
  let rows = 0, budget = options.max_chars, truncated = false;
  const candidates = root ? [...(root.matches('table,[role="table"],[role="grid"]') ? [root] : []),
    ...root.querySelectorAll('table,[role="table"],[role="grid"]')] : [];
  for (const table of candidates) {
    if (!visible(table)) continue;
    if (tables.length >= 20) { truncated = true; break; }
    const output = [];
    for (const row of table.querySelectorAll('tr,[role="row"]')) {
      if (!visible(row)) continue;
      const cells = [...row.querySelectorAll('th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')]
        .filter(visible);
      if (!cells.length) continue;
      rows++;
      if (rows > 1000 || budget <= 0) { truncated = true; break; }
      output.push(cells.slice(0, 100).map(cell => {
        const text = cell.innerText || '';
        const result = text.slice(0, Math.min(4000, budget));
        budget -= result.length;
        if (result.length < text.length) truncated = true;
        return result;
      }));
      if (cells.length > 100) truncated = true;
    }
    if (output.length) tables.push(output);
    if (rows > 1000 || budget <= 0) { truncated = true; break; }
  }
  const trimmed = fullText.trim();
  const loading = /^(loading[. …]*|please wait[. …]*)$/i.test(trimmed);
  return { url: location.href, title: document.title.slice(0, 1000),
    text: fullText.slice(0, options.max_chars), tables,
    truncated: truncated || fullText.length > options.max_chars,
    ready: document.readyState !== 'loading' && !!trimmed && !loading
      && (!wanted || fullText.includes(wanted)) && rows >= (options.wait_for?.min_rows || 0) };
}`;

class ReadFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** One background target in the existing working copy; never selects a user's tab. */
export async function readBrowserUrl(
  request: ReadUrlRequest,
  connection: { cdpUrl: string; caFile?: string | null },
  connect: typeof connectCdp = connectCdp,
): Promise<ReadUrlResult> {
  let cdp: CdpConnection | undefined;
  let targetId: string | undefined;
  let last: ReadUrlResult | undefined;
  let navigationBlocked = false;
  const blankUrl = `about:blank#veneer-reader-${randomUUID()}`;
  const deadline = Date.now() + request.timeout_ms;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  const timed = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReadFailure('timeout', 'The page did not satisfy the readiness condition before the timeout.')), remaining());
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    cdp = await connect(connection.cdpUrl, { caFile: connection.caFile, timeoutMs: remaining(), maxPayloadBytes: 4 * 1024 * 1024 });
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => timed(cdp!.send(method, params, sessionId));
    // Keep the creation reply even if our deadline passes, so cleanup knows the
    // exact target to close. CDP's own command timeout still bounds this step.
    const created = await cdp.send('Target.createTarget', { url: blankUrl, background: true });
    targetId = created.targetId;
    if (!targetId) throw new ReadFailure('browser_error', 'Could not create a page for this read.');
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId as string;
    const origin = new URL(request.url).origin;
    const initialTree = await send('Page.getFrameTree', {}, sessionId);
    const mainFrameId = initialTree.frameTree.frame.id;
    cdp.on(event => {
      if (event.sessionId !== sessionId || event.method !== 'Fetch.requestPaused') return;
      const url = String(event.params.request?.url ?? '');
      // Document redirects are constrained to the requested origin. Assets and
      // API calls still load normally. This is not traffic capture or an API proxy.
      const mainDocument = event.params.frameId === mainFrameId;
      const allowed = readableUrl(url) && (!mainDocument || new URL(url).origin === origin);
      if (!allowed && mainDocument) navigationBlocked = true;
      cdp!.post(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId: event.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}),
      }, sessionId);
    });
    await send('Page.enable', {}, sessionId);
    // Some SPAs defer their entire render while document.visibilityState is
    // hidden. Emulate focus on this target without activating a user's tab.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, sessionId);
    const navigation = await send('Page.navigate', { url: request.url }, sessionId);
    if (navigationBlocked) throw new ReadFailure('redirect_blocked', 'The page redirected to another origin. Request the final site URL directly.');
    if (navigation.errorText || navigation.isDownload) throw new ReadFailure('navigation_failed', 'The URL could not be opened as a rendered page.');
    while (Date.now() < deadline) {
      if (navigationBlocked) throw new ReadFailure('redirect_blocked', 'The page tried to load a document from another origin.');
      try {
        const tree = await send('Page.getFrameTree', {}, sessionId);
        const world = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'veneer-url-reader' }, sessionId);
        const evaluated = await send('Runtime.callFunctionOn', {
          functionDeclaration: READ_DOCUMENT, executionContextId: world.executionContextId,
          arguments: [{ value: request }], returnByValue: true,
        }, sessionId);
        const value = evaluated.result?.value;
        if (value?.invalidSelector) throw new ReadFailure('invalid_selector', 'The readiness selector is not valid CSS.');
        if (value?.url && value.url !== blankUrl && value.url !== 'about:blank') {
          if (!readableUrl(value.url) || new URL(value.url).origin !== origin) {
            throw new ReadFailure('redirect_blocked', 'The page left the requested origin.');
          }
          last = { ok: true, final_url: value.url, fetched_at: new Date().toISOString(),
            title: value.title, text: value.text, tables: value.tables, truncated: value.truncated };
          if (value.ready && !navigationBlocked) return last;
        }
      } catch (error) {
        if (error instanceof ReadFailure) throw error;
        // A same-origin navigation can replace the isolated world between calls.
        if (!/context.*(destroyed|not found)|Cannot find context|No frame/i.test(String(error))) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining())));
    }
    throw new ReadFailure(last?.text.trim() ? 'timeout' : 'empty_page', last?.text.trim()
      ? 'The page did not satisfy the readiness condition before the timeout.'
      : 'The page stayed empty. It may require a login or may have failed to load.');
  } catch (error) {
    // Raw CDP errors can contain control URLs or page content. Never return them.
    return readUrlFailure(error instanceof ReadFailure ? error.code : 'browser_error',
      error instanceof ReadFailure ? error.message : 'The browser could not complete this read.');
  } finally {
    let cleaned = true;
    if (cdp && !cdp.closed) {
      let timer: NodeJS.Timeout | undefined;
      try {
        cleaned = await Promise.race([
          (async () => {
            // A lost creation reply must not orphan a tab. Only the unique
            // request-owned blank target is eligible for this fallback.
            if (!targetId) {
              const targets = await cdp!.send('Target.getTargets');
              targetId = targets.targetInfos?.find((item: { url: string }) => item.url === blankUrl)?.targetId;
            }
            if (!targetId) return true;
            const result = await cdp!.send('Target.closeTarget', { targetId });
            return result.success === true;
          })().catch(() => false),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    } else if (targetId) {
      cleaned = false;
    }
    cdp?.close();
    if (!cleaned) return readUrlFailure('cleanup_failed', 'The temporary read tab could not be closed. Check this chat browser before retrying.');
  }
}
