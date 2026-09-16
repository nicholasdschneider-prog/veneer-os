import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { resetHomesCache } from '../src/homes.js';
import { runAgentBrowser } from '../src/mcp/agentBrowser.js';
import { mintAgentToken } from '../src/runtime/agentTokens.js';
import { readSecretValue } from '../src/secrets/readSecret.js';
import type { SecretAccessDeps } from '../src/secrets/readSecret.js';
import { handleVeneerBrowserMcp } from '../src/veneerBrowser/mcp.js';
import { classifyProbe, clearSecretFields } from '../src/veneerBrowser/secretFill.js';
import { findSmsCode, SmsCodeError } from '../src/veneerBrowser/smsCode.js';
import type { VeneerBrowserManager } from '../src/veneerBrowser/manager.js';

// Only the Doppler read is stubbed; the tools, the probe, the redaction seam,
// and the readback guard are the real ones.
vi.mock('../src/secrets/readSecret.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/secrets/readSecret.js')>()),
  readSecretValue: vi.fn(),
}));

// The Messages lookup is stubbed; SmsCodeError stays real so the error mapping
// under test is the real one.
vi.mock('../src/veneerBrowser/smsCode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/veneerBrowser/smsCode.js')>()),
  findSmsCode: vi.fn(),
}));

// Pins the macOS half of the fill_sms_code gate so the suite means the same
// thing on a Linux client as it does on macOS. Only importers of
// platform.js see this; platform.ts's own internal calls are untouched.
const platform = vi.hoisted(() => ({ macOS: true }));
vi.mock('../src/platform.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/platform.js')>()),
  isMacOS: () => platform.macOS,
}));

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const PASSWORD = 'correct horse battery staple';
const readSecret = vi.mocked(readSecretValue);

interface McpResult { isError?: boolean; content: Array<{ text: string }> }

// ---------------------------------------------------------------------------
// A stand-in for the installed agent-browser CLI.
//
// Every value below was read off the real binary (0.36.0) against a fixture
// page in headless Chrome, because the probe's whole job is to tell elements
// apart using only what that CLI will actually say:
//
//   * `get value` is useless here — it exits 0 with an empty line for a button
//     and a plain div exactly as it does for an empty text box, so it is not
//     modelled at all and the probe must never ask for it.
//   * `get attr <el> <name> --json` reports value:null for an ABSENT attribute
//     and value:"" for a bare one, which is the only way to tell
//     `<div contenteditable>` from `<div>`.
//   * `get styles <el> --json` returns Chrome's full computed set under
//     `data.styles`, kebab-cased.
// ---------------------------------------------------------------------------

interface ElementFixture {
  /** The `type` ATTRIBUTE, not the property: absent on `<input>` reads as null. */
  typeAttr: string | null;
  contenteditableAttr: string | null;
  styles: Record<string, string>;
}

const BASE_STYLES: Record<string, string> = {
  cursor: 'default',
  '-webkit-user-modify': 'read-only',
  '-webkit-text-security': 'none',
  appearance: 'auto',
};

function element(partial: Partial<ElementFixture> = {}): ElementFixture {
  return {
    typeAttr: partial.typeAttr ?? null,
    contenteditableAttr: partial.contenteditableAttr ?? null,
    styles: { ...BASE_STYLES, ...(partial.styles ?? {}) },
  };
}

const PASSWORD_INPUT = element({ typeAttr: 'password', styles: { cursor: 'text', '-webkit-text-security': 'disc' } });
const TEXT_INPUT = element({ typeAttr: 'text', styles: { cursor: 'text' } });
const UNTYPED_INPUT = element({ styles: { cursor: 'text' } });
const TEXTAREA = element({ styles: { cursor: 'text', resize: 'both' } });
const EDITABLE_DIV = element({ contenteditableAttr: '', styles: { cursor: 'auto', '-webkit-user-modify': 'read-write', appearance: 'none' } });
const BUTTON = element({ styles: { cursor: 'default' } });
const CHECKBOX = element({ typeAttr: 'checkbox' });
const PLAIN_DIV = element({ styles: { cursor: 'auto', appearance: 'none' } });

