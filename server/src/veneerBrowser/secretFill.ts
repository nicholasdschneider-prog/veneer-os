import { assertDopplerSecretName } from '../secrets/doppler.js';
import { readSecretValue, type SecretAccessDeps } from '../secrets/readSecret.js';
import type { VeneerBrowserManager } from './manager.js';
import { findEmailCode, MAX_EMAIL_WAIT_SECONDS, type EmailCodeSource } from './emailCode.js';
import { findSmsCode } from './smsCode.js';
import { generateTotp, parseTotpSeed } from './totp.js';

/**
 * Credential entry for the signed-in browser.
 *
 * The agent names a Doppler secret; the value is read here, inside the runner,
 * and goes straight onto the agent-browser command line with a redaction list
 * attached. It never appears in a tool argument, a tool result, an audit row
 * (which stores only the verb), an error message, or a log line — the whole
 * point is that the model can log the user in without ever holding the password.
 */

/** Input types that are not a text field, so filling one means the ref is wrong. */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'submit', 'button', 'file', 'hidden', 'image', 'reset', 'range', 'color',
]);

/**
 * `contenteditable` values that turn editing on. The empty string is the bare
 * `<div contenteditable>` form, which is editable; an ABSENT attribute is a
 * different thing entirely and arrives here as null, never as ''.
 */
const CONTENTEDITABLE_ON = new Set(['', 'true', 'plaintext-only']);

export type FillTargetKind = 'input' | 'contenteditable';

export type FillTargetClassification =
  | { ok: true; kind: FillTargetKind; inputType?: string; masked: boolean }
  | { ok: false; reason: string };

/**
 * What the CLI can actually tell us about the element a ref points at.
 *
 * The installed agent-browser has no `get tag` and no `is editable`, and its
 * `get value` returns an empty string for a button and a div just as happily as
 * for an empty text box — it cannot fail the way a Playwright `inputValue()`
 * would, so it is useless as a type test. `get html` is innerHTML, which is
 * empty for every `<input>`. What is left, and what these three signals are, is:
 * the `type` attribute, the `contenteditable` attribute (where an absent
 * attribute is distinguishable from a present-but-empty one only in `--json`),
 * and Chrome's computed styles.
 */
export interface ProbeSignals {
  /** `get attr <target> type`; null when the attribute is absent. */
  typeAttr: string | null;
  /** `get attr <target> contenteditable`; null when absent, '' for the bare attribute. */
  contenteditableAttr: string | null;
  /** `get styles <target>`; Chrome's full computed set, kebab-case keys. */
  styles: Record<string, string>;
}

/**
 * Whether the element a ref points at can hold typed text.
 *
 * Pure so it can be tested directly, and deliberately strict: a mis-aimed ref
 * that lands on a submit button would otherwise "fill" a password by clicking
 * something, and a checkbox or a file input would swallow it silently. Worse,
 * the CLI's `fill` reports success on an element it cannot fill and types the
 * text into whatever currently holds focus, so a wrong answer here does not
 * merely fail — it can put a password somewhere nobody looked.
 *
 * The style half is UA-default behaviour rather than a guarantee: a page that
 * sets `cursor: pointer` on its own password box will be refused here, and a
 * `<div style="cursor: text">` will be accepted. The attribute half is checked
 * first precisely so no amount of styling can talk this into filling a
 * checkbox, and refusing is always the safe direction.
 */
