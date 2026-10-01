import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { connectCdp, type CdpConnection } from '../channels/cdpClient.js';
import { readableUrl } from './readUrl.js';

// ---------------------------------------------------------------------------
// Browser scripts.
//
// One call carries a list of steps and returns only what the extracting steps
// produced, so a ten-step task costs one model turn instead of ten.
//
// A step list is data, never code. Veneer Browser holds the user's signed-in
// sessions, so agent-supplied JavaScript stays as unavailable here as it is in
// `run`: every page-side function below is fixed platform code that receives
// the step's fields as arguments and runs in an isolated world, and the engine
// can only send the CDP methods named in SCRIPT_CDP_METHODS. There is no step
// that reads a cookie, web storage, a request, or a form field's value.
// ---------------------------------------------------------------------------

export const SCRIPT_MAX_STEPS = 40;
const DEFAULT_WAIT_MS = 15_000;
// How long a step waits for its element before it reports not_found.
const ELEMENT_WAIT_MS = 5_000;
const OPTIONAL_WAIT_MS = 1_000;
// The accessibility tree is recomputed on every query, so it is consulted less often than the DOM.
const AX_INTERVAL_MS = 1_000;
const POLL_MS = 200;

const webUrl = z.string().max(4000).refine(readableUrl, 'Use a network-accessible HTTP(S) URL without embedded credentials.');
const selector = z.string().trim().min(1).max(500);
const words = z.string().trim().min(1).max(500);
const label = z.string().trim().min(1).max(60).regex(/^[\w .:-]+$/, 'Use letters, digits, spaces, dots, colons, dashes or underscores.');
const ROLES = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'heading'] as const;
const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'] as const;
// A typed value never reflects into these, so reading them cannot return what
// was just entered into a field. `value` is deliberately absent.
const ATTRIBUTES = ['href', 'src', 'alt', 'title', 'aria-label', 'aria-checked', 'aria-selected', 'aria-expanded',
  'aria-disabled', 'aria-current', 'role', 'id', 'class', 'name', 'type', 'checked', 'disabled'] as const;

const elementWait = z.number().int().min(100).max(30_000).optional();

const locator = {
  selector: selector.optional(),
  text: words.optional(),
  role: z.enum(ROLES).optional(),
  exact: z.boolean().optional(),
  nth: z.number().int().min(0).max(500).optional(),
};

const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('open'), url: webUrl, keep: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('tab'), url_contains: words }).strict(),
  z.object({ op: z.literal('goto'), url: webUrl }).strict(),
  z.object({ op: z.literal('wait'), text: z.string().trim().min(1).max(1000).optional(), selector: selector.optional(),
    gone: selector.optional(), url_contains: words.optional(), ms: z.number().int().min(1).max(10_000).optional(),
    timeout_ms: z.number().int().min(100).max(60_000).optional() }).strict(),
  z.object({ op: z.literal('click'), ...locator, x: z.number().min(0).max(10_000).optional(),
    y: z.number().min(0).max(10_000).optional(), optional: z.boolean().optional(), timeout_ms: elementWait }).strict(),
  z.object({ op: z.literal('fill'), selector: selector.optional(), label: words.optional(), exact: z.boolean().optional(),
    nth: z.number().int().min(0).max(500).optional(), value: z.string().max(5000), submit: z.boolean().optional(), timeout_ms: elementWait }).strict(),
  z.object({ op: z.literal('press'), key: z.enum(KEYS) }).strict(),
  z.object({ op: z.literal('select'), selector: selector.optional(), label: words.optional(), exact: z.boolean().optional(),
    nth: z.number().int().min(0).max(500).optional(), option: z.string().min(1).max(500), timeout_ms: elementWait }).strict(),
  z.object({ op: z.literal('scroll'), selector: selector.optional(), to: z.enum(['top', 'bottom']).optional(),
    by: z.number().int().min(-20_000).max(20_000).optional(), timeout_ms: elementWait }).strict(),
  z.object({ op: z.literal('text'), selector: selector.optional(), all: z.boolean().optional(),
    max_chars: z.number().int().min(1).max(50_000).optional(), timeout_ms: elementWait, as: label.optional() }).strict(),
  z.object({ op: z.literal('table'), selector: selector.optional(), max_rows: z.number().int().min(1).max(1000).optional(), timeout_ms: elementWait, as: label.optional() }).strict(),
  z.object({ op: z.literal('links'), selector: selector.optional(), contains: words.optional(),
    max: z.number().int().min(1).max(200).optional(), timeout_ms: elementWait, as: label.optional() }).strict(),
  z.object({ op: z.literal('attr'), selector, name: z.enum(ATTRIBUTES), nth: z.number().int().min(0).max(500).optional(), timeout_ms: elementWait, as: label.optional() }).strict(),
  z.object({ op: z.literal('exists'), ...locator, as: label.optional() }).strict(),
  z.object({ op: z.literal('url'), as: label.optional() }).strict(),
]);

export type ScriptStep = z.infer<typeof StepSchema>;