/**
 * Builds one probe step's stdout. `leak` is page content the CLI happened to
 * echo back — a previously filled secret sitting in the element, say — and
 * exists so the tests can prove none of it escapes this process.
 */
function cliStdout(command: string[], fixture: ElementFixture, url: string, leak: string): string {
  if (command[0] !== 'get') return '';
  if (command[1] === 'url') return `${url}\n`;
  if (command[1] === 'attr') {
    const name = command[3];
    const value = name === 'type'
      ? fixture.typeAttr
      : name === 'contenteditable' ? fixture.contenteditableAttr : null;
    return JSON.stringify({ success: true, data: { lifecycle: { ok: true }, value, text: leak }, error: null });
  }
  if (command[1] === 'styles') {
    const styles = leak
      ? { ...fixture.styles, 'background-image': `url("https://cdn.example/${leak}.png")` }
      : fixture.styles;
    return JSON.stringify({ success: true, data: { lifecycle: { ok: true }, styles }, error: null });
  }
  return '';
}

function probeBatch(target: string): string[][] {
  return [
    ['get', 'url'],
    ['get', 'attr', target, 'type', '--json'],
    ['get', 'attr', target, 'contenteditable', '--json'],
    ['get', 'styles', target, '--json'],
  ];
}

/** Collects the audit lines the fill tools write, without printing them. */
const auditLines: string[] = [];

beforeAll(() => {
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    const line = args.map((arg) => String(arg)).join(' ');
    if (line.startsWith('[veneer-browser] fill_')) auditLines.push(line);
  });
});

describe('classifyProbe', () => {
  it('accepts text-bearing elements', () => {
    expect(classifyProbe(PASSWORD_INPUT)).toEqual({ ok: true, kind: 'input', inputType: 'password', masked: true });
    expect(classifyProbe(TEXT_INPUT)).toEqual({ ok: true, kind: 'input', inputType: 'text', masked: false });
    expect(classifyProbe(UNTYPED_INPUT)).toEqual({ ok: true, kind: 'input', masked: false });
    expect(classifyProbe(TEXTAREA)).toEqual({ ok: true, kind: 'input', masked: false });
    // The bare `<div contenteditable>` form: present, empty, and editable.
    expect(classifyProbe(EDITABLE_DIV)).toEqual({ ok: true, kind: 'contenteditable', masked: false });
    expect(classifyProbe(element({ contenteditableAttr: 'true' }))).toEqual({ ok: true, kind: 'contenteditable', masked: false });
    expect(classifyProbe(element({ contenteditableAttr: 'plaintext-only' }))).toEqual({ ok: true, kind: 'contenteditable', masked: false });
  });

  it('reads a scripted password field off the UA masking alone', () => {
    // No type attribute, because the field was built by script; Chrome still
    // reports the masking it applies, and nothing else ever has it.
    const scripted = element({ styles: { cursor: 'text', '-webkit-text-security': 'disc' } });
    expect(classifyProbe(scripted)).toEqual({ ok: true, kind: 'input', masked: true });
  });

  it('accepts an element nested inside an editing host', () => {
    // A child of a contenteditable host has no attribute of its own; the
    // inherited computed value is the only signal there is.
    const nested = element({ styles: { '-webkit-user-modify': 'read-write', cursor: 'auto' } });
    expect(classifyProbe(nested)).toEqual({ ok: true, kind: 'contenteditable', masked: false });
  });

  it('refuses everything that cannot hold typed text', () => {
    const refused: Array<[string, ElementFixture]> = [
      ['button', BUTTON],
      ['checkbox', CHECKBOX],
      ['plain div', PLAIN_DIV],
      ['contenteditable=false', element({ contenteditableAttr: 'false' })],
      ['select', element({ styles: { cursor: 'default' } })],
      ['hidden input', element({ typeAttr: 'hidden' })],
    ];
    for (const [label, fixture] of refused) {
      const classified = classifyProbe(fixture);
      expect(classified.ok, label).toBe(false);
      if (!classified.ok) expect(classified.reason).toMatch(/not a text input/);
    }
  });

  it('refuses a non-text input type however the page has styled it', () => {
    // The attribute is checked before any style is, so a checkbox dressed up as
    // a text box is still a checkbox.
    for (const type of ['checkbox', 'radio', 'submit', 'button', 'file', 'hidden', 'image', 'reset', 'range', 'color']) {
      const disguised = element({ typeAttr: type, styles: { cursor: 'text', '-webkit-user-modify': 'read-write' } });
      const classified = classifyProbe(disguised);
      expect(classified.ok, type).toBe(false);
      if (!classified.ok) expect(classified.reason).toContain(type);
    }
  });

  it('refuses rather than guesses when the probe came back empty', () => {
    expect(classifyProbe({ typeAttr: null, contenteditableAttr: null, styles: {} }).ok).toBe(false);
  });
});