export function classifyProbe(signals: ProbeSignals): FillTargetClassification {
  const type = (signals.typeAttr ?? '').trim().toLowerCase();
  if (type && NON_TEXT_INPUT_TYPES.has(type)) {
    return { ok: false, reason: `target is not a text input (<input type=${type}>)` };
  }
  const style = (name: string): string => (signals.styles[name] ?? '').trim().toLowerCase();
  // An absent attribute is null; anything that is not a string is treated the
  // same way, so a probe that came back shaped wrong refuses rather than throws.
  const editable = typeof signals.contenteditableAttr === 'string'
    ? signals.contenteditableAttr.trim().toLowerCase()
    : null;
  // contenteditable="false" switches editing off even inside an editing host.
  if (editable === 'false') {
    return { ok: false, reason: 'target is not a text input (contenteditable is false)' };
  }
  if (editable !== null && CONTENTEDITABLE_ON.has(editable)) {
    // Worth knowing: the CLI's `fill` does NOT clear a contenteditable the way
    // it clears an <input>. It inserts at the caret, so filling one that
    // already holds text appends to it. That fails the login rather than
    // leaking anything, so it is not a reason to refuse here.
    return { ok: true, kind: 'contenteditable', masked: false };
  }
  // An element nested inside an editing host carries no attribute of its own,
  // so this is the inherited answer. In current Chrome it is read-write for
  // contenteditable ONLY — form controls report read-only — which is why it
  // cannot stand in for the input test below.
  if (style('-webkit-user-modify') === 'read-write') {
    return { ok: true, kind: 'contenteditable', masked: false };
  }
  // -webkit-text-security is the UA's own masking. A page does not put it on a
  // field that is not a password, so it proves `masked` even when the `type`
  // attribute is absent because the field was built by script.
  const masked = type === 'password' || style('-webkit-text-security') === 'disc';
  if (masked || style('cursor') === 'text') {
    return { ok: true, kind: 'input', masked, ...(type ? { inputType: type } : {}) };
  }
  return { ok: false, reason: 'target is not a text input' };
}

// ---------------------------------------------------------------------------
// Readback guard.
//
// A field that was just filled with a secret is the one place on the page the
// secret now lives, so reading it back would hand the value to the model by the
// front door.
//
// The guard is deliberately NOT keyed on the target string that was filled. One
// element has unboundedly many names — `@e3`, `#pw`, `input[type=password]`,
// `form > input:nth-child(2)`, and a fresh `@e` ref after the next snapshot —
// so matching the filled target only blocks the one spelling the agent already
// used. While any field in this chat holds a secret, every element-content read
// on the raw `run` escape hatch is refused instead, until the page actually
// changes under it (see REF_INVALIDATING_TOOLS in mcp.ts).
// ---------------------------------------------------------------------------

const guardedFields = new Map<string, Set<string>>();
/** One chat cannot fill more than a handful of secret fields before navigating. */
const MAX_GUARDED_FIELDS = 20;

const READBACK_SUBCOMMANDS = new Set(['value', 'html', 'text', 'attr']);

function normalizeRef(target: string): string {
  return target.trim().toLowerCase();
}

export function rememberSecretField(conversationId: string, target: string): void {
  const refs = guardedFields.get(conversationId) ?? new Set<string>();
  // Evict the oldest, never the whole set: clearing would let a chat unlock its
  // own guard just by filling MAX_GUARDED_FIELDS more fields.
  while (refs.size >= MAX_GUARDED_FIELDS) {
    const oldest = refs.values().next();
    if (oldest.done) break;
    refs.delete(oldest.value);
  }
  refs.add(normalizeRef(target));
  guardedFields.set(conversationId, refs);
}

/** Called for every tool that invalidates refs; the guard has nothing to guard after one. */
export function clearSecretFields(conversationId: string): void {
  guardedFields.delete(conversationId);
}

/**
 * True while this chat has a field holding a secret that the page has not
 * navigated away from yet.
 *
 * Read by the capture-grant path in manager.ts: turning Advanced capture on
 * starts recording request bodies, so it must not become legal in the window
 * between a password landing in a form and that form being submitted.
 */
export function hasLiveSecretField(conversationId: string): boolean {
  return (guardedFields.get(conversationId)?.size ?? 0) > 0;
}