const count = (...values: unknown[]): number => values.filter(value => value !== undefined).length;

export const ScriptSchema = z.object({
  steps: z.array(StepSchema).min(1).max(SCRIPT_MAX_STEPS),
  timeout_ms: z.number().int().min(1000).max(120_000).default(60_000),
  max_chars: z.number().int().min(100).max(50_000).default(20_000),
}).strict().superRefine((script, context) => {
  script.steps.forEach((step, index) => {
    const issue = (message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index], message });
    if (step.op === 'wait' && count(step.text, step.selector, step.gone, step.url_contains, step.ms) !== 1) {
      issue('wait needs exactly one of text, selector, gone, url_contains or ms.');
    }
    if (step.op === 'click') {
      const point = count(step.x, step.y);
      if (point === 1) issue('click needs both x and y.');
      if (point === 2 && count(step.selector, step.text, step.role) > 0) issue('click takes a point or a locator, not both.');
      if (point === 0 && count(step.selector, step.text) !== 1) issue('click needs a selector, visible text, or x and y.');
    }
    if (step.op === 'exists' && count(step.selector, step.text) !== 1) issue('exists needs a selector or visible text.');
    if ((step.op === 'fill' || step.op === 'select') && count(step.selector, step.label) !== 1) {
      issue(`${step.op} needs a selector or a field label.`);
    }
    if (step.op === 'scroll' && count(step.selector, step.to, step.by) !== 1) issue('scroll needs exactly one of selector, to or by.');
  });
});

export type ScriptInput = z.input<typeof ScriptSchema>;
export type ScriptRequest = z.output<typeof ScriptSchema>;

const MUTATING = new Set<ScriptStep['op']>(['click', 'fill', 'press', 'select']);
const READING = new Set<ScriptStep['op']>(['text', 'table', 'links', 'attr']);

/** True when the script presses, types or clicks, so a failure leaves an outcome to verify. */
export function scriptMutates(request: ScriptRequest): boolean {
  return request.steps.some(step => MUTATING.has(step.op));
}

/** True when the script returns page content, which is refused while a filled secret is live. */
export function scriptReadsPage(request: ScriptRequest): boolean {
  return request.steps.some(step => READING.has(step.op));
}

export interface ScriptStepResult {
  step: number;
  op: string;
  as?: string;
  value: unknown;
}

export interface ScriptResult {
  ok: boolean;
  steps_run: number;
  steps_total: number;
  duration_ms: number;
  results: ScriptStepResult[];
  truncated: boolean;
  url: string | null;
  title: string;
  /** Tabs this script opened with keep:true; they stay for read/click afterwards. */
  kept_tabs: string[];
  /** Tabs the page itself opened (a target=_blank link, a popup). Reach one with a tab step. */
  page_opened_tabs: string[];
  error?: { step: number; op: string; code: string; message: string; outcome_unknown: boolean };
}

export function scriptFailure(code: string, message: string, total = 0): ScriptResult {
  return { ok: false, steps_run: 0, steps_total: total, duration_ms: 0, results: [], truncated: false, url: null, title: '',
    kept_tabs: [], page_opened_tabs: [], error: { step: 0, op: '', code, message, outcome_unknown: false } };
}

/** Every CDP method a script can cause. Nothing here reads cookies, storage, or traffic. */
export const SCRIPT_CDP_METHODS: ReadonlySet<string> = new Set([
  'Target.createTarget', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.getTargets', 'Target.closeTarget',
  'Page.enable', 'Page.navigate', 'Page.getFrameTree', 'Page.createIsolatedWorld',
  'Emulation.setFocusEmulationEnabled',
  'Fetch.enable', 'Fetch.continueRequest', 'Fetch.failRequest',
  'Runtime.callFunctionOn', 'Runtime.releaseObject',
  'DOM.scrollIntoViewIfNeeded', 'DOM.getContentQuads', 'DOM.focus', 'DOM.resolveNode',
  // Used only to find which element carries a name. Its nodes can hold field
  // values, so nothing from a reply but the element's identity is ever used.
  'Accessibility.queryAXTree',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
]);

// --- Fixed page-side functions. Callers supply data only. -------------------