describe('Veneer Browser credential tools', () => {
  let db: Database.Database;
  let server: Server | undefined;
  let base: string;
  let token: string;
  let memberToken: string;
  let fixture: ElementFixture = PASSWORD_INPUT;
  let pageUrl = 'https://acme.example/login';
  let leak = '';

  const conversationSession = vi.fn(async () => ({
    configured: true,
    active: true,
    projectId: 'unfiled-user-1',
    profileId: null,
    profileName: null,
    status: 'active' as const,
    inUseByAnotherChat: false,
    temporaryClone: true,
    fresh: false,
    canUpdateProfile: false,
    lastUsedAt: null,
    error: null,
  }));
  const runCommand = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, screenshotPath: null }));
  const runCommands = vi.fn(async (
    _userId: number,
    _conversationId: string,
    commands: string[][],
    _options?: { redact?: string[] },
  ) => ({
    steps: commands.map((command) => ({
      command,
      result: {
        args: command,
        stdout: cliStdout(command, fixture, pageUrl, leak),
        stderr: '',
        exitCode: 0,
      },
    })),
    failure: null as null | { index: number; command: string[]; output: string },
    released: false,
  }));
  const captureGrantActive = vi.fn(() => false);

  beforeAll(async () => {
    db = new Database(':memory:');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('token-chat', 1, 1, 'claude', 'token-native')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('member-chat', 1, 2, 'claude', 'member-native')").run();
    token = mintAgentToken(db, 'owner@example.com', 'token-chat');
    memberToken = mintAgentToken(db, 'member@example.com', 'member-chat');
    const manager = {
      conversationSession,
      runCommand,
      runCommands,
      captureGrantActive,
      probeCommand: vi.fn(async () => null),
    } as unknown as VeneerBrowserManager;
    const secrets = {
      db,

      projectDopplerCli: { binDir: '/tmp/bin', configDir: '/tmp/cfg', userHome: '/tmp' },
      agentToken: () => undefined,
    } as SecretAccessDeps;
    server = createServer((req, res) => {
      void handleVeneerBrowserMcp(req, res, { db, manager, secrets });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    db.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretFields('token-chat');
    fixture = PASSWORD_INPUT;
    pageUrl = 'https://acme.example/login';
    leak = '';
    auditLines.length = 0;
    captureGrantActive.mockImplementation(() => false);
    runCommand.mockImplementation(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, screenshotPath: null }));
    readSecret.mockImplementation(async () => ({
      name: 'ACME_PASSWORD', project: 'veneer', config: 'prd', value: PASSWORD,
    }));
  });

  async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VP-Agent-Token': token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json() as { result: unknown }).result;
  }

  const call = (name: string, args: Record<string, unknown> = {}): Promise<McpResult> =>
    rpc('tools/call', { name, arguments: args }) as Promise<McpResult>;

  async function memberRpc(method: string, params: Record<string, unknown>): Promise<any> {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VP-Agent-Token': memberToken },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json() as { result: unknown }).result;
  }

  it('lists the credential tools', async () => {
    const listed = await rpc('tools/list', {}) as { tools: Array<{ name: string; description: string }> };
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain('fill_secret');
    expect(names).toContain('fill_totp');
    expect(listed.tools.find((tool) => tool.name === 'fill')?.description).toContain('fill_secret');
    expect(listed.tools.find((tool) => tool.name === 'find')?.description).toContain('fill_totp');
    expect(listed.tools.find((tool) => tool.name === 'type')?.description).toContain('fill_secret');
  });

  it('hides the credential tools from a member turn and refuses the call anyway', async () => {
    const listed = await memberRpc('tools/list', {}) as { tools: Array<{ name: string }> };
    const names = listed.tools.map((tool) => tool.name);
    expect(names).not.toContain('fill_secret');
    expect(names).not.toContain('fill_totp');
    expect(names).not.toContain('fill_sms_code');
    // The rest of the browser still works for them.
    expect(names).toContain('navigate');
    expect(names).toContain('read');

    // A cached tool list must not get through either.
    for (const name of ['fill_secret', 'fill_totp', 'fill_sms_code']) {
      const result = await memberRpc('tools/call', {
        name,
        arguments: { target: '@e1', secret_name: 'ACME_PASSWORD' },
      }) as McpResult;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/does not have/);
    }
    expect(readSecret).not.toHaveBeenCalled();
    expect(runCommands).not.toHaveBeenCalled();
  });

  it.each([
    ['button', BUTTON],
    ['checkbox', CHECKBOX],
    ['plain div', PLAIN_DIV],
  ])('refuses a %s and never reads the secret', async (_label, refused) => {
    fixture = refused;
    const result = await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not a text input/);
    expect(readSecret).not.toHaveBeenCalled();
    // Only the probe ran; nothing was typed anywhere.
    expect(runCommands).toHaveBeenCalledTimes(1);
    expect(runCommands.mock.calls[0]![2]).toEqual(probeBatch('@e3'));
  });

  it('accepts a textarea and a contenteditable the same way it accepts an input', async () => {
    for (const editable of [TEXTAREA, EDITABLE_DIV, UNTYPED_INPUT]) {
      vi.clearAllMocks();
      readSecret.mockImplementation(async () => ({
        name: 'ACME_PASSWORD', project: 'veneer', config: 'prd', value: PASSWORD,
      }));
      fixture = editable;
      const result = await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
      expect(result.isError).toBeUndefined();
      expect(runCommands.mock.calls[1]![2]).toEqual([['fill', '@e3', PASSWORD]]);
    }
  });

  it('refuses a secret fill while advanced capture is on, before touching the page', async () => {
    captureGrantActive.mockImplementation(() => true);
    const result = await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Advanced capture/);
    expect(runCommands).not.toHaveBeenCalled();
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('fills a password field and reports only the shape of what it did', async () => {
    const result = await call('fill_secret', { target: '@e3', secret_name: 'acme_password' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).not.toContain(PASSWORD);
    // No length: how long a password is narrows a guess at it.
    expect(JSON.parse(text)).toEqual({
      ok: true,
      secret_name: 'ACME_PASSWORD',
      target: '@e3',
      submitted: false,
    });
    expect(text).not.toMatch(/length/);
    // A masked field needs no visibility warning.
    expect(text).not.toContain('visible on the page');
    expect(readSecret).toHaveBeenCalledWith(expect.anything(), { name: 'ACME_PASSWORD' });
    expect(runCommands.mock.calls[0]![2]).toEqual(probeBatch('@e3'));
    const [, , commands, options] = runCommands.mock.calls[1]!;
    expect(commands).toEqual([['fill', '@e3', PASSWORD]]);
    expect(options).toEqual({ redact: [PASSWORD] });
  });

  it('writes one audit line per fill, naming the page but never the value', async () => {
    await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD', project: 'veneer', config: 'prd' });
    expect(auditLines).toHaveLength(1);
    const line = auditLines[0]!;
    expect(line).toBe(
      '[veneer-browser] fill_secret user=1 conversation=token-chat secret=ACME_PASSWORD '
        + 'project=veneer config=prd target=@e3 url=https://acme.example/login ok=true',
    );
    expect(line).not.toContain(PASSWORD);
  });

  it('audits a refusal too, so a failed attempt is not invisible', async () => {
    fixture = BUTTON;
    await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toContain('fill_secret');
    expect(auditLines[0]).toContain('secret=ACME_PASSWORD');
    expect(auditLines[0]).toContain('ok=false');
  });

  it('never lets probe output reach the agent, the error, or the log', async () => {
    // The probe reads a field this chat may have filled moments ago, so treat
    // every byte the CLI echoed back as the secret it might be.
    leak = 'OLD_SECRET_VALUE';
    const ok = await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).not.toContain('OLD_SECRET_VALUE');

    // ...and the same when the fill that follows the probe fails, which is the
    // path that actually quotes command output back at the caller.
    vi.clearAllMocks();
    auditLines.length = 0;
    runCommands.mockImplementationOnce(async (_u, _c, commands) => ({
      steps: commands.map((command) => ({
        command,
        result: { args: command, stdout: cliStdout(command, fixture, pageUrl, leak), stderr: '', exitCode: 0 },
      })),
      failure: null,
      released: false,
    }));
    runCommands.mockImplementationOnce(async () => ({
      steps: [],
      failure: { index: 0, command: ['fill', '@e3', '[redacted]'], output: 'fill failed: the element went away' },
      released: false,
    }));
    const failed = await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).not.toContain('OLD_SECRET_VALUE');
    expect(auditLines.join('\n')).not.toContain('OLD_SECRET_VALUE');
  });

  it('warns when the filled field is not a masked password input', async () => {
    fixture = TEXT_INPUT;
    const result = await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
    const [first, second] = result.content[0]!.text.split('\n');
    expect(JSON.parse(first!).ok).toBe(true);
    expect(second).toBe('Value is visible on the page; do not screenshot or read this field.');
  });

  it('submits in the same sequence as the fill', async () => {
    const result = await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD', submit: true });
    expect(JSON.parse(result.content[0]!.text).submitted).toBe(true);
    expect(runCommands.mock.calls[1]![2]).toEqual([['fill', '@e3', PASSWORD], ['press', 'Enter']]);
  });

  it('redacts the value out of a failing command, end to end', async () => {
    runCommands.mockImplementationOnce(async (_u, _c, commands) => ({
      steps: commands.map((command) => ({
        command,
        result: { args: command, stdout: cliStdout(command, fixture, pageUrl, leak), stderr: '', exitCode: 0 },
      })),
      failure: null,
      released: false,
    }));
    runCommands.mockImplementationOnce(async () => ({
      steps: [],
      failure: { index: 0, command: ['fill', '@e3', PASSWORD], output: `fill failed: value "${PASSWORD}" was rejected` },
      released: false,
    }));
    const result = await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain(PASSWORD);
    expect(result.content[0]!.text).toContain('[redacted]');
  });

  it('refuses to read a filled field back until the page changes', async () => {
    await call('fill_secret', { target: '@e3', secret_name: 'ACME_PASSWORD' });
    const blocked = await call('run', { args: ['get', 'value', '@e3'] });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]!.text).toMatch(/is refused until the page changes/);
    expect(runCommand).not.toHaveBeenCalled();

    // One element has many names, so no alias gets through either: a CSS
    // selector, a parent's innerHTML, or a fresh ref from another snapshot.
    for (const args of [
      ['get', 'value', '#pw'],
      ['get', 'value', 'input[type=password]'],
      ['get', 'html', 'form'],
      ['get', 'text', '@e4'],
      ['get', 'attr', '@e4', 'value'],
    ]) {
      expect((await call('run', { args })).isError, args.join(' ')).toBe(true);
    }
    expect(runCommand).not.toHaveBeenCalled();

    // A plain re-read does not change the page, so it must not disarm anything.
    await call('read');
    expect((await call('run', { args: ['get', 'value', '@e3'] })).isError).toBe(true);
    // Reads that cannot carry element content are still allowed throughout.
    expect((await call('run', { args: ['get', 'url'] })).isError).toBeUndefined();

    // Navigating is what actually retires the field.
    await call('navigate', { url: 'https://example.com/account' });
    runCommand.mockClear();
    const allowed = await call('run', { args: ['get', 'value', '@e3'] });
    expect(allowed.isError).toBeUndefined();
    expect(runCommand).toHaveBeenCalledWith(1, 'token-chat', ['get', 'value', '@e3']);
  });

  it('does not let a chat unlock its own guard by filling more fields', async () => {
    for (let index = 0; index < 25; index += 1) {
      await call('fill_secret', { target: `@e${index}`, secret_name: 'ACME_PASSWORD' });
    }
    expect((await call('run', { args: ['get', 'value', '@e0'] })).isError).toBe(true);
  });

  it('fills a live TOTP code without disclosing the code or the seed', async () => {
    fixture = TEXT_INPUT;
    readSecret.mockImplementation(async () => ({
      name: 'ACME_TOTP', project: 'veneer', config: 'prd', value: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    }));
    const result = await call('fill_totp', { target: '@e7', secret_name: 'ACME_TOTP', submit: true });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text.split('\n')[0]!);
    expect(payload).toMatchObject({ ok: true, secret_name: 'ACME_TOTP', target: '@e7', digits: 6, submitted: true });
    expect(payload.seconds_remaining).toBeGreaterThan(0);
    const [, , commands, options] = runCommands.mock.calls[1]!;
    const code = commands[0]![2]!;
    expect(code).toMatch(/^\d{6}$/);
    expect(options).toEqual({ redact: [code] });
    // The code itself is never in the result, nor in the audit line.
    expect(result.content[0]!.text).not.toContain(code);
    expect(commands[1]).toEqual(['press', 'Enter']);
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toContain('[veneer-browser] fill_totp');
    expect(auditLines[0]).toContain('secret=ACME_TOTP');
    expect(auditLines[0]).toContain('ok=true');
    expect(auditLines[0]).not.toContain(code);
  }, 15_000);

  it('does not echo an unusable TOTP seed', async () => {
    fixture = TEXT_INPUT;
    const seed = 'this is not a totp seed!!';
    readSecret.mockImplementation(async () => ({ name: 'ACME_TOTP', project: 'veneer', config: 'prd', value: seed }));
    const result = await call('fill_totp', { target: '@e7', secret_name: 'ACME_TOTP' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain(seed);
    expect(result.content[0]!.text).toMatch(/not a TOTP seed/);
    expect(auditLines.join('\n')).not.toContain(seed);
  });

  it('validates the Doppler secret name before anything else', async () => {
    const reserved = await call('fill_secret', { target: '@e3', secret_name: 'DOPPLER_TOKEN' });
    expect(reserved.isError).toBe(true);
    expect(reserved.content[0]!.text).toMatch(/reserved/);
    const malformed = await call('fill_totp', { target: '@e3', secret_name: 'acme totp!' });
    expect(malformed.isError).toBe(true);
    expect(malformed.content[0]!.text).toMatch(/SCREAMING_SNAKE_CASE/);
    expect(runCommands).not.toHaveBeenCalled();
    expect(readSecret).not.toHaveBeenCalled();
  });
});

