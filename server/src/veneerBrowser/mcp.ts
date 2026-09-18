import fs from 'node:fs';
import type http from 'node:http';
import type Database from 'better-sqlite3';
import { isMacOS } from '../platform.js';
import { resolveAgentTokenContext } from '../runtime/agentTokens.js';
import type { SecretAccessDeps } from '../secrets/readSecret.js';
import type { VeneerBrowserManager, VeneerBrowserSessionView } from './manager.js';
import { pointerCommands, pointerSummary } from './pointer.js';
import {
  assertNoSecretReadback,
  clearSecretFields,
  fillSecretTool,
  fillEmailCodeTool,
  fillSmsCodeTool,
  fillTotpTool,
  MAX_SMS_WAIT_SECONDS,
  type SecretToolDeps,
} from './secretFill.js';
import { MAX_EMAIL_WAIT_SECONDS, type EmailCodeSource } from './emailCode.js';
import {
  appendTabList,
  listBrowserTabs,
  parseTabList,
  reuseOrOpenTab,
  urlsMatchExactly,
  type BrowserTab,
  type RunBrowserCommand,
  type TabRunResult,
} from './tabReuse.js';

interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }
type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
const TOOLS: ToolDef[] = [
  { name: 'fetch_url', description: 'Read a URL in one call using this chat browser profile. Loads a temporary background tab, waits for rendered text and optional readiness conditions, returns JSON with text, tables, final_url, fetched_at, truncation and errors, then closes the tab. For SPAs specify wait_for text, CSS selector, or min_rows (includes headers). Reads rendered DOM, not raw API JSON; does not scroll virtualized tables. Cross-origin top-level redirects are refused. Page timeout is separate from browser startup. For recurring local scripts without an AI turn, use scripts/veneer-browser-fetch.mjs; it uses existing local runner authentication.', inputSchema: { type: 'object', properties: { url: { type: 'string', maxLength: 4000 }, wait_for: { type: 'object', properties: { selector: { type: 'string', maxLength: 500 }, text: { type: 'string', maxLength: 1000 }, min_rows: { type: 'integer', minimum: 1, maximum: 1000 } }, additionalProperties: false }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 60000 }, max_chars: { type: 'integer', minimum: 100, maximum: 200000 } }, required: ['url'], additionalProperties: false } },
  { name: 'list', description: 'List the reusable Veneer Browser profiles available to this chat.', inputSchema: EMPTY },
  { name: 'create', description: 'Create a reusable browser profile for this chat scope. Use only when the user asks for a new profile.', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['name'], additionalProperties: false } },
  { name: 'select', description: 'Select a saved login base for this chat. Veneer makes an isolated temporary working copy when you open it.', inputSchema: { type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id'], additionalProperties: false } },
  { name: 'open', description: 'Open an isolated temporary working copy of the selected or default saved profile. If no saved profile exists, open a temporary signed-out browser. After open, the result lists every tab. If url is present, switch to an existing matching tab when possible, otherwise open a new tab. Do not use a loopback URL such as localhost because this browser runs on a separate virtual machine.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } },
  { name: 'fresh', description: 'Open a temporary signed-out browser. Use only when the user explicitly needs a login page or a session without saved logins. The browser is not saved. After open, the result lists every tab. If url is present, switch to an existing matching tab when possible, otherwise open a new tab.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } },
  { name: 'navigate', description: 'Go to a network-accessible HTTP or HTTPS address. Lists tabs first and switches to an existing matching tab when possible. Otherwise opens a new tab so the current page is not replaced. Do not use a loopback URL such as localhost because this browser runs on a separate virtual machine.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'click', description: 'Click an element reference from a recent read result, such as @e1. Use click_at with screenshot coordinates when a ref cannot reach the element.', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } },
  { name: 'type', description: 'Type text into an element reference. Never type a password, token, or code here: use fill_secret for a stored credential and fill_totp for a 2-step code, and never ask the user to send a secret in chat.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'], additionalProperties: false } },
  { name: 'read', description: 'Read the current page as an interactive accessibility snapshot. This can include page text, so do not expose private content unless the user asks.', inputSchema: EMPTY },
  { name: 'fill', description: 'Clear an element reference such as @e1 and fill it with text. Use type to append instead of replacing. Never pass a password, token, or code here; use fill_secret / fill_totp.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'], additionalProperties: false } },
  { name: 'fill_secret', description: 'Enter a credential stored in Doppler into a field, without the value ever reaching you. Name the secret (SCREAMING_SNAKE_CASE); Veneer reads it on this machine, clears the field, and types it. The value never appears in your arguments, the result, the chat, or any log, so you cannot read it back afterwards. Use this for every stored password, API key, or token instead of type/fill. Set submit to press Enter in the same step. Refused while Advanced capture is on, because network capture would record the submitted form. If the secret does not exist yet, collect it with request_secret first. On the main Pro instance name the Doppler project and config; a client instance uses its one connected config and ignores both.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, secret_name: { type: 'string', minLength: 1, maxLength: 200 }, project: { type: 'string', minLength: 1, maxLength: 100 }, config: { type: 'string', minLength: 1, maxLength: 100 }, submit: { type: 'boolean' } }, required: ['target', 'secret_name'], additionalProperties: false } },
  { name: 'fill_totp', description: 'Enter a current 6-digit authenticator code into a 2-step verification field. Name the Doppler secret that holds the TOTP seed (bare base32 key or a full otpauth:// URI); Veneer computes the code here and types it, and neither the seed nor the code reaches you. A code close to expiry is held back until the next one. Allowed while Advanced capture is on, because the code is single-use and expires in seconds. Set submit to press Enter in the same step. If there is no stored seed, ask the user for the authenticator app\'s "can\'t scan? enter key manually" key with request_secret. On the main Pro instance name the Doppler project and config; a client instance uses its one connected config and ignores both.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, secret_name: { type: 'string', minLength: 1, maxLength: 200 }, project: { type: 'string', minLength: 1, maxLength: 100 }, config: { type: 'string', minLength: 1, maxLength: 100 }, submit: { type: 'boolean' } }, required: ['target', 'secret_name'], additionalProperties: false } },
  { name: 'press', description: 'Press a key at the current focus, such as Enter, Tab, Escape, or Control+a. Use after type to submit a form.', inputSchema: { type: 'object', properties: { key: { type: 'string', minLength: 1 } }, required: ['key'], additionalProperties: false } },
  { name: 'hover', description: 'Hover an element reference from a recent read result, such as @e1. Use to open menus that appear on hover.', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } },
  { name: 'scroll', description: 'Scroll the page in a direction, or scroll an element reference such as @e1 into view.', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pixels: { type: 'integer', minimum: 1, maximum: 100000 }, into_view: { type: 'string' } }, additionalProperties: false } },
  { name: 'wait', description: 'Wait for an element reference such as @e1, for page text, for a URL pattern, or for a load state. Read again afterwards because refs go stale.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' }, load: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] }, ms: { type: 'integer', minimum: 1, maximum: 60000 } }, additionalProperties: false } },
  { name: 'find', description: 'Locate an element by role, text, label, placeholder, alt, title, or test id and act on it. Use when @e refs are stale or a read is too large. Never pass a password, token, or code here; use fill_secret / fill_totp.', inputSchema: { type: 'object', properties: { locator: { type: 'string', enum: ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth'] }, value: { type: 'string', minLength: 1 }, action: { type: 'string', enum: ['click', 'fill', 'type', 'hover', 'focus', 'check', 'uncheck'] }, text: { type: 'string' }, name: { type: 'string' }, index: { type: 'integer', minimum: 0 }, exact: { type: 'boolean' } }, required: ['locator', 'value'], additionalProperties: false } },
  { name: 'back', description: 'Go back one page in browser history.', inputSchema: EMPTY },
  { name: 'forward', description: 'Go forward one page in browser history.', inputSchema: EMPTY },
  { name: 'reload', description: 'Reload the current page.', inputSchema: EMPTY },
  { name: 'tab', description: 'List tabs, open a new tab, switch to a tab, or close one. Tab ids look like t1 and t2. Read again after switching because @e refs belong to one tab.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] }, tab: { type: 'string' }, url: { type: 'string' }, label: { type: 'string' } }, additionalProperties: false } },
  { name: 'screenshot', description: 'Capture the current page. The image is saved in the project and returned to the agent. A non-full capture is the viewport, and its pixels are the coordinates click_at, hover_at, and scroll_at take.', inputSchema: { type: 'object', properties: { full: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'click_at', description: 'Click at viewport pixel coordinates from a fresh screenshot. Fallback for cross-origin iframes, canvas, or shadow DOM where @e refs fail. Take a non-full screenshot first; its pixels map 1:1 to coordinates.', inputSchema: { type: 'object', properties: { x: { type: 'integer', minimum: 0, maximum: 20000 }, y: { type: 'integer', minimum: 0, maximum: 20000 }, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'hover_at', description: 'Move the pointer to viewport pixel coordinates from a fresh screenshot. Use for hover menus and canvas tooltips that @e refs cannot reach.', inputSchema: { type: 'object', properties: { x: { type: 'integer', minimum: 0, maximum: 20000 }, y: { type: 'integer', minimum: 0, maximum: 20000 } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'scroll_at', description: 'Scroll the wheel over viewport pixel coordinates from a fresh screenshot. Use for an inner scroll area, a map, or an embedded iframe that the scroll tool does not move. Positive dy scrolls down.', inputSchema: { type: 'object', properties: { x: { type: 'integer', minimum: 0, maximum: 20000 }, y: { type: 'integer', minimum: 0, maximum: 20000 }, dy: { type: 'integer', minimum: -20000, maximum: 20000 }, dx: { type: 'integer', minimum: -20000, maximum: 20000 } }, required: ['x', 'y', 'dy'], additionalProperties: false } },
  { name: 'dialog', description: 'Answer a JavaScript dialog that is blocking the selected tab. A confirm or prompt blocks the page until it is answered, so a command that timed out may be waiting on one: call status first, then accept or dismiss, and use text only to answer a prompt with accept. A dialog on a different tab cannot be answered from outside that tab, so dismiss checks which tab is frozen and closes it — even when status reports none, because status only sees the selected tab — which loses that page\'s state; to answer it instead, the user does it by hand in the live browser view.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['accept', 'dismiss', 'status'] }, text: { type: 'string' } }, required: ['action'], additionalProperties: false } },
  { name: 'run', description: 'Run a raw agent-browser command when no typed tool fits, such as ["get","title"] or ["check","@e2"]. Commands that read logins, cookies, or storage, and commands that run JavaScript, are refused. Network capture is blocked by default on the signed-in browser; if the task genuinely needs traffic inspection (for example reverse-engineering an API), ask the user to enable "Advanced capture" for this chat in the browser panel.', inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 } }, required: ['args'], additionalProperties: false } },
  { name: 'download', description: 'Move safe browser downloads into the current project Files area.', inputSchema: EMPTY },
  { name: 'status', description: 'Get safe lifecycle status for the selected project browser profile. When the browser is active, the result also lists every tab.', inputSchema: EMPTY },
  { name: 'update_profile', description: 'Replace the selected saved profile with this working copy. Use only after the user or agent intentionally completed a new login. Veneer does not detect logins automatically, and it blocks an older copy from replacing a newer profile.', inputSchema: EMPTY },
  { name: 'save_as', description: 'Save this working copy as an additional reusable profile. Use only when the user explicitly asks to keep a separate login.', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['name'], additionalProperties: false } },
  { name: 'stop', description: 'Stop and delete this chat working copy when the browser task is complete. Changes are discarded unless update_profile or save_as was called first.', inputSchema: EMPTY },
];

// Listed only where it can actually work, so a client instance never offers the
// agent a tool that reads a Messages database it does not have. It shares
// fillWithResolvedValue with the other two, so the probe, the single fill+Enter
// sequence, the redaction, and the readback guard are identical.
const FILL_SMS_CODE_TOOL: ToolDef = { name: 'fill_sms_code', description: 'Enter a verification code that just arrived by SMS or iMessage, read from Messages on the Veneer Pro Mac. This instance only. Use it for a 2-step prompt when fill_totp is not possible, because the site texts a code instead of using an authenticator app. Veneer looks only at messages inside max_age_seconds, waits up to wait_seconds for one to arrive, extracts the code here and types it; the message text and the code never reach you, the chat, or any log, and the filled field cannot be read back. Name the sender — a phone number, or a short code such as Amazon\'s 262966 — to ignore unrelated texts. Allowed while Advanced capture is on, because the code is single-use. Set submit to press Enter in the same step. If no code arrives, ask the user to type it in the live browser view.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, sender: { type: 'string', minLength: 1, maxLength: 100, description: 'Phone number or short code, for example 262966.' }, max_age_seconds: { type: 'integer', minimum: 1, maximum: 3600, default: 300, description: 'How old a message may be and still count.' }, wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_SMS_WAIT_SECONDS, default: 90, description: 'How long to wait for the text to arrive. 0 checks once.' }, submit: { type: 'boolean' }, pattern: { type: 'string', minLength: 1, maxLength: 200, description: 'Regular expression overriding the code shape. The default finds a 4-8 digit code, including "123-456".' } }, required: ['target'], additionalProperties: false } };

const SMS_CODE_UNAVAILABLE = 'fill_sms_code is only available on macOS.';

// Listed only when this instance has a configured code mailbox, so an agent is
// never offered a mailbox it cannot read. The mailbox itself is fixed by
// configuration; the agent narrows by sender, subject, or thread only. Same
// fillWithResolvedValue seam as the other three.
const FILL_EMAIL_CODE_TOOL: ToolDef = { name: 'fill_email_code', description: 'Enter a verification code that just arrived by EMAIL in the configured help mailbox, read server-side through the connected Gmail connector. Use it for a 2-step prompt when fill_totp and fill_sms_code are not possible, because the site emails a code. Veneer looks only at messages inside max_age_seconds, waits up to wait_seconds for one to arrive, extracts the code here and types it; the message, the subject line beyond what you named, and the code never reach you, the chat, or any log, and the filled fields cannot be read back. A message is used once: a second call never re-types the same code. Name the sender (address or domain) and a subject fragment to ignore unrelated mail. For a row of single-digit boxes pass targets (one @e ref per box, in order) instead of target; each box gets one digit. Allowed while Advanced capture is on, because the code is single-use. Set submit to press Enter in the same step. If no code arrives, ask the user to type it in the live browser view.', inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'One field that takes the whole code.' }, targets: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 12, description: 'One ref per single-digit box, in order. Use instead of target.' }, sender: { type: 'string', minLength: 1, maxLength: 200, description: 'Sender address or domain, for example shipsurance.com.' }, subject: { type: 'string', minLength: 1, maxLength: 200, description: 'Text the subject must contain.' }, thread_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Gmail thread id the message must belong to.' }, max_age_seconds: { type: 'integer', minimum: 1, maximum: 3600, default: 600, description: 'How old a message may be and still count.' }, wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_EMAIL_WAIT_SECONDS, default: 90, description: 'How long to wait for the email to arrive. 0 checks once.' }, submit: { type: 'boolean' }, pattern: { type: 'string', minLength: 1, maxLength: 200, description: 'Regular expression overriding the code shape. The default finds a 4-8 digit code, including "123-456".' } }, additionalProperties: false } };

const EMAIL_CODE_UNAVAILABLE = 'fill_email_code is not configured on this instance: no code mailbox is set.';

// All four read something only an administrator may reach: fill_secret and
// fill_totp read Doppler, which every Doppler route 403s a member out of,
// fill_sms_code reads the operator's personal Messages database, and
// fill_email_code reads the shared help mailbox.
const CREDENTIAL_TOOLS = new Set(['fill_secret', 'fill_totp', 'fill_sms_code', 'fill_email_code']);

const CREDENTIAL_TOOLS_MEMBER_REFUSAL =
  'Entering a stored credential or a texted code needs Doppler and device access this account does not have. '
  + 'Ask the user to sign in themselves in the live browser view, or to have an administrator run this step. Never ask them to paste a secret into chat.';

/**
 * fill_sms_code reads the interactive user's own Messages database, so it needs
 * both the Mac that holds it and an actor entitled to the operator's messages.
 */
function smsCodeAvailable(secrets: SecretAccessDeps | undefined, memberActor: boolean): boolean {
  return Boolean(secrets) && isMacOS() && !memberActor;
}

/** fill_email_code needs a configured mailbox source and an actor entitled to read it. */
function emailCodeAvailable(emailCodes: EmailCodeSource | undefined, memberActor: boolean): boolean {
  return Boolean(emailCodes) && !memberActor;
}

function listedTools(smsAvailable: boolean, emailAvailable: boolean, memberActor: boolean): ToolDef[] {
  const base = memberActor ? TOOLS.filter((tool) => !CREDENTIAL_TOOLS.has(tool.name)) : TOOLS;
  const after = base.findIndex((tool) => tool.name === 'fill_totp') + 1;
  // In the order the agent should try them: totp, then sms, then email.
  const extra = [...(smsAvailable ? [FILL_SMS_CODE_TOOL] : []), ...(emailAvailable ? [FILL_EMAIL_CODE_TOOL] : [])];
  if (!extra.length) return base;
  return [...base.slice(0, after), ...extra, ...base.slice(after)];
}

// Served once, at initialize, so the agent knows the handful of things this
// browser does differently before it has failed at them: which handles expire,
// how tabs are reused, what a blocking dialog looks like from out here, and the
// coordinate fallback for pages a snapshot cannot describe.
const INSTRUCTIONS = [
  'Veneer Browser drives the user\'s real signed-in browser on a separate virtual machine, so a loopback URL such as localhost is never reachable from it.',
  'Element refs like @e1 come from read and expire on navigation, reload, tab switch, and any session restart. Read again instead of reusing an old ref; an error that mentions the session restarting means list tabs first, then read.',
  'navigate switches to a tab whose URL matches exactly and otherwise opens a new tab, so the page you are on is not replaced.',
  'A confirm or prompt dialog blocks its page until it is answered, so a command that timed out may be waiting on one: call dialog status, then accept or dismiss. A dialog on a different tab that cannot be switched to is unreachable (browser limitation): dialog dismiss will close that tab for you after confirming it is stuck, and it does that even when dialog status reports nothing, because status only sees the selected tab; the closed page\'s state is lost. To answer such a dialog instead, the user can do it by hand in the live browser view.',
  'When refs cannot reach an element — a cross-origin iframe, a canvas, or shadow DOM, and a snapshot inlines only one level of iframe nesting — take a fresh non-full screenshot and use click_at, hover_at, or scroll_at on its pixels.',
  'Signing in: a stored password or API key goes in with fill_secret, naming the Doppler secret — the value never enters chat, your arguments, or the result, and the filled field cannot be read back. For a 2-step prompt, try these in order: fill_totp (a Doppler secret holding the TOTP seed or otpauth:// URI); then fill_sms_code, which reads a texted code out of Messages and is listed only on the Pro Mac instance; then fill_email_code, which reads an emailed code out of the configured help mailbox and is listed only where one is set up (pass targets for a row of one-digit boxes); and only then ask the user to type the code in the live browser view. Never pass a secret to type, fill, or find, and never ask the user to paste one in chat. When there is no stored password, collect it with request_secret, and collect a TOTP seed with a second request_secret (the user gets it from the authenticator app\'s "can\'t scan? enter key manually" option).',
  'Use find when refs have gone stale or a snapshot would be huge, and read when you need the whole page.',
  'To keep a file, click its download link in the page and then call download to import it into the project.',
].join('\n\n');

function sessionText(view: VeneerBrowserSessionView, captureActive = false): string {
  if (!view.configured) return 'Veneer Browser is not configured on this client.';
  return [
    `Veneer Browser is ${view.active ? 'active' : view.status}.`,
    `Profile: ${view.profileName ?? 'none'}.`,
    `Advanced capture: ${captureActive ? 'on' : 'off'}.`,
    view.temporaryClone
      ? view.fresh
        ? 'This is a temporary signed-out browser. Call save_as only if the user explicitly asks for a new saved login. Otherwise, call stop to delete it.'
        : 'This chat is using a temporary working copy. Call update_profile only after an intentional new login. Otherwise, call stop to delete the copy.'
      : view.profileId
        ? 'Opening it will make an isolated temporary working copy. The saved profile will stay unchanged.'
        : 'No saved profile exists. Opening the browser will make a temporary signed-out copy.',
  ].join('\n');
}

function textResult(value: string, isError = false): { content: ToolContent[]; isError?: boolean } {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 1024 * 1024) throw new Error('MCP request is too large.');
  }
  if (!raw) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP request.');
  return value as Record<string, unknown>;
}

/**
 * Agent Browser's daemon is the per-working-copy broker. The manager and runner
 * both serialize access to its stable name, so tab aliases, the selected tab,
 * and @refs survive across these otherwise separate MCP calls. The daemon is
 * closed when its temporary working copy stops.
 */

// Network capture is the one blocked command a user can unlock, and only the
// authenticated user can do it — over HTTP, per chat, per working copy (see
// VeneerBrowserManager.setCaptureGrant). No MCP tool grants it, because the
// agent may be reading an attacker-controlled page: a page that could talk the
// agent into unlocking traffic inspection would defeat the block entirely.
const CAPTURE_REFUSAL =
  'Network capture is blocked by default on the signed-in browser. If the task genuinely needs traffic inspection (for example reverse-engineering an API), ask the user to enable "Advanced capture" for this chat in the browser panel.';

// Veneer Browser holds the user's real logged-in sessions, so the escape hatch is
// narrower than the general agent-browser tool. Arbitrary JavaScript, cookie jars,
// web storage, saved auth state, the clipboard, and network capture are all
// exfiltration-grade against a signed-in profile: one command could lift a session
// token out of the browser and into chat. The normalize layer in
// src/mcp/agentBrowser.ts blocks its own set; this list is checked first and
// deliberately repeats it so a change there cannot silently widen Veneer Browser.
const VENEER_BLOCKED_COMMANDS = new Set([
  // Reads or writes the signed-in session itself.
  'auth', 'clipboard', 'cookies', 'state', 'storage',
  // Runs agent-supplied JavaScript in a signed-in page.
  'addinitscript', 'eval', 'evaluate', 'js', 'removeinitscript',
  // Captures request traffic, including authenticated headers and bodies.
  'network',
  // Chains commands, which would smuggle any of the above past this check.
  'batch',
  // Mirrors BLOCKED_COMMANDS in src/mcp/agentBrowser.ts.
  'chat', 'connect', 'dashboard', 'download', 'install', 'inspect', 'profiles',
  'profiler', 'record', 'session', 'skills', 'stream', 'trace', 'upgrade', 'upload',
]);

// `wait --fn` (short form `-f`) evaluates JavaScript, so it is the one flag that
// smuggles script execution into an otherwise safe command.
function hasWaitFunctionFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--fn' || arg.startsWith('--fn=') || arg === '-f');
}

export interface VeneerRunOptions {
  /** Set only from a manager grant the authenticated user made for this chat. */
  captureGranted?: boolean;
}

export function assertVeneerRunArgs(input: unknown, options: VeneerRunOptions = {}): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('args must be a non-empty array, for example ["get", "title"].');
  }
  const args = input.map((value) => {
    if (typeof value !== 'string' || !value) throw new Error('Every browser argument must be a non-empty string.');
    return value;
  });
  const command = args[0]!.toLowerCase();
  if (command.startsWith('-')) {
    throw new Error('The first argument must be an agent-browser command, such as "get" or "click".');
  }
  if (command === 'network') {
    // A grant opens `network` only. `network har` writes arbitrary host paths and
    // stays blocked by normalizeAgentBrowserArgs in src/mcp/agentBrowser.ts.
    if (!options.captureGranted) throw new Error(CAPTURE_REFUSAL);
  } else if (VENEER_BLOCKED_COMMANDS.has(command)) {
    throw new Error(`The agent-browser command "${command}" is not available in Veneer Browser because it runs on the user's signed-in browser.`);
  }
  if (command === 'wait' && hasWaitFunctionFlag(args)) {
    throw new Error('wait --fn is not available in Veneer Browser because it runs JavaScript in the user\'s signed-in page.');
  }
  return args;
}

function requireArg(value: unknown, message: string): string {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!text) throw new Error(message);
  return text;
}

function waitCommand(args: Record<string, unknown>): string[] {
  if (args.target) return ['wait', String(args.target)];
  if (args.text) return ['wait', '--text', String(args.text)];
  if (args.url) return ['wait', '--url', String(args.url)];
  if (args.load) return ['wait', '--load', String(args.load)];
  if (args.ms !== undefined && args.ms !== null) return ['wait', String(Math.trunc(Number(args.ms)))];
  throw new Error('wait needs one of target, text, url, load, or ms.');
}

function findCommand(args: Record<string, unknown>): string[] {
  const locator = requireArg(args.locator, 'find needs a locator such as role, text, or testid.');
  const value = requireArg(args.value, 'find needs a value to look for.');
  const action = String(args.action ?? 'click');
  const position = locator === 'nth' ? [requireArg(args.index, 'find nth needs an index.')] : [];
  return [
    'find', locator, ...position, value, action,
    ...(args.text ? [String(args.text)] : []),
    ...(args.name ? ['--name', String(args.name)] : []),
    ...(args.exact === true ? ['--exact'] : []),
  ];
}

const DIALOG_ACTIONS = new Set(['accept', 'dismiss', 'status']);

function dialogCommand(args: Record<string, unknown>): string[] {
  const action = String(args.action ?? '').trim().toLowerCase();
  if (!DIALOG_ACTIONS.has(action)) throw new Error('dialog needs an action of accept, dismiss, or status.');
  const text = args.text === undefined || args.text === null ? '' : String(args.text);
  if (!text) return ['dialog', action];
  if (action !== 'accept') {
    throw new Error('dialog text answers a prompt, so it is only used with accept.');
  }
  // The CLI's flag parser would read a leading dash as an option rather than as
  // the prompt answer, so it is refused here instead of silently changing shape.
  if (text.startsWith('-')) {
    throw new Error('dialog accept text cannot start with "-".');
  }
  return ['dialog', 'accept', text];
}

function tabCommand(args: Record<string, unknown>): string[] {
  const action = String(args.action ?? 'list');
  if (action === 'new') {
    return ['tab', 'new', ...(args.label ? ['--label', String(args.label)] : []), ...(args.url ? [String(args.url)] : [])];
  }
  if (action === 'switch') return ['tab', requireArg(args.tab, 'tab switch needs a tab id such as t2, or a tab label.')];
  if (action === 'close') return ['tab', 'close', ...(args.tab ? [String(args.tab)] : [])];
  return ['tab', 'list'];
}

function runner(
  manager: VeneerBrowserManager,
  userId: number,
  conversationId: string,
): (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return (args) => manager.runCommand(userId, conversationId, args);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width and height straight out of the PNG header, so the agent is told what
 * the coordinate space of the image it just received actually is. Only sound
 * for a viewport capture: a full-page capture is taller than the viewport, so
 * its vertical pixels are not click coordinates.
 */
export function pngDimensions(image: Buffer): { width: number; height: number } | null {
  if (image.length < 24 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (image.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/** The lifecycle reminder every page command carries back with its output. */
async function lifecycleText(
  manager: VeneerBrowserManager,
  userId: number,
  conversationId: string,
): Promise<string> {
  const updated = await manager.conversationSession(userId, conversationId);
  return updated.fresh
    ? 'This chat is using a temporary signed-out browser. Call stop to discard it, or save_as only if the user explicitly asks for a new saved login.'
    : 'This chat is using a temporary working copy. Call stop to discard it. Call update_profile only after an intentional new login.';
}

// A dialog on the page is invisible from out here: the command that hit it is
// SIGKILLed on Veneer's own timeout and reports nothing. The probe asks the one
// read-only question that explains that silence. The dialog's own message is
// attacker-controlled page text and is never echoed — only this fixed hint is.
const DIALOG_HINT = 'A page dialog may be blocking this page. Use the dialog tool (status/accept/dismiss) to resolve it.';

/**
 * Tools after which the document that holds a filled secret field is gone.
 *
 * `read` and `tab list` are deliberately NOT here: neither touches the page, so
 * the field still holds the secret afterwards, and a fresh snapshot of an
 * unchanged DOM hands back refs for the very same elements.
 */
const REF_INVALIDATING_TOOLS = new Set([
  'navigate', 'reload', 'fresh', 'back', 'forward', 'stop',
]);

// Tools that drive the page, and so are the ones a blocking dialog can freeze.
const INTERACTION_TOOLS = new Set([
  'click', 'click_at', 'type', 'fill', 'press', 'hover', 'hover_at', 'scroll', 'scroll_at',
  'wait', 'find', 'navigate', 'reload', 'open', 'select',
]);

/**
 * `dialog status --json` prints {"success":true,"data":{"hasDialog":…}}.
 * Anything other than a definite yes — noise after the payload, a missing
 * envelope, the string "true" — is treated as no.
 */
export function hasDialogInJson(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const data = (parsed as { data?: unknown }).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return (data as { hasDialog?: unknown }).hasDialog === true;
  } catch {
    return false;
  }
}

async function probeDialog(
  manager: VeneerBrowserManager,
  userId: number,
  conversationId: string,
): Promise<string | null> {
  if (typeof manager.probeCommand !== 'function') return null;
  try {
    const raw = await manager.probeCommand(userId, conversationId, ['dialog', 'status', '--json']);
    return hasDialogInJson(raw) ? DIALOG_HINT : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trap-aware dialog handling.
//
// agent-browser can only answer a dialog on the SELECTED tab, and only when the
// daemon session that runs the command is the one that saw the dialog open. A
// dialog on any other tab is unanswerable: switching to that tab fails because
// the tab is frozen, and no outside CDP connection can reach the dialog either.
// Closing the tab is the only exit. On top of that, a FAILED accept/dismiss
// clears the daemon's tracked dialog, so status must always be gathered before
// an answer is attempted, never after one failed.
// ---------------------------------------------------------------------------

/** The daemon's answer when the dialog it is asked about belongs to another tab. */
const DIALOG_UNREACHABLE = /no dialog is showing/i;
/** Switching to a frozen tab fails with this after the activation timeout. */
const TAB_NOT_RESPONDING = /not responding/i;
/** The warning line many commands carry while a dialog is open somewhere. */
const DIALOG_WARNING = /dialog is blocking the page/i;
/** Every tN handle the broker handed out is void once it has restarted its session. */
const HANDLE_EXPIRED = /tab handle expired|session restarted/i;
/** Only ids that came out of a parsed tab list are ever put back on a command line. */
const SAFE_TAB_ID = /^t\d+$/;
/** Every probe costs an activation timeout, so the sweep is bounded. */
const MAX_TAB_PROBES = 6;

// `dialog status` only ever sees the selected tab's session, so hasDialog:false
// does NOT rule out a background tab frozen by an unreachable dialog. Neither
// message suggests retrying: a retry would take this same path again.
const NO_DIALOG_FOR_ACCEPT = 'No dialog is open on the selected tab. A dialog on another tab cannot be accepted from outside that tab — use dialog dismiss to close the frozen tab, or the user can answer the dialog by hand in the live browser view.';
const NO_DIALOG_ANYWHERE = 'No dialog is open on the selected tab, and no other tab was frozen by one. If a page still looks stuck, the user can answer its dialog by hand in the live browser view.';
const SELECTION_MOVED = 'Checking tabs changed the selected tab, so read again before reusing @e refs.';

type DialogAnswer = 'accept' | 'dismiss';
interface DialogOutcome { text: string; isError: boolean }

function commandOutput(result: TabRunResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    || `Browser command exited ${result.exitCode}.`;
}

/** A step whose failure is information, not an answer: never rethrown. */
async function tryRun(run: RunBrowserCommand, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await run(args);
    return { ok: result.exitCode === 0, output: commandOutput(result) };
  } catch (error) {
    return { ok: false, output: (error as Error).message };
  }
}

function describeTab(tab: BrowserTab): string {
  return `tab ${tab.id}${tab.url ? ` (${tab.url})` : ''}`;
}

/**
 * Probing the frozen tab is what makes the broker restart its session, and that
 * restart expires every tN handle the first list handed out — including the
 * stuck tab's own. So the id is re-resolved against a fresh list before it is
 * put on a close command line, matched by exact URL because the URL is the only
 * thing that survives the restart. A URL that now matches no tab, or two, is
 * reported rather than guessed at: closing the wrong tab is unrecoverable.
 */
async function reresolveStuckTab(
  run: RunBrowserCommand,
  url: string,
): Promise<{ id: string | null; reason: string }> {
  if (!url.trim()) {
    return { id: null, reason: 'the frozen tab has no URL to re-identify it by after the browser session restarted' };
  }
  const listed = await tryRun(run, ['tab', 'list', '--json']);
  const matches = parseTabList(listed.output)
    .filter((tab) => (tab.url === url || urlsMatchExactly(tab.url, url)) && SAFE_TAB_ID.test(tab.id));
  if (matches.length === 1) return { id: matches[0]!.id, reason: '' };
  return {
    id: null,
    reason: matches.length === 0
      ? `the browser session restarted and no tab at ${url} is in the fresh tab list, so there is no valid handle left to close`
      : `the browser session restarted and ${matches.length} tabs now share ${url}, so the frozen one cannot be identified safely`,
  };
}

/**
 * Finds — and for dismiss, closes — a tab frozen by a dialog this session
 * cannot answer. Probing is the only way to know which tab it is: switching to
 * a healthy tab succeeds, switching to the frozen one fails.
 *
 * `failure` is the answer attempt this is recovering from, or null for the cold
 * sweep: `dialog status` only sees the selected tab's session, so a dialog on a
 * background tab reports hasDialog:false and there is nothing to attempt first.
 */
async function resolveTrappedDialog(
  run: RunBrowserCommand,
  action: DialogAnswer,
  failure: string | null,
): Promise<DialogOutcome> {
  const listed = await tryRun(run, ['tab', 'list', '--json']);
  const tabs = parseTabList(listed.output);
  const active = tabs.find((tab) => tab.current) ?? null;
  const candidates = tabs.filter((tab) => !tab.current && SAFE_TAB_ID.test(tab.id)).slice(0, MAX_TAB_PROBES);
  let stuck: BrowserTab | null = null;
  let moved = false;
  for (const tab of candidates) {
    const probe = await tryRun(run, ['tab', tab.id]);
    if (probe.ok) { moved = true; continue; }
    if (TAB_NOT_RESPONDING.test(probe.output)) { stuck = tab; break; }
  }

  if (!stuck) {
    // Nothing was closed and nothing was answered, so put the selection back.
    if (moved && active && SAFE_TAB_ID.test(active.id)) await tryRun(run, ['tab', active.id]);
    // A cold sweep that found nothing means there was nothing to find: no
    // dialog on this tab, no frozen tab behind it. That is not an error.
    if (failure === null) return { text: NO_DIALOG_ANYWHERE, isError: false };
    return {
      text: `${failure}\nNo frozen tab was identified, so the dialog could not be reached from here. Check tab list, or ask the user to answer the dialog by hand in the live browser view.`,
      isError: true,
    };
  }

  const where = describeTab(stuck);
  const note = moved ? `\n${SELECTION_MOVED}` : '';
  if (action === 'accept') {
    return {
      text: `The dialog is trapped on ${where}. Accepting it from outside its tab is impossible (an upstream agent-browser limitation). Use dialog dismiss to close that tab, or ask the user to answer the dialog by hand in the live browser view.${note}`,
      isError: true,
    };
  }

  const refused = (reason: string): DialogOutcome => (
    { text: `The dialog is trapped on ${where}, and closing that tab failed: ${reason}${note}`, isError: true }
  );
  const first = await reresolveStuckTab(run, stuck.url);
  if (!first.id) return refused(first.reason);
  let closed = await tryRun(run, ['tab', 'close', first.id]);
  // One retry only: the close itself can be the command that trips a restart,
  // and a second expiry means something other than this race is wrong.
  if (!closed.ok && HANDLE_EXPIRED.test(closed.output)) {
    const again = await reresolveStuckTab(run, stuck.url);
    if (again.id) closed = await tryRun(run, ['tab', 'close', again.id]);
  }
  // Only an exit code 0 close is ever reported as a closed tab.
  if (!closed.ok) return refused(closed.output);
  // hasDialogInJson parses the raw stdout payload, same as the pre-check
  // above; joining in stderr noise (as tryRun's combined output would) can
  // break that JSON parse and silently drop this best-effort hint.
  const verifyRaw = await run(['dialog', 'status', '--json']).then((r) => r.stdout, () => null);
  const lingering = hasDialogInJson(verifyRaw) ? '\nA dialog is still reported on the selected tab.' : '';
  return {
    text: failure === null
      ? `No dialog was open on the selected tab, but ${where} was frozen by an unreachable dialog and was closed. That page and its unsaved state are gone.${note}${lingering}`
      : `Dismissed the dialog by closing ${where}, because a dialog on another tab cannot be answered from outside it. That page and its unsaved state are gone.${note}${lingering}`,
    isError: false,
  };
}

export async function answerDialog(
  run: RunBrowserCommand,
  action: DialogAnswer,
  command: string[],
): Promise<DialogOutcome> {
  // Gathered first: a failed accept/dismiss clears the daemon's tracked dialog,
  // so asking afterwards always answers "none".
  const status = await run(['dialog', 'status', '--json']);
  const known = hasDialogInJson(status.stdout) || DIALOG_WARNING.test(commandOutput(status));
  if (!known) {
    // hasDialog:false is only ever an answer about the SELECTED tab, so it is
    // exactly the state a background-tab trap presents. dismiss can still
    // resolve that — by finding the frozen tab and closing it — while accept
    // has nothing to offer, because an unreachable dialog cannot be accepted.
    if (action === 'accept') return { text: NO_DIALOG_FOR_ACCEPT, isError: false };
    return resolveTrappedDialog(run, action, null);
  }

  const answered = await run(command);
  if (answered.exitCode === 0) return { text: commandOutput(answered), isError: false };
  const failure = commandOutput(answered);
  if (!DIALOG_UNREACHABLE.test(failure)) return { text: failure, isError: true };
  return resolveTrappedDialog(run, action, failure);
}

async function sessionTextWithTabs(
  manager: VeneerBrowserManager,
  userId: number,
  conversationId: string,
  view: VeneerBrowserSessionView,
  captureActive: boolean,
): Promise<string> {
  const text = sessionText(view, captureActive);
  if (!view.active && view.status !== 'active') return text;
  try {
    const listed = await listBrowserTabs(runner(manager, userId, conversationId));
    return appendTabList(text, listed.tabs, listed.raw);
  } catch {
    return text;
  }
}

async function goToUrl(
  manager: VeneerBrowserManager,
  userId: number,
  conversationId: string,
  url: string,
): Promise<string> {
  const reused = await reuseOrOpenTab(runner(manager, userId, conversationId), url);
  return appendTabList(reused.summary, reused.tabs, reused.rawList);
}

export function commandFor(
  name: string,
  args: Record<string, unknown>,
  options: VeneerRunOptions = {},
): string[] | null {
  if (name === 'navigate') return ['open', String(args.url ?? '')];
  if (name === 'click') return ['click', String(args.target ?? '')];
  if (name === 'type') return ['type', String(args.target ?? ''), String(args.text ?? '')];
  if (name === 'read') return ['snapshot', '-i'];
  if (name === 'screenshot') return ['screenshot', ...(args.full === true ? ['--full'] : [])];
  if (name === 'fill') return ['fill', requireArg(args.target, 'fill needs a target such as @e1.'), String(args.text ?? '')];
  if (name === 'press') return ['press', requireArg(args.key, 'press needs a key such as Enter.')];
  if (name === 'hover') return ['hover', requireArg(args.target, 'hover needs a target such as @e1.')];
  if (name === 'scroll') {
    if (args.into_view) return ['scrollintoview', String(args.into_view)];
    return ['scroll', String(args.direction ?? 'down'), ...(args.pixels ? [String(Math.trunc(Number(args.pixels)))] : [])];
  }
  if (name === 'wait') return waitCommand(args);
  if (name === 'find') return findCommand(args);
  if (name === 'back') return ['back'];
  if (name === 'forward') return ['forward'];
  if (name === 'reload') return ['reload'];
  if (name === 'tab') return tabCommand(args);
  if (name === 'dialog') return dialogCommand(args);
  if (name === 'run') return assertVeneerRunArgs(args.args, options);
  return null;
}

function isLoopbackUrl(value: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '::' || hostname === '0.0.0.0') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function urlCandidates(name: string, args: Record<string, unknown>): string[] {
  // The raw escape hatch can carry a URL in any position, so every argument is a
  // candidate; the typed tools each carry theirs in `url`.
  if (name === 'run') return Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === 'string') : [];
  if (!['open', 'fresh', 'navigate', 'tab'].includes(name)) return [];
  return args.url ? [String(args.url)] : [];
}

export function rejectLoopbackUrl(name: string, args: Record<string, unknown>): void {
  if (!urlCandidates(name, args).some(isLoopbackUrl)) return;
  throw new Error(
    'Veneer Browser runs on a separate virtual machine and cannot open a loopback URL from the agent machine. Use a deployed, tunneled, tailnet, or other network-accessible URL. Use Agent Browser when the app is available only on the agent machine.',
  );
}

export async function handleVeneerBrowserMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { db, manager, secrets, emailCodes }: {
    db: Database.Database;
    manager: VeneerBrowserManager;
    /** Doppler read access for fill_secret / fill_totp; absent disables them. */
    secrets?: SecretAccessDeps;
    /** The configured code mailbox for fill_email_code; absent disables it. */
    emailCodes?: EmailCodeSource;
  },
): Promise<void> {
  if (req.method === 'DELETE') return void sendJson(res, 200, { ok: true });
  if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
  const token = String(req.headers['x-vp-agent-token'] ?? '').trim();
  const tokenContext = token ? resolveAgentTokenContext(db, token) : null;
  if (!tokenContext?.conversationId) return void sendJson(res, 401, { error: 'Veneer Browser requires an authenticated chat.' });
  const user = db.prepare('SELECT id, role FROM users WHERE email = ?').get(tokenContext.email) as
    | { id: number; role: 'owner' | 'member' | 'consultant' }
    | undefined;
  if (!user) return void sendJson(res, 401, { error: 'User not found.' });
  // The turn actor, not the machine owner: 'consultant' is the legacy admin
  // role, so only a plain member loses the credential tools.
  const memberActor = user.role === 'member';

  let message: Record<string, unknown>;
  try { message = await readJson(req); }
  catch (error) { return void sendJson(res, 400, { error: (error as Error).message }); }
  const id = message.id ?? null;
  const method = String(message.method ?? '');
  if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
  if (method === 'initialize') return void sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'veneer-browser', version: '1.0.0' }, instructions: INSTRUCTIONS } });
  if (method === 'tools/list') return void sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: listedTools(smsCodeAvailable(secrets, memberActor), emailCodeAvailable(emailCodes, memberActor), memberActor) } });
  if (method !== 'tools/call') return void sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });

  const params = (message.params ?? {}) as Record<string, unknown>;
  const name = String(params.name ?? '');
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  let result: { content: ToolContent[]; isError?: boolean; structuredContent?: unknown };
  try {
    const conversationId = tokenContext.conversationId;
    rejectLoopbackUrl(name, args);
    // Every one of these expires the refs the guard is holding, so the field it
    // was protecting no longer exists as far as the agent is concerned.
    if (REF_INVALIDATING_TOOLS.has(name)) clearSecretFields(conversationId);
    if (name === 'run') assertNoSecretReadback(conversationId, assertVeneerRunArgs(args.args, { captureGranted: manager.captureGrantActive(conversationId) }));
    // Pure, and null for every tool that is not a coordinate pointer tool. Bad
    // coordinates are rejected here, before any browser work starts.
    const pointerPlan = pointerCommands(name, args);
    // Checked on the call path as well as in tools/list, because a cached tool
    // list would otherwise still reach a member's turn.
    if (memberActor && CREDENTIAL_TOOLS.has(name)) throw new Error(CREDENTIAL_TOOLS_MEMBER_REFUSAL);
    const session = await manager.conversationSession(user.id, conversationId);
    // Read-only here. The grant is written solely by the authenticated user's
    // HTTP route; nothing on this path may create or widen one.
    const captureGranted = manager.captureGrantActive(conversationId);
    if (name === 'fill_secret' || name === 'fill_totp') {
      const secretDeps: SecretToolDeps = {
        manager, userId: user.id, conversationId, captureGranted, secrets: secrets ?? null,
      };
      // JSON only: no lifecycle chatter to hide a leak in, and no page output.
      result = textResult(name === 'fill_secret'
        ? await fillSecretTool(secretDeps, args)
        : await fillTotpTool(secretDeps, args));
    } else if (name === 'fill_sms_code') {
      // Checked again on the call path: tools/list omitting it is a hint, not a
      // gate, and a cached tool list would otherwise reach a client instance.
      if (!smsCodeAvailable(secrets, memberActor)) throw new Error(SMS_CODE_UNAVAILABLE);
      result = textResult(await fillSmsCodeTool({ manager, userId: user.id, conversationId }, args));
    } else if (name === 'fill_email_code') {
      // Same double check as fill_sms_code: the list is a hint, not a gate.
      if (!emailCodeAvailable(emailCodes, memberActor)) throw new Error(EMAIL_CODE_UNAVAILABLE);
      result = textResult(await fillEmailCodeTool({ manager, userId: user.id, conversationId, emailCodes: emailCodes! }, args));
    } else if (name === 'fetch_url') {
      const read = await manager.fetchUrl(user.id, conversationId, args);
      result = { ...textResult(JSON.stringify(read), !read.ok), structuredContent: read };
    } else if (name === 'list') {
      const profiles = manager.listProfilesForConversation(user.id, conversationId);
      result = textResult(profiles.length ? profiles.map((p) => {
        const copies = p.activeCloneCount ? ` — ${p.activeCloneCount} temporary ${p.activeCloneCount === 1 ? 'copy' : 'copies'}` : '';
        return `${p.id} — ${p.name} — ${p.status}${copies}`;
      }).join('\n') : 'No browser profiles are available to this chat.');
    } else if (name === 'create') {
      const created = await manager.createForConversation(user.id, conversationId, args.name);
      result = textResult(`Created and selected Veneer Browser profile “${created.profileName ?? 'profile'}”.`);
    } else if (name === 'select') {
      manager.selectForConversation(user.id, conversationId, String(args.profile_id ?? ''));
      result = textResult('Selected the browser profile for this chat.');
    } else if (name === 'open') {
      const opened = await manager.openConversation(user.id, conversationId);
      const capture = manager.captureGrantActive(conversationId);
      const reuse = args.url ? `\n${await goToUrl(manager, user.id, conversationId, String(args.url))}` : '';
      result = textResult(`${await sessionTextWithTabs(manager, user.id, conversationId, opened, capture)}${reuse}`);
    } else if (name === 'fresh') {
      const opened = await manager.openFreshConversation(user.id, conversationId);
      const capture = manager.captureGrantActive(conversationId);
      const reuse = args.url ? `\n${await goToUrl(manager, user.id, conversationId, String(args.url))}` : '';
      result = textResult(`${await sessionTextWithTabs(manager, user.id, conversationId, opened, capture)}${reuse}`);
    } else if (name === 'navigate') {
      result = textResult(await goToUrl(manager, user.id, conversationId, String(args.url ?? '')));
    } else if (name === 'download') {
      const files = await manager.downloads(user.id, conversationId);
      result = textResult(files.length ? `Saved browser downloads:\n${files.join('\n')}` : 'No browser downloads are ready.');
    } else if (name === 'status') {
      const current = await manager.conversationSession(user.id, conversationId);
      result = textResult(await sessionTextWithTabs(
        manager,
        user.id,
        conversationId,
        current,
        manager.captureGrantActive(conversationId),
      ));
    } else if (name === 'update_profile') {
      const updated = await manager.updateConversationProfile(user.id, conversationId);
      result = textResult(`Updated saved browser profile “${updated.profileName ?? 'profile'}”. Future working copies will include the new login state.`);
    } else if (name === 'save_as') {
      const saved = await manager.saveConversationAsProfile(user.id, conversationId, args.name);
      result = textResult(`Saved this working copy as browser profile “${saved.profileName ?? 'profile'}”.`);
    } else if (name === 'stop') {
      const stopped = await manager.stopConversation(user.id, conversationId);
      result = textResult(`${session.temporaryClone ? 'The temporary browser copy was stopped and deleted. Its unsaved changes were discarded.\n' : ''}${sessionText(stopped, manager.captureGrantActive(conversationId))}`);
    } else if (name === 'dialog') {
      // dialogCommand still validates and builds the argv; only accept and
      // dismiss take the trap-aware path, because status is a plain read.
      const command = dialogCommand(args);
      const action = command[1] as DialogAnswer | 'status';
      const run = runner(manager, user.id, conversationId);
      const outcome = action === 'status'
        ? await (async (): Promise<DialogOutcome> => {
          const ran = await run(command);
          return { text: commandOutput(ran), isError: ran.exitCode !== 0 };
        })()
        : await answerDialog(run, action, command);
      const lifecycle = await lifecycleText(manager, user.id, conversationId);
      result = textResult(`${outcome.text}\n${lifecycle}`, outcome.isError);
    } else if (pointerPlan) {
      const plan = pointerPlan;
      const sequence = await manager.runCommands(user.id, conversationId, plan);
      const lifecycle = await lifecycleText(manager, user.id, conversationId);
      result = sequence.failure
        ? textResult(`${sequence.failure.output}\n${lifecycle}`, true)
        : textResult(`${pointerSummary(name, plan)}\n${lifecycle}`);
    } else {
      const command = commandFor(name, args, { captureGranted });
      if (!command) throw new Error(`Unknown Veneer Browser tool: ${name}`);
      const run = await manager.runCommand(user.id, conversationId, command);
      const output = [run.stdout, run.stderr].filter(Boolean).join('\n') || `Browser command exited ${run.exitCode}.`;
      const lifecycle = await lifecycleText(manager, user.id, conversationId);
      const content: ToolContent[] = [{ type: 'text', text: `${output}\n${lifecycle}` }];
      if (run.screenshotPath && run.exitCode === 0 && fs.existsSync(run.screenshotPath)) {
        const image = fs.readFileSync(run.screenshotPath);
        if (image.length <= 5 * 1024 * 1024) content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' });
        // A viewport capture is the coordinate space of the pointer tools, so
        // say so with the image itself rather than hoping the agent assumes it.
        const size = args.full === true ? null : pngDimensions(image);
        if (size) {
          const first = content[0] as { type: 'text'; text: string };
          first.text = `${first.text}\nImage is ${size.width}×${size.height} px; these are 1:1 viewport CSS px for click_at/hover_at/scroll_at.`;
        }
      }
      result = { content, ...(run.exitCode === 0 ? {} : { isError: true }) };
    }
  } catch (error) {
    const message = (error as Error).message;
    const blocked = /timed out/i.test(message) && name !== 'dialog' && INTERACTION_TOOLS.has(name)
      ? await probeDialog(manager, user.id, tokenContext.conversationId)
      : null;
    result = textResult(`Error: ${message}${blocked ? `\n${blocked}` : ''}`, true);
  }
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}