const HELPERS = `
  const visible = el => !!el && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const norm = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const matches = (value, wanted, exact) => { const have = norm(value); return !!have && (exact ? have === wanted : have.includes(wanted)); };
  // A required marker is often drawn by CSS, so the name a bot read ('First Name *') and the label text ('First Name') differ only by it.
  const bare = value => norm(value).replace(/\\s*[*:]+$/, '').trim();
  const ROLE = {
    button: 'button,[role="button"],input[type="submit"],input[type="button"]',
    link: 'a[href],[role="link"]', tab: '[role="tab"]', menuitem: '[role="menuitem"]',
    option: 'option,[role="option"]', checkbox: 'input[type="checkbox"],[role="checkbox"]',
    radio: 'input[type="radio"],[role="radio"]', heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
  };
  const clean = text => String(text || '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  const find = query => {
    let list = [];
    if (query.selector) list = [...document.querySelectorAll(query.selector)];
    else if (query.label) {
      const wanted = bare(query.label);
      for (const el of document.querySelectorAll('input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="combobox"]')) {
        const names = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'),
          ...(el.labels ? [...el.labels].map(item => item.innerText) : [])];
        for (const id of (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)) names.push(document.getElementById(id)?.innerText);
        if (wanted && names.some(name => { const have = bare(name); return !!have && (query.exact ? have === wanted : have.includes(wanted)); })) list.push(el);
      }
    } else if (query.text) {
      const wanted = norm(query.text);
      const pool = document.querySelectorAll(query.role ? ROLE[query.role]
        : 'a,button,[role],input[type="submit"],input[type="button"],summary,label,option,li,td,th,span,div,p,h1,h2,h3,h4,h5,h6');
      const hits = [...pool].filter(el => matches(el.innerText || el.value || el.getAttribute('aria-label'), wanted, query.exact));
      // The innermost match is the control; its ancestors only contain it.
      list = query.role ? hits : hits.filter(el => !hits.some(other => other !== el && el.contains(other)));
    }
    return list.filter(visible);
  };
`;

const LOCATE = `function(query) {${HELPERS}
  return find(query)[query.nth || 0] || null;
}`;

const COUNT = `function(query) {${HELPERS}
  return find(query).length;
}`;

const READ_TEXT = `function(options) {${HELPERS}
  if (!options.selector) return clean(document.body ? document.body.innerText : '');
  const found = [...document.querySelectorAll(options.selector)].filter(visible);
  if (!found.length) return null;
  return (options.all ? found.slice(0, 50) : found.slice(0, 1)).map(el => clean(el.innerText)).join('\\n');
}`;

const READ_TABLE = `function(options) {${HELPERS}
  const root = options.selector ? document.querySelector(options.selector) : document.body;
  if (!root || !visible(root)) return null;
  const kind = 'table,[role="table"],[role="grid"]';
  const table = root.matches(kind) ? root : [...root.querySelectorAll(kind)].find(visible);
  if (!table) return null;
  const rows = [];
  let more = false;
  for (const row of table.querySelectorAll('tr,[role="row"]')) {
    if (!visible(row)) continue;
    const cells = [...row.querySelectorAll('th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')].filter(visible);
    if (!cells.length) continue;
    if (rows.length >= options.max_rows) { more = true; break; }
    rows.push(cells.slice(0, 60).map(cell => clean(cell.innerText).slice(0, 2000)));
  }
  return { rows, more };
}`;

const READ_LINKS = `function(options) {${HELPERS}
  const root = options.selector ? document.querySelector(options.selector) : document.body;
  if (!root) return null;
  const wanted = options.contains ? norm(options.contains) : '';
  const out = [];
  let more = false;
  for (const link of root.querySelectorAll('a[href]')) {
    if (!visible(link)) continue;
    const text = clean(link.innerText || link.getAttribute('aria-label') || '').slice(0, 300);
    if (wanted && !norm(text).includes(wanted) && !norm(link.href).includes(wanted)) continue;
    if (out.length >= options.max) { more = true; break; }
    out.push({ text, href: String(link.href).slice(0, 2000) });
  }
  return { links: out, more };
}`;

const READ_ATTR = `function(options) {${HELPERS}
  const el = [...document.querySelectorAll(options.selector)].filter(visible)[options.nth || 0];
  if (!el) return { missing: true };
  if (options.name === 'checked' || options.name === 'disabled') return { value: !!el[options.name] };
  if (options.name === 'href' || options.name === 'src') return { value: el[options.name] ? String(el[options.name]).slice(0, 2000) : el.getAttribute(options.name) };
  const value = el.getAttribute(options.name);
  return { value: value === null ? null : String(value).slice(0, 2000) };
}`;

const PAGE_STATE = `function(options) {${HELPERS}
  const body = document.body ? document.body.innerText || '' : '';
  let selectorVisible = false, goneVisible = false;
  if (options.selector) selectorVisible = [...document.querySelectorAll(options.selector)].some(visible);
  if (options.gone) goneVisible = [...document.querySelectorAll(options.gone)].some(visible);
  return { url: location.href, title: document.title.slice(0, 300), ready: document.readyState !== 'loading',
    hasText: options.text ? body.includes(options.text) : false, selectorVisible, goneVisible };
}`;

const DOCUMENT = 'function() { return document; }';

// Turns a node the accessibility tree named into the visible element to act on.
const AS_ELEMENT = `function(kind) {${HELPERS}
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!visible(el)) return null;
  if (kind === 'fill' && !el.matches('input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]')) return null;
  if (kind === 'select' && !(el instanceof HTMLSelectElement)) return null;
  return el;
}`;

// Selects the field's current content so the insert that follows replaces it.
const SELECT_CONTENT = `function() {
  this.focus();
  if (typeof this.select === 'function') { this.select(); return true; }
  const range = document.createRange();
  range.selectNodeContents(this);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}`;