/** Throws when a raw `run` command would read page content while a filled secret is live. */
export function assertNoSecretReadback(conversationId: string, args: string[]): void {
  const refs = guardedFields.get(conversationId);
  if (!refs?.size) return;
  if (args[0]?.toLowerCase() !== 'get') return;
  const subcommand = (args[1] ?? '').toLowerCase();
  if (!READBACK_SUBCOMMANDS.has(subcommand)) return;
  // A link's href is where a login page keeps its "use a different method"
  // path, and a typed value never reflects into any element's attributes, so
  // that one attribute may be read from anything but the field just filled.
  if (subcommand === 'attr' && (args[3] ?? '').toLowerCase() === 'href' && args[2] && !refs.has(normalizeRef(args[2]))) return;
  throw new Error(
    `A field in this chat was just filled with a secret, so "get ${subcommand}" is refused until the page changes. `
      + 'Use read for the page, or verify the login by what the page does next.',
  );
}

// ---------------------------------------------------------------------------
// Audit.
//
// One line per credential fill, so the user can see afterwards that a secret
// went into a page and which page it was. It carries names and the target, and
// never the value, the code, or any message text.
// ---------------------------------------------------------------------------

/**
 * Keeps a page URL or a sender from breaking the line up or smuggling control
 * characters into it: everything outside printable, non-space ASCII collapses
 * to an underscore, so one fill is always exactly one log line.
 */
function logValue(value: string): string {
  return value.replace(/[^\x21-\x7e]+/g, '_').slice(0, 200);
}

function logFill(
  tool: string,
  deps: SecretFillDeps,
  fields: Record<string, string | undefined>,
  ok: boolean,
): void {
  const parts = [
    `[veneer-browser] ${tool}`,
    `user=${deps.userId}`,
    `conversation=${logValue(deps.conversationId)}`,
  ];
  for (const [key, value] of Object.entries(fields)) {
    if (value) parts.push(`${key}=${logValue(value)}`);
  }
  parts.push(`ok=${ok}`);
  console.info(parts.join(' '));
}

// ---------------------------------------------------------------------------
// Fill.
// ---------------------------------------------------------------------------

export interface SecretFillDeps {
  manager: Pick<VeneerBrowserManager, 'runCommands'>;
  userId: number;
  conversationId: string;
}

export interface FillProbe {
  kind: FillTargetKind;
  inputType?: string;
  /** <input type=password>: the browser itself hides what was typed. */
  masked: boolean;
  /** The page the fill will land on. Audit only; never returned to the agent. */
  pageUrl: string;
}

export interface ResolvedFillOutcome extends FillProbe {
  target: string;
  submitted: boolean;
}

function scrubbed(error: unknown, value: string): Error {
  const message = (error as Error)?.message ?? 'The browser command failed.';
  return new Error(value ? message.split(value).join('[redacted]') : message);
}

/**
 * The one message every unreadable probe produces.
 *
 * Deliberately says nothing the probe saw. The CLI's own "Element not found"
 * text would be harmless, but keeping one fixed string means no future probe
 * step can start leaking page content through this throw by accident.
 */
const PROBE_UNREADABLE =
  'that target could not be read on the page, so it is not a text input; take a fresh read and use a current @e ref';

function probeCommands(target: string): string[][] {
  return [
    // First, so the audit line can name the page even when the fill fails.
    ['get', 'url'],
    // --json because an ABSENT attribute and a present-but-empty one are the
    // same "✓ Done"-vs-blank guesswork in the plain output, and the difference
    // between them is exactly `<div contenteditable>` versus `<div>`.
    ['get', 'attr', target, 'type', '--json'],
    ['get', 'attr', target, 'contenteditable', '--json'],
    ['get', 'styles', target, '--json'],
  ];
}

function jsonPayload(stdout: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.success === false) return null;
  const data = record.data;
  return data && typeof data === 'object' ? data as Record<string, unknown> : record;
}

type AttrRead = { ok: true; value: string | null } | { ok: false };

function attrValue(stdout: string): AttrRead {
  const data = jsonPayload(stdout);
  if (!data || !('value' in data)) return { ok: false };
  const value = data.value;
  if (value === null) return { ok: true, value: null };
  return typeof value === 'string' ? { ok: true, value } : { ok: false };
}

function styleMap(stdout: string): Record<string, string> | null {
  const styles = jsonPayload(stdout)?.styles;
  if (!styles || typeof styles !== 'object') return null;
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(styles as Record<string, unknown>)) {
    if (typeof value === 'string') map[key] = value;
  }
  return map;
}