describe('agent-browser redaction', () => {
  it('keeps a redacted value out of stdout, stderr, argv, and errors', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-redact-home-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-redact-work-'));
    const binary = path.join(home, 'agent-browser-stub');
    const config = path.join(home, 'agent-browser.json');
    const original = {
      home: process.env.VP_SERVICE_HOME,
      binary: process.env.VP_AGENT_BROWSER_BIN,
      config: process.env.VP_AGENT_BROWSER_CONFIG,
    };
    try {
      // The real CLI echoes the field it filled; this stub does the same on
      // both streams, which is exactly what must never reach the agent.
      fs.writeFileSync(binary, ['#!/bin/sh', 'printf "filled %s\\n" "$*"', 'printf "warn %s\\n" "$*" >&2', ''].join('\n'), { mode: 0o700 });
      fs.chmodSync(binary, 0o700);
      fs.writeFileSync(config, '{}');
      process.env.VP_SERVICE_HOME = home;
      process.env.VP_AGENT_BROWSER_BIN = binary;
      process.env.VP_AGENT_BROWSER_CONFIG = config;
      resetHomesCache();

      const result = await runAgentBrowser(['fill', '@e1', PASSWORD], {
        conversationId: 'conversation-1',
        workspaceDir,
        redact: [PASSWORD],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(PASSWORD);
      expect(result.stderr).not.toContain(PASSWORD);
      expect(result.stdout).toContain('[redacted]');
      expect(result.stderr).toContain('[redacted]');
      expect(result.args).toEqual(['--session', result.args[1], '--max-output', '100000', 'fill', '@e1', '[redacted]']);

      // Even a single character is replaced; nothing here judges a value "short".
      const short = await runAgentBrowser(['fill', '@e1', 'x'], {
        conversationId: 'conversation-1',
        workspaceDir,
        redact: ['x'],
      });
      expect(short.args.at(-1)).toBe('[redacted]');

      // A THROWN failure is scrubbed too, not just a returned one: this one
      // quotes a path that happens to carry the value.
      process.env.VP_AGENT_BROWSER_BIN = path.join(home, `absent-${PASSWORD}`);
      const thrown = await runAgentBrowser(['fill', '@e1', PASSWORD], {
        conversationId: 'conversation-1',
        workspaceDir,
        redact: [PASSWORD],
      }).then(() => null, (error: Error) => error);
      expect(thrown?.message).not.toContain(PASSWORD);
      expect(thrown?.message).toContain('[redacted]');
    } finally {
      if (original.home === undefined) delete process.env.VP_SERVICE_HOME;
      else process.env.VP_SERVICE_HOME = original.home;
      if (original.binary === undefined) delete process.env.VP_AGENT_BROWSER_BIN;
      else process.env.VP_AGENT_BROWSER_BIN = original.binary;
      if (original.config === undefined) delete process.env.VP_AGENT_BROWSER_CONFIG;
      else process.env.VP_AGENT_BROWSER_CONFIG = original.config;
      resetHomesCache();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe('fill_sms_code', () => {
  let db: Database.Database;
  let mainServer: Server | undefined;
  let mainBase: string;
  let token: string;
  let fixture: ElementFixture = TEXT_INPUT;
  let pageUrl = 'https://acme.example/verify';
  /** Proves the Messages poll finishes before the browser queue is entered. */
  let order: string[] = [];

  const smsCode = vi.mocked(findSmsCode);
  const MATCH = { code: '318204', sender: '262966', messageAgeSeconds: 12 };

  const conversationSession = vi.fn(async () => ({
    configured: true,
    active: true,
    projectId: 'unfiled-user-1',
    profileId: null,
    profileName: null,
    status: 'active' as const,
    inUseByAnotherChat: false,
    temporaryClone: true,
    fresh: false,
    canUpdateProfile: false,
    lastUsedAt: null,
    error: null,
  }));
  const runCommand = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, screenshotPath: null }));
  const runCommands = vi.fn(async (
    _userId: number,
    _conversationId: string,
    commands: string[][],
    _options?: { redact?: string[] },
  ) => {
    order.push(`runCommands:${commands[0]![0]}`);
    return {
      steps: commands.map((command) => ({
        command,
        result: { args: command, stdout: cliStdout(command, fixture, pageUrl, ''), stderr: '', exitCode: 0 },
      })),
      failure: null as null | { index: number; command: string[]; output: string },
      released: false,
    };
  });

  function serverFor(): Server {
    const manager = {
      conversationSession,
      runCommand,
      runCommands,
      captureGrantActive: vi.fn(() => false),
      probeCommand: vi.fn(async () => null),
    } as unknown as VeneerBrowserManager;
    const secrets = {
      db,
      projectDopplerCli: { binDir: '/tmp/bin', configDir: '/tmp/cfg', userHome: '/tmp' },
    } as SecretAccessDeps;
    return createServer((req, res) => {
      void handleVeneerBrowserMcp(req, res, { db, manager, secrets });
    });
  }

  beforeAll(async () => {
    db = new Database(':memory:');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('sms-chat', 1, 1, 'claude', 'sms-native')").run();
    token = mintAgentToken(db, 'owner@example.com', 'sms-chat');
    mainServer = serverFor();
    await new Promise<void>((resolve) => mainServer!.listen(0, '127.0.0.1', resolve));
    mainBase = `http://127.0.0.1:${(mainServer.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    mainServer?.close();
    db.close();
  });

  beforeEach(() => {
    platform.macOS = true;
    vi.clearAllMocks();
    clearSecretFields('sms-chat');
    fixture = TEXT_INPUT;
    pageUrl = 'https://acme.example/verify';
    order = [];
    auditLines.length = 0;
    smsCode.mockImplementation(async () => {
      order.push('findSmsCode');
      return { ...MATCH };
    });
  });

  async function rpc(base: string, method: string, params: Record<string, unknown>): Promise<any> {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VP-Agent-Token': token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json() as { result: unknown }).result;
  }

  const call = (base: string, args: Record<string, unknown>): Promise<McpResult> =>
    rpc(base, 'tools/call', { name: 'fill_sms_code', arguments: args }) as Promise<McpResult>;

  it('lists the tool on macOS and nowhere else', async () => {
    const main = await rpc(mainBase, 'tools/list', {}) as { tools: Array<{ name: string; description: string }> };
    const names = main.tools.map((tool) => tool.name);
    expect(names).toContain('fill_sms_code');
    // Listed next to the other 2-step tool, in the order the agent should try.
    expect(names.indexOf('fill_sms_code')).toBe(names.indexOf('fill_totp') + 1);
    expect(main.tools.find((tool) => tool.name === 'fill_sms_code')?.description).toMatch(/Advanced capture/);

    platform.macOS = false;
    const other = await rpc(mainBase, 'tools/list', {}) as { tools: Array<{ name: string }> };
    expect(other.tools.map((tool) => tool.name)).not.toContain('fill_sms_code');
    expect(other.tools.map((tool) => tool.name)).toContain('fill_totp');
  });

  it('refuses the call off macOS even though the tool list omitted it', async () => {
    platform.macOS = false;
    const result = await call(mainBase, { target: '@e9' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Error: fill_sms_code is only available on macOS.');
    expect(smsCode).not.toHaveBeenCalled();
    expect(runCommands).not.toHaveBeenCalled();
  });

  it('fills the code and reports only the shape of what it did', async () => {
    const result = await call(mainBase, { target: '@e9', sender: '262966', submit: true });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).not.toContain(MATCH.code);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      target: '@e9',
      sender: '262966',
      message_age_seconds: 12,
      submitted: true,
    });
    const [, , commands, options] = runCommands.mock.calls[1]!;
    expect(commands).toEqual([['fill', '@e9', MATCH.code], ['press', 'Enter']]);
    expect(options).toEqual({ redact: [MATCH.code] });
    // Audited by sender and page, never by code.
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toBe(
      '[veneer-browser] fill_sms_code user=1 conversation=sms-chat sender=262966 '
        + 'target=@e9 url=https://acme.example/verify ok=true',
    );
  });

  it('waits for the code before taking the browser command slot', async () => {
    await call(mainBase, { target: '@e9' });
    // The probe is the first browser command, and it runs only after the wait.
    expect(order).toEqual(['findSmsCode', 'runCommands:get', 'runCommands:fill']);
  });

  it('clamps a wait longer than the cap', async () => {
    await call(mainBase, { target: '@e9', wait_seconds: 600, max_age_seconds: 60 });
    expect(smsCode).toHaveBeenCalledWith(expect.objectContaining({ waitSeconds: 180, maxAgeSeconds: 60 }));
  });

  it('passes a not_found failure through without inventing a code', async () => {
    smsCode.mockImplementation(async () => {
      throw new SmsCodeError('not_found', 'No matching code from 262966 in the last 300 s after waiting 90 s.');
    });
    const result = await call(mainBase, { target: '@e9', sender: '262966' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Error: No matching code from 262966 in the last 300 s after waiting 90 s.');
    expect(result.content[0]!.text).not.toContain(MATCH.code);
    expect(runCommands).not.toHaveBeenCalled();
    expect(auditLines[0]).toContain('ok=false');
  });

  it('keeps the Full Disk Access instructions in a no_access failure', async () => {
    smsCode.mockImplementation(async () => {
      throw new SmsCodeError(
        'no_access',
        'Cannot read the Messages database at /Users/x/Library/Messages/chat.db. Grant Full Disk Access to the Node '
          + 'binary at /opt/homebrew/bin/node, then restart the Veneer runner.',
      );
    });
    const result = await call(mainBase, { target: '@e9' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Full Disk Access/);
    expect(result.content[0]!.text).toMatch(/restart the Veneer runner/);
    expect(result.content[0]!.text).not.toContain(MATCH.code);
  });

  it('refuses a target that cannot hold typed text, without typing the code', async () => {
    fixture = BUTTON;
    const result = await call(mainBase, { target: '@e9' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not a text input/);
    expect(result.content[0]!.text).not.toContain(MATCH.code);
    // Only the probe ran; nothing was typed anywhere.
    expect(runCommands).toHaveBeenCalledTimes(1);
    expect(runCommands.mock.calls[0]![2]).toEqual(probeBatch('@e9'));
  });
});