const CHOOSE_OPTION = `function(wanted) {
  if (!(this instanceof HTMLSelectElement)) return { notSelect: true };
  const norm = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const option = [...this.options].find(item => item.value === wanted)
    || [...this.options].find(item => norm(item.label || item.text) === norm(wanted));
  if (!option || option.disabled) return { missing: true };
  this.value = option.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { chosen: String(option.label || option.text).slice(0, 300) };
}`;

const SCROLL_PAGE = `function(options) {
  if (options.to === 'top') scrollTo(0, 0);
  else if (options.to === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
  else scrollBy(0, options.by);
  return true;
}`;

type LocateKind = 'click' | 'fill' | 'select' | 'scroll' | 'exists';
const AX_PREFERRED: Record<LocateKind, string[]> = {
  click: ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'option', 'switch'],
  fill: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  select: ['combobox', 'listbox'],
  scroll: [], exists: [],
};
const AX_TEXT_ROLES = new Set(['StaticText', 'InlineTextBox']);

const KEY_CODES: Record<(typeof KEYS)[number], { code: string; keyCode: number; text?: string; key?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 }, PageDown: { code: 'PageDown', keyCode: 34 }, PageUp: { code: 'PageUp', keyCode: 33 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
};

const DIALOG_MESSAGE = 'A page dialog opened and the script stopped. Its tab was left open: answer or dismiss it with the dialog tool, then continue.';

class StepFailure extends Error {
  constructor(readonly code: string, message: string, readonly dispatched = false) { super(message); }
}

interface Page { targetId: string; sessionId: string; owned: boolean; keep: boolean }

const WORLD_GONE = /context.*(destroyed|not found)|Cannot find context|No frame|Execution context was destroyed|Cannot find object/i;

/**
 * Run a validated step list against one working copy.
 *
 * The connection is this call's own: it takes a fresh ticket from the caller,
 * so the agent-browser daemon's cached ticket, selected tab and @refs are never
 * touched. Tabs the script opens are closed when it ends unless a step asked to
 * keep them; a tab it only attached to is detached and left as it was.
 */