/**
 * Asks the page what the ref actually is, before any secret is read.
 *
 * PRIVACY: every byte of stdout from these commands stays inside this function.
 * A probe runs against a field this chat may have filled with a secret moments
 * ago, so nothing derived from `run.steps` may appear in the returned value, in
 * a thrown message, or in a log line — only the classification and the page URL
 * come back out.
 *
 * This is its own runCommands call rather than the head of the fill batch
 * because runCommands takes a fixed list and aborts on the first failure, so it
 * cannot branch between "is this a text box" and "type the password into it".
 * The property that matters is preserved elsewhere: the fill and its Enter
 * still ride in ONE sequence, so no other chat command lands between them.
 */
export async function probeFillTarget(deps: SecretFillDeps, target: string): Promise<FillProbe> {
  const run = await deps.manager.runCommands(deps.userId, deps.conversationId, probeCommands(target));
  if (run.failure || run.steps.length < 4) throw new Error(PROBE_UNREADABLE);
  const stdout = (index: number): string => run.steps[index]?.result.stdout ?? '';
  const type = attrValue(stdout(1));
  const editable = attrValue(stdout(2));
  const styles = styleMap(stdout(3));
  if (!type.ok || !editable.ok || !styles) throw new Error(PROBE_UNREADABLE);
  const classified = classifyProbe({
    typeAttr: type.value,
    contenteditableAttr: editable.value,
    styles,
  });
  if (!classified.ok) throw new Error(classified.reason);
  return {
    kind: classified.kind,
    ...(classified.inputType ? { inputType: classified.inputType } : {}),
    masked: classified.masked,
    pageUrl: stdout(0).trim().split('\n')[0]?.trim() ?? '',
  };
}

/**
 * Probe, fill, and optionally submit, given a value that is already resolved.
 *
 * This is the shared seam: fill_secret resolves from Doppler, fill_totp from a
 * seed, and fill_sms_code (Pro only) from the Mac's Messages database. The fill
 * and the Enter ride in ONE sequence so no other chat command can land between
 * a password and its submit.
 *
 * The probe is inside the try so that every path out of here — including a
 * probe that throws — goes through `scrubbed`.
 */
export async function fillWithResolvedValue(
  deps: SecretFillDeps,
  input: { target: string; value: string; submit?: boolean; probe?: FillProbe },
): Promise<ResolvedFillOutcome> {
  const target = input.target;
  const value = input.value;
  const submit = input.submit === true;
  try {
    const probe = input.probe ?? await probeFillTarget(deps, target);
    const commands: string[][] = [['fill', target, value]];
    if (submit) commands.push(['press', 'Enter']);
    const run = await deps.manager.runCommands(deps.userId, deps.conversationId, commands, { redact: [value] });
    if (run.failure) throw new Error(run.failure.output);
    // Remembered only after the value actually landed in the field.
    rememberSecretField(deps.conversationId, target);
    return { ...probe, target, submitted: submit };
  } catch (error) {
    throw scrubbed(error, value);
  }
}

// ---------------------------------------------------------------------------
// Tools.
// ---------------------------------------------------------------------------

export interface SecretToolDeps extends SecretFillDeps {
  captureGranted: boolean;
  secrets: SecretAccessDeps | null;
}

const CAPTURE_SECRET_REFUSAL =
  'Advanced capture is on for this chat, and network capture records request bodies — including the form this fill would submit. Ask the user to turn "Advanced capture" off in the browser panel before entering a stored credential.';

const VISIBLE_FIELD_WARNING = 'Value is visible on the page; do not screenshot or read this field.';

function requireTarget(value: unknown): string {
  const target = String(value ?? '').trim();
  if (!target) throw new Error('This tool needs a target such as @e1, from a recent read.');
  return target;
}

function requireSecretName(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Name the Doppler secret to read with secret_name.');
  return assertDopplerSecretName(raw);
}

function optionalSegment(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function secretAccess(deps: SecretToolDeps): SecretAccessDeps {
  if (!deps.secrets) throw new Error('Reading stored secrets is not available on this instance.');
  return deps.secrets;
}

export async function fillSecretTool(deps: SecretToolDeps, args: Record<string, unknown>): Promise<string> {
  const target = requireTarget(args.target);
  const name = requireSecretName(args.secret_name);
  const project = optionalSegment(args.project);
  const config = optionalSegment(args.config);
  let pageUrl = '';
  try {
    // Refused before any page or Doppler work: with capture on, the POST that
    // carries this password would be recorded in full.
    if (deps.captureGranted) throw new Error(CAPTURE_SECRET_REFUSAL);
    const probe = await probeFillTarget(deps, target);
    pageUrl = probe.pageUrl;
    const secret = await readSecretValue(secretAccess(deps), {
      name,
      ...(project ? { project } : {}),
      ...(config ? { config } : {}),
    });
    const outcome = await fillWithResolvedValue(deps, {
      target,
      value: secret.value,
      submit: args.submit === true,
      probe,
    });
    logFill('fill_secret', deps, { secret: name, project, config, target, url: pageUrl }, true);
    // No length: how long a password is narrows a guess at it, and the agent
    // has no use for the number.
    const payload = {
      ok: true,
      secret_name: name,
      target: outcome.target,
      submitted: outcome.submitted,
    };
    return probe.masked ? JSON.stringify(payload) : `${JSON.stringify(payload)}\n${VISIBLE_FIELD_WARNING}`;
  } catch (error) {
    logFill('fill_secret', deps, { secret: name, project, config, target, url: pageUrl }, false);
    throw error;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function fillTotpTool(deps: SecretToolDeps, args: Record<string, unknown>): Promise<string> {
  const target = requireTarget(args.target);
  const name = requireSecretName(args.secret_name);
  const project = optionalSegment(args.project);
  const config = optionalSegment(args.config);
  let pageUrl = '';
  try {
    const probe = await probeFillTarget(deps, target);
    pageUrl = probe.pageUrl;
    const secret = await readSecretValue(secretAccess(deps), {
      name,
      ...(project ? { project } : {}),
      ...(config ? { config } : {}),
    });
    let parsed;
    try {
      parsed = parseTotpSeed(secret.value);
    } catch (error) {
      // The seed is a secret too, so a parse failure can only describe the shape.
      throw scrubbed(error, secret.value);
    }
    let generated = generateTotp(parsed);
    // A code with a second or two left would be rejected by the time the page
    // posts it, so wait for the next window rather than fill a dead code.
    if (generated.secondsRemaining < 3) {
      await sleep(generated.secondsRemaining * 1000 + 250);
      generated = generateTotp(parsed);
    }
    const outcome = await fillWithResolvedValue(deps, {
      target,
      value: generated.code,
      submit: args.submit === true,
      probe,
    });
    logFill('fill_totp', deps, { secret: name, project, config, target, url: pageUrl }, true);
    return JSON.stringify({
      ok: true,
      secret_name: name,
      target: outcome.target,
      digits: parsed.digits,
      seconds_remaining: generated.secondsRemaining,
      submitted: outcome.submitted,
    });
  } catch (error) {
    logFill('fill_totp', deps, { secret: name, project, config, target, url: pageUrl }, false);
    throw error;
  }
}

/**
 * Hard cap on how long fill_sms_code may wait for a text to arrive.
 *
 * The budget it has to fit inside is the per-call MCP tool timeout every
 * provider gives veneer_browser: 960 s for Claude (MCP_TOOL_TIMEOUT in
 * providers/claude/adapter.ts) and 960 s for Codex and Grok
 * (tool_timeout_sec in providers/agentsMcp.ts). The runner's HTTP server puts
 * no ceiling on how long a response may take — Node's requestTimeout only
 * covers receiving the request — so 180 s sits far inside the smallest budget
 * minus 10 s, and the cap is set by what a human waits for, not by the wire.
 */
export const MAX_SMS_WAIT_SECONDS = 180;

function optionalSeconds(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`${label} must be a whole number of seconds, zero or more.`);
  }
  return Math.trunc(seconds);
}

/**
 * Fill a texted verification code, Pro Mac only. The caller gates availability
 * (see mcp.ts); this body assumes it is allowed to look.
 *
 * The Messages poll happens BEFORE any browser command so a two-minute wait
 * never holds this chat's single browser command slot, and the probe therefore
 * runs inside fillWithResolvedValue, once there is a code to type.
 *
 * SmsCodeError messages are deliberately let through as-is: they describe the
 * window, the sender, or the Full Disk Access grant, and never the message.
 */
export async function fillSmsCodeTool(deps: SecretFillDeps, args: Record<string, unknown>): Promise<string> {
  const target = requireTarget(args.target);
  const sender = optionalSegment(args.sender);
  const pattern = optionalSegment(args.pattern);
  const maxAgeSeconds = optionalSeconds(args.max_age_seconds, 'max_age_seconds');
  const requestedWait = optionalSeconds(args.wait_seconds, 'wait_seconds');
  const waitSeconds = requestedWait === undefined ? undefined : Math.min(requestedWait, MAX_SMS_WAIT_SECONDS);
  let matchedSender = sender;
  let pageUrl = '';
  try {
    const match = await findSmsCode({
      ...(sender ? { sender } : {}),
      ...(pattern ? { pattern } : {}),
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
      ...(waitSeconds === undefined ? {} : { waitSeconds }),
    });
    matchedSender = match.sender || sender;
    const outcome = await fillWithResolvedValue(deps, {
      target,
      value: match.code,
      submit: args.submit === true,
    });
    pageUrl = outcome.pageUrl;
    logFill('fill_sms_code', deps, { sender: matchedSender, target, url: pageUrl }, true);
    // The code and the message text stay here; only the shape of what happened
    // goes back, same contract as fill_secret and fill_totp.
    return JSON.stringify({
      ok: true,
      target: outcome.target,
      sender: match.sender,
      message_age_seconds: match.messageAgeSeconds,
      submitted: outcome.submitted,
    });
  } catch (error) {
    logFill('fill_sms_code', deps, { sender: matchedSender, target, url: pageUrl }, false);
    throw error;
  }
}

/**
 * Fill an emailed verification code from the ONE configured mailbox. The
 * caller gates availability (see mcp.ts); this body assumes it is allowed to
 * look. The mailbox read happens BEFORE any browser command, like the SMS
 * path, so a long wait never holds the chat's browser command slot.
 *
 * Two target shapes: `target` for one field that takes the whole code, or
 * `targets` for a row of single-character boxes — each box gets one character,
 * in order, all inside one browser sequence with the optional Enter last. Every
 * box is probed before anything is typed, and every box joins the readback
 * guard. EmailCodeError messages pass through as-is: they name the mailbox,
 * the sender filter, and the window, never a message.
 */
export interface EmailCodeToolDeps extends SecretFillDeps {
  emailCodes: EmailCodeSource;
}

const MAX_CODE_BOXES = 12;

function requireTargets(args: Record<string, unknown>): { targets: string[]; multi: boolean } {
  const single = String(args.target ?? '').trim();
  const list = Array.isArray(args.targets) ? args.targets.map((entry) => String(entry ?? '').trim()) : null;
  if (single && list) throw new Error('Pass either target (one field) or targets (one box per digit), not both.');
  if (list) {
    if (list.length < 2 || list.length > MAX_CODE_BOXES || list.some((entry) => !entry)) {
      throw new Error(`targets needs between 2 and ${MAX_CODE_BOXES} refs such as @e1, one per digit box, from a recent read.`);
    }
    if (new Set(list.map((entry) => entry.toLowerCase())).size !== list.length) {
      throw new Error('targets lists the same ref more than once.');
    }
    return { targets: list, multi: true };
  }
  return { targets: [requireTarget(single)], multi: false };
}

/**
 * Multi-box twin of fillWithResolvedValue: one probe per box first, then one
 * sequence that types each character and optionally presses Enter. The code
 * and each of its characters are redacted from the run, and every path out
 * goes through `scrubbed`.
 */
export async function fillBoxesWithResolvedValue(
  deps: SecretFillDeps,
  input: { targets: string[]; value: string; submit?: boolean },
): Promise<{ targets: string[]; submitted: boolean; pageUrl: string; masked: boolean }> {
  const { targets, value } = input;
  const submit = input.submit === true;
  try {
    const chars = Array.from(value);
    if (chars.length !== targets.length) {
      throw new Error(`The code has ${chars.length} characters but ${targets.length} boxes were given; take a fresh read and pass one ref per box.`);
    }
    const probes: FillProbe[] = [];
    for (const target of targets) probes.push(await probeFillTarget(deps, target));
    const commands: string[][] = targets.map((target, index) => ['fill', target, chars[index]!]);
    if (submit) commands.push(['press', 'Enter']);
    const run = await deps.manager.runCommands(deps.userId, deps.conversationId, commands, {
      redact: [value, ...new Set(chars)],
    });
    if (run.failure) throw new Error(run.failure.output);
    for (const target of targets) rememberSecretField(deps.conversationId, target);
    return {
      targets,
      submitted: submit,
      pageUrl: probes[0]?.pageUrl ?? '',
      masked: probes.every((probe) => probe.masked),
    };
  } catch (error) {
    throw scrubbed(error, value);
  }
}

export async function fillEmailCodeTool(deps: EmailCodeToolDeps, args: Record<string, unknown>): Promise<string> {
  const { targets, multi } = requireTargets(args);
  const sender = optionalSegment(args.sender);
  const subject = optionalSegment(args.subject);
  const threadId = optionalSegment(args.thread_id);
  const pattern = optionalSegment(args.pattern);
  const maxAgeSeconds = optionalSeconds(args.max_age_seconds, 'max_age_seconds');
  const requestedWait = optionalSeconds(args.wait_seconds, 'wait_seconds');
  const waitSeconds = requestedWait === undefined ? undefined : Math.min(requestedWait, MAX_EMAIL_WAIT_SECONDS);
  const targetField = multi ? targets.join(',') : targets[0]!;
  let matchedSender = sender;
  let matchedSubject = subject;
  let pageUrl = '';
  try {
    const match = await findEmailCode(deps.emailCodes, {
      conversationId: deps.conversationId,
      ...(sender ? { sender } : {}),
      ...(subject ? { subject } : {}),
      ...(threadId ? { threadId } : {}),
      ...(pattern ? { pattern } : {}),
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
      ...(waitSeconds === undefined ? {} : { waitSeconds }),
    });
    matchedSender = match.sender || sender;
    matchedSubject = match.subject || subject;
    const submit = args.submit === true;
    let submitted: boolean;
    if (multi) {
      const outcome = await fillBoxesWithResolvedValue(deps, { targets, value: match.code, submit });
      pageUrl = outcome.pageUrl;
      submitted = outcome.submitted;
    } else {
      const outcome = await fillWithResolvedValue(deps, { target: targets[0]!, value: match.code, submit });
      pageUrl = outcome.pageUrl;
      submitted = outcome.submitted;
    }
    logFill('fill_email_code', deps, {
      mailbox: deps.emailCodes.mailbox, sender: matchedSender, subject: matchedSubject, target: targetField, url: pageUrl,
    }, true);
    // The code, the message id, and the body stay here; only the shape of what
    // happened goes back, same contract as the other three fill tools.
    return JSON.stringify({
      ok: true,
      ...(multi ? { targets } : { target: targets[0] }),
      sender: match.sender,
      subject: match.subject,
      message_age_seconds: match.messageAgeSeconds,
      submitted,
    });
  } catch (error) {
    logFill('fill_email_code', deps, {
      mailbox: deps.emailCodes.mailbox, sender: matchedSender, subject: matchedSubject, target: targetField, url: pageUrl,
    }, false);
    throw error;
  }
}