export async function runBrowserScript(
  request: ScriptRequest,
  connection: { cdpUrl: string; caFile?: string | null },
  connect: typeof connectCdp = connectCdp,
): Promise<ScriptResult> {
  const started = Date.now();
  const deadline = started + request.timeout_ms;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  const results: ScriptStepResult[] = [];
  const pages: Page[] = [];
  const blanks = new Set<string>();
  let budget = request.max_chars;
  let truncated = false;
  let cdp: CdpConnection | undefined;
  let page: Page | undefined;
  let stepsRun = 0;
  let dialogOpen = false;
  // A dialog freezes its page, so the call that raised it never answers. This
  // settles the moment one opens instead of waiting out the script's own timer.
  let raiseDialog!: (error: StepFailure) => void;
  const dialogSeen = new Promise<never>((_, reject) => { raiseDialog = reject; });
  dialogSeen.catch(() => undefined);
  let blockedNavigation = false;
  let initialTargets = new Set<string>();
  let failure: ScriptResult['error'] | undefined;
  let last = { url: null as string | null, title: '' };

  const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
    if (!SCRIPT_CDP_METHODS.has(method)) throw new StepFailure('not_allowed', 'This browser operation is not available to scripts.');
    if (dialogOpen) throw new StepFailure('dialog_blocking', DIALOG_MESSAGE, true);
    if (Date.now() >= deadline) throw new StepFailure('timeout', 'The script ran out of time.');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([cdp!.send(method, params, sessionId), dialogSeen, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepFailure('timeout', 'The script ran out of time.')), remaining());
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };

  const current = (): Page => {
    if (!page) throw new StepFailure('no_page', 'Start with an open step, or a tab step to use a page that is already open.');
    return page;
  };

  /**
   * A script that starts without open or tab means "the page I am on". That is
   * only knowable when the working copy has a single web page; with several,
   * choosing one could act on the wrong site, so the script is refused instead.
   */
  const adoptOnlyPage = async (): Promise<void> => {
    const targets = ((await send('Target.getTargets')).targetInfos ?? []) as Array<{ targetId: string; type: string; url: string }>;
    const web = targets.filter(item => item.type === 'page' && readableUrl(item.url));
    if (web.length === 1) { page = await attach(web[0]!.targetId, false, true); return; }
    if (!web.length) throw new StepFailure('no_page', 'No web page is open in this browser. Start with an open step.');
    const names = web.slice(0, 6).map(item => { const url = new URL(item.url); return `${url.host}${url.pathname}`.slice(0, 80); });
    throw new StepFailure('no_page', `${web.length} tabs are open (${names.join(', ')}${web.length > 6 ? ', …' : ''}). Start with a tab step naming part of the address you mean, or an open step.`);
  };

  /** Call fixed platform code in a fresh isolated world of the current page. */
  const inPage = async (declaration: string, argument: unknown, byValue = true): Promise<any> => {
    const target = current();
    for (let attempt = 0; ; attempt++) {
      try {
        const tree = await send('Page.getFrameTree', {}, target.sessionId);
        const world = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'veneer-script' }, target.sessionId);
        const evaluated = await send('Runtime.callFunctionOn', {
          functionDeclaration: declaration, executionContextId: world.executionContextId,
          arguments: [{ value: argument }], returnByValue: byValue,
        }, target.sessionId);
        if (evaluated.exceptionDetails) {
          const text = String(evaluated.exceptionDetails.exception?.description ?? '');
          if (/SyntaxError|not a valid selector/i.test(text)) throw new StepFailure('invalid_selector', 'The selector is not valid CSS.');
          throw new StepFailure('page_error', 'The page could not be read for this step.');
        }
        return evaluated.result;
      } catch (error) {
        if (error instanceof StepFailure) throw error;
        // A navigation replaces the isolated world between calls; try once more.
        if (attempt < 20 && WORLD_GONE.test(String(error)) && Date.now() < deadline) {
          await sleep(Math.min(POLL_MS, remaining()));
          continue;
        }
        throw error;
      }
    }
  };

  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  const state = async (options: Record<string, unknown> = {}): Promise<{ url: string; title: string; ready: boolean; hasText: boolean; selectorVisible: boolean; goneVisible: boolean }> => {
    const value = (await inPage(PAGE_STATE, options)).value;
    if (value?.url && value.url !== 'about:blank' && !blanks.has(value.url)) last = { url: value.url, title: value.title };
    return value;
  };

  const attach = async (targetId: string, owned: boolean, keep: boolean): Promise<Page> => {
    const existing = pages.find(item => item.targetId === targetId);
    if (existing) return existing;
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    const entry: Page = { targetId, sessionId: attached.sessionId as string, owned, keep };
    pages.push(entry);
    await send('Page.enable', {}, entry.sessionId);
    // Some pages defer rendering while hidden. Emulate focus on this target
    // without activating it, so the user's visible tab does not change.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, entry.sessionId);
    await send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, entry.sessionId);
    return entry;
  };

  const navigate = async (url: string): Promise<void> => {
    const target = current();
    blockedNavigation = false;
    const navigation = await send('Page.navigate', { url }, target.sessionId);
    if (blockedNavigation) throw new StepFailure('navigation_blocked', 'The page tried to load an address Veneer Browser does not open.');
    if (navigation.isDownload) throw new StepFailure('navigation_failed', 'That address is a download, not a page. Click its link and use the download tool.');
    if (navigation.errorText) throw new StepFailure('navigation_failed', 'The address could not be opened as a page.');
    const settleBy = Date.now() + Math.min(DEFAULT_WAIT_MS, remaining());
    while (Date.now() < settleBy) {
      const now = await state();
      if (now.ready && now.url !== 'about:blank' && !blanks.has(now.url)) return;
      await sleep(Math.min(POLL_MS, remaining()));
    }
    throw new StepFailure('timeout', 'The page did not finish loading in time.');
  };

  /**
   * Elements whose accessible name is exactly `name`, as visible element handles.
   *
   * Bots copy names from the `read` snapshot, which is this same tree, so a name
   * that includes an icon's label or a CSS-drawn required marker matches here
   * when the page text does not. Only node identity leaves the reply.
   */
  const byAccessibleName = async (name: string, role: string | undefined, kind: LocateKind): Promise<string[]> => {
    const target = current();
    try {
      const tree = await send('Page.getFrameTree', {}, target.sessionId);
      const world = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'veneer-script' }, target.sessionId);
      const root = await send('Runtime.callFunctionOn', { functionDeclaration: DOCUMENT, executionContextId: world.executionContextId, returnByValue: false }, target.sessionId);
      if (!root.result?.objectId) return [];
      const reply = await send('Accessibility.queryAXTree', { objectId: root.result.objectId, accessibleName: name, ...(role ? { role } : {}) }, target.sessionId);
      const nodes = ((reply.nodes ?? []) as Array<{ ignored?: boolean; role?: { value?: string }; backendDOMNodeId?: number }>)
        .filter(node => !node.ignored && typeof node.backendDOMNodeId === 'number');
      const controls = nodes.filter(node => !AX_TEXT_ROLES.has(String(node.role?.value)));
      // Bare text is the fallback: a clickable block with no role of its own
      // carries its name only on the text inside it.
      const pool = controls.length ? controls : nodes;
      const preferred = AX_PREFERRED[kind];
      const rank = (node: { role?: { value?: string } }): number => (preferred.includes(String(node.role?.value)) ? 0 : 1);
      const ordered = [...pool].sort((a, b) => rank(a) - rank(b)).slice(0, 30);
      const found: string[] = [];
      for (const node of ordered) {
        const resolved = await send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId, executionContextId: world.executionContextId }, target.sessionId);
        if (!resolved.object?.objectId) continue;
        const element = await send('Runtime.callFunctionOn', { functionDeclaration: AS_ELEMENT, objectId: resolved.object.objectId,
          arguments: [{ value: kind }], returnByValue: false }, target.sessionId);
        if (element.result?.subtype === 'node' && element.result.objectId) found.push(element.result.objectId as string);
      }
      return found;
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      // A navigation in the middle, or a browser without this query: not found yet.
      return [];
    }
  };

  /** Wait for the step's element: page text first, then the accessible name a bot would have read. */
  const locate = async (query: { selector?: string; text?: string; label?: string; role?: string; exact?: boolean; nth?: number },
    kind: LocateKind, waitMs = ELEMENT_WAIT_MS): Promise<string> => {
    const until = Date.now() + Math.min(waitMs, remaining());
    const name = query.text ?? query.label;
    let nextAx = 0;
    for (;;) {
      const found = await inPage(LOCATE, query, false);
      if (found.subtype === 'node' && found.objectId) return found.objectId as string;
      if (name && Date.now() >= nextAx) {
        nextAx = Date.now() + AX_INTERVAL_MS;
        const named = await byAccessibleName(name, query.role, kind);
        if (named[query.nth ?? 0]) return named[query.nth ?? 0]!;
      }
      if (Date.now() >= until) throw new StepFailure('not_found', `No visible element matched this ${kind} step.`);
      await sleep(Math.min(POLL_MS, remaining()));
    }
  };

  /** Wait for a reading step's element to appear, so a read right after a click sees the new page. */
  const read = async (declaration: string, options: Record<string, unknown>, missing: (value: any) => boolean, what: string, waitMs = ELEMENT_WAIT_MS): Promise<any> => {
    const until = Date.now() + Math.min(waitMs, remaining());
    for (;;) {
      const value = (await inPage(declaration, options)).value;
      if (!missing(value)) return value;
      if (Date.now() >= until) throw new StepFailure('not_found', `No visible element matched this ${what} step.`);
      await sleep(Math.min(POLL_MS, remaining()));
    }
  };

  const center = async (objectId: string): Promise<{ x: number; y: number }> => {
    const target = current();
    await send('DOM.scrollIntoViewIfNeeded', { objectId }, target.sessionId);
    const quads = (await send('DOM.getContentQuads', { objectId }, target.sessionId)).quads as number[][] | undefined;
    const quad = quads?.find(points => points.length === 8);
    if (!quad) throw new StepFailure('not_clickable', 'The element has no visible area to click.');
    return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
  };

  const clickAt = async (x: number, y: number): Promise<void> => {
    const target = current();
    const point = { x, y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, target.sessionId);
    try {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point }, target.sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point }, target.sessionId);
    } catch (error) {
      // The press may have landed even though its reply did not arrive.
      throw new StepFailure(error instanceof StepFailure ? error.code : 'browser_error',
        error instanceof StepFailure ? error.message : 'The click could not be confirmed.', true);
    }
  };

  const press = async (key: (typeof KEYS)[number]): Promise<void> => {
    const target = current();
    const info = KEY_CODES[key];
    const base = { key: info.key ?? key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
    try {
      await send('Input.dispatchKeyEvent', { type: info.text ? 'keyDown' : 'rawKeyDown', ...base, ...(info.text ? { text: info.text } : {}) }, target.sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, target.sessionId);
    } catch (error) {
      throw new StepFailure(error instanceof StepFailure ? error.code : 'browser_error',
        error instanceof StepFailure ? error.message : 'The key press could not be confirmed.', true);
    }
  };

  /** Spend output budget on a string; every value returned to the agent passes through here. */
  const clip = (text: string, limit = budget): string => {
    const allowed = Math.max(0, Math.min(limit, budget));
    const out = text.length > allowed ? text.slice(0, allowed) : text;
    if (out.length < text.length) truncated = true;
    budget -= out.length;
    return out;
  };

  const record = (index: number, step: ScriptStep, value: unknown): void => {
    const name = 'as' in step ? step.as : undefined;
    results.push({ step: index + 1, op: step.op, ...(name ? { as: name } : {}), value });
  };

  const execute = async (step: ScriptStep, index: number): Promise<void> => {
    if (!page && step.op !== 'open' && step.op !== 'tab') await adoptOnlyPage();
    switch (step.op) {
      case 'open': {
        const blank = `about:blank#veneer-script-${randomUUID()}`;
        blanks.add(blank);
        const created = await send('Target.createTarget', { url: blank, background: true });
        if (!created.targetId) throw new StepFailure('browser_error', 'Could not open a tab for this script.');
        page = await attach(created.targetId as string, true, step.keep === true);
        await navigate(step.url);
        return;
      }
      case 'tab': {
        const targets = ((await send('Target.getTargets')).targetInfos ?? []) as Array<{ targetId: string; type: string; url: string }>;
        const hits = targets.filter(item => item.type === 'page' && item.url.includes(step.url_contains));
        if (hits.length !== 1) {
          throw new StepFailure(hits.length ? 'ambiguous_tab' : 'tab_not_found', hits.length
            ? `${hits.length} open tabs match; give a longer part of the address.` : 'No open tab matches that address.');
        }
        if (!readableUrl(hits[0]!.url)) throw new StepFailure('tab_not_found', 'That tab is not a web page a script can use.');
        page = await attach(hits[0]!.targetId, false, true);
        await state();
        return;
      }
      case 'goto':
        current();
        await navigate(step.url);
        return;
      case 'wait': {
        if (step.ms !== undefined) { await sleep(Math.min(step.ms, remaining())); return; }
        const until = Date.now() + Math.min(step.timeout_ms ?? DEFAULT_WAIT_MS, remaining());
        for (;;) {
          const now = await state({ text: step.text, selector: step.selector, gone: step.gone });
          if (step.text ? now.hasText : step.selector ? now.selectorVisible : step.gone ? !now.goneVisible
            : now.url.includes(step.url_contains!)) return;
          if (Date.now() >= until) throw new StepFailure('wait_timeout', 'The page did not reach the awaited state in time.');
          await sleep(Math.min(POLL_MS, remaining()));
        }
      }
      case 'click': {
        if (step.x !== undefined && step.y !== undefined) { current(); await clickAt(step.x, step.y); return; }
        const query = { selector: step.selector, text: step.text, role: step.role, exact: step.exact, nth: step.nth };
        let objectId: string;
        try { objectId = await locate(query, 'click', step.timeout_ms ?? (step.optional ? OPTIONAL_WAIT_MS : ELEMENT_WAIT_MS)); }
        catch (error) {
          if (step.optional && error instanceof StepFailure && error.code === 'not_found') { record(index, step, 'skipped'); return; }
          throw error;
        }
        const point = await center(objectId);
        await clickAt(point.x, point.y);
        return;
      }
      case 'fill': {
        const target = current();
        const objectId = await locate({ selector: step.selector, label: step.label, exact: step.exact, nth: step.nth }, 'fill', step.timeout_ms);
        await send('DOM.scrollIntoViewIfNeeded', { objectId }, target.sessionId);
        await send('DOM.focus', { objectId }, target.sessionId);
        await send('Runtime.callFunctionOn', { functionDeclaration: SELECT_CONTENT, objectId, returnByValue: true }, target.sessionId);
        try {
          if (step.value) await send('Input.insertText', { text: step.value }, target.sessionId);
          else await press('Backspace');
        } catch (error) {
          throw new StepFailure(error instanceof StepFailure ? error.code : 'browser_error',
            error instanceof StepFailure ? error.message : 'The text entry could not be confirmed.', true);
        }
        if (step.submit) await press('Enter');
        return;
      }
      case 'press':
        current();
        await press(step.key);
        return;
      case 'select': {
        const target = current();
        const objectId = await locate({ selector: step.selector, label: step.label, exact: step.exact, nth: step.nth }, 'select', step.timeout_ms);
        const chosen = (await send('Runtime.callFunctionOn', {
          functionDeclaration: CHOOSE_OPTION, objectId, arguments: [{ value: step.option }], returnByValue: true,
        }, target.sessionId)).result?.value;
        if (chosen?.notSelect) throw new StepFailure('not_a_select', 'That element is not a drop-down list. Click it and then click the option.');
        if (!chosen?.chosen) throw new StepFailure('not_found', 'The drop-down has no such option.');
        return;
      }
      case 'scroll': {
        if (step.selector) {
          const objectId = await locate({ selector: step.selector }, 'scroll', step.timeout_ms);
          await send('DOM.scrollIntoViewIfNeeded', { objectId }, current().sessionId);
        } else await inPage(SCROLL_PAGE, { to: step.to, by: step.by });
        return;
      }
      case 'text': {
        const value = await read(READ_TEXT, { selector: step.selector, all: step.all }, found => found === null || found === undefined, 'text', step.timeout_ms);
        record(index, step, clip(String(value), step.max_chars ?? budget));
        return;
      }
      case 'table': {
        const value = await read(READ_TABLE, { selector: step.selector, max_rows: step.max_rows ?? 200 }, found => !found, 'table', step.timeout_ms);
        const rows: string[][] = [];
        for (const row of value.rows as string[][]) {
          if (budget <= 0) { truncated = true; break; }
          rows.push(row.map(cell => clip(cell)));
        }
        if (value.more) truncated = true;
        record(index, step, rows);
        return;
      }
      case 'links': {
        const value = await read(READ_LINKS, { selector: step.selector, contains: step.contains, max: step.max ?? 50 }, found => !found, 'links', step.timeout_ms);
        const links: Array<{ text: string; href: string }> = [];
        for (const link of value.links as Array<{ text: string; href: string }>) {
          if (budget <= 0) { truncated = true; break; }
          links.push({ text: clip(link.text), href: clip(link.href) });
        }
        if (value.more) truncated = true;
        record(index, step, links);
        return;
      }
      case 'attr': {
        const value = await read(READ_ATTR, { selector: step.selector, name: step.name, nth: step.nth }, found => !found || found.missing, 'attr', step.timeout_ms);
        record(index, step, typeof value.value === 'string' ? clip(value.value) : value.value);
        return;
      }
      case 'exists': {
        let total = (await inPage(COUNT, { selector: step.selector, text: step.text, role: step.role, exact: step.exact })).value as number;
        if (!total && step.text) total = (await byAccessibleName(step.text, step.role, 'exists')).length;
        record(index, step, total > (step.nth ?? 0));
        return;
      }
      case 'url': {
        const now = await state();
        record(index, step, { url: clip(now.url), title: clip(now.title) });
        return;
      }
    }
  };

  try {
    cdp = await connect(connection.cdpUrl, { caFile: connection.caFile, timeoutMs: Math.min(15_000, remaining()), maxPayloadBytes: 8 * 1024 * 1024 });
    cdp.on(event => {
      const owner = pages.find(item => item.sessionId === event.sessionId);
      if (!owner) return;
      if (event.method === 'Page.javascriptDialogOpening') {
        dialogOpen = true;
        // Closing the tab would discard the dialog and whatever it was guarding.
        owner.keep = true;
        raiseDialog(new StepFailure('dialog_blocking', DIALOG_MESSAGE, true));
        return;
      }
      if (event.method !== 'Fetch.requestPaused') return;
      // Documents may only come from addresses navigate itself would open. Assets
      // and API calls are not intercepted: this is not traffic capture.
      const allowed = readableUrl(String(event.params.request?.url ?? ''));
      if (!allowed) blockedNavigation = true;
      cdp!.post(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId: event.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}),
      }, event.sessionId);
    });
    const before = ((await send('Target.getTargets')).targetInfos ?? []) as Array<{ targetId: string; type: string }>;
    initialTargets = new Set(before.filter(item => item.type === 'page').map(item => item.targetId));
    for (let index = 0; index < request.steps.length; index++) {
      const step = request.steps[index]!;
      try {
        await execute(step, index);
        stepsRun = index + 1;
      } catch (error) {
        const known = error instanceof StepFailure ? error : null;
        const code = dialogOpen ? 'dialog_blocking' : known?.code ?? 'browser_error';
        // Raw CDP errors can carry control addresses or page content. Never return them.
        const message = dialogOpen ? DIALOG_MESSAGE
          : known?.message ?? 'The browser could not complete this step.';
        // A press or keystroke that was sent, or any fault after one in this
        // step, may have taken effect even though it was not confirmed.
        const unknown = MUTATING.has(step.op) && (known ? known.dispatched || code === 'timeout' : true);
        failure = { step: index + 1, op: step.op, code, message, outcome_unknown: unknown };
        break;
      }
    }
    if (!failure && page && !dialogOpen) await state().catch(() => undefined);
  } catch {
    failure = { step: stepsRun + 1, op: request.steps[stepsRun]?.op ?? '', code: 'browser_error',
      message: 'The browser could not start this script.', outcome_unknown: false };
  }

  const keptTabs: string[] = [];
  const pageOpened: string[] = [];
  let cleaned = true;
  if (cdp && !cdp.closed) {
    let timer: NodeJS.Timeout | undefined;
    try {
      cleaned = await Promise.race([
        (async () => {
          const targets = ((await cdp!.send('Target.getTargets')).targetInfos ?? []) as Array<{ targetId: string; type: string; url: string }>;
          let ok = true;
          for (const item of targets) {
            if (item.type !== 'page') continue;
            const mine = pages.find(entry => entry.targetId === item.targetId);
            // A lost creation reply must not orphan a tab: the unique blank
            // address identifies a tab only this script could have made.
            if ((mine?.owned && !mine.keep) || (!mine && blanks.has(item.url))) {
              const closed = await cdp!.send('Target.closeTarget', { targetId: item.targetId }).catch(() => ({ success: false }));
              if (closed.success !== true) ok = false;
            } else if (mine?.owned) keptTabs.push(item.url.slice(0, 500));
            else if (!mine && !initialTargets.has(item.targetId) && readableUrl(item.url)) pageOpened.push(item.url.slice(0, 500));
          }
          for (const entry of pages) {
            if (entry.owned && !entry.keep) continue;
            await cdp!.send('Target.detachFromTarget', { sessionId: entry.sessionId }).catch(() => undefined);
          }
          return ok;
        })().catch(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  } else if (pages.some(entry => entry.owned && !entry.keep)) cleaned = false;
  cdp?.close();
  if (!cleaned && !failure) {
    failure = { step: stepsRun, op: '', code: 'cleanup_failed', message: 'A tab this script opened could not be closed. List tabs before continuing.', outcome_unknown: false };
  }
  return {
    ok: !failure, steps_run: stepsRun, steps_total: request.steps.length, duration_ms: Date.now() - started,
    results, truncated, url: last.url, title: last.title, kept_tabs: keptTabs.slice(0, 10), page_opened_tabs: pageOpened.slice(0, 10),
    ...(failure ? { error: failure } : {}),
  };
}
