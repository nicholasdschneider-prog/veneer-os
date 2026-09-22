import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { migrate } from '../src/db/migrate.js';
import { createConversationWakeupScheduler } from '../src/scheduled/wakeups.js';
import {
  saveRoutine,
  acceptEvent,
  routineWakeAllowed,
  tickRoutines,
  type Routine,
} from '../src/botWorkflows/routines.js';
import {
  inQuietHours,
  allowedPushEndpoint,
  NotificationPreference,
  queueNotification,
  tickNotifications,
} from '../src/botWorkflows/notifications.js';
import {
  indexDocument,
  indexConversation,
  searchWork,
} from '../src/botWorkflows/search.js';
import {
  saveTemplate,
  instantiateTemplate,
  type Template,
} from '../src/botWorkflows/templates.js';
import {
  startTeaching,
  recordTeachingStep,
  finishTeaching,
  recording,
  safeTeachingUrl,
  teachingProbe,
} from '../src/botWorkflows/teaching.js';
import type { AppContext } from '../src/context.js';
import type {
  UserRow,
  ConversationRow,
  ConversationWakeupRow,
} from '../src/db/db.js';

describe('Bot workflows', () => {
  let db: Database.Database, ctx: AppContext, user: UserRow, other: UserRow;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(
      db,
      fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    );
    for (const id of [1, 2])
      db.prepare(
        "INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'owner')",
      ).run(id, `user${id}@example.test`, `User ${id}`);
    user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    other = db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow;
    for (const [id, owner] of [
      ['a', 1],
      ['b', 2],
    ] as const) {
      db.prepare(
        'INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,?)',
      ).run(`team-${id}`, `Team ${id}`, owner);
      db.prepare(
        "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,?,?,'claude',?,'team',?)",
      ).run(id, owner, `Bot ${id}`, `native-${id}`, `team-${id}`);
      db.prepare(
        'INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,?)',
      ).run(id, `Bot ${id}`, owner);
      db.prepare(
        "INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES(?,?,'bot')",
      ).run(id, `team-${id}`);
    }
    db.prepare(
      "INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES('source-a','team-a',1,'OrderOps')",
    ).run();
    const keys = new Map<string, string>();
    ctx = {
      db,
      manager: {
        bus: new EventEmitter(),
        snapshot: vi.fn(async () => []),
        postMessage: vi.fn(),
      },
      secrets: {
        getApiKeyOverride: (id: string) => keys.get(id) ?? null,
        setApiKeyOverride: (id: string, v: string) => keys.set(id, v),
        clearApiKeyOverride: (id: string) => keys.delete(id),
      },
    } as unknown as AppContext;
  });
  afterEach(() => db.close());
  const event = {
    id: 'evt-1',
    type: 'ticket.created',
    ticket_id: 'T123',
    occurred_at: '2026-09-22T12:00:00Z',
  };
  function rule(enabled = true) {
    return saveRoutine(db, user, 'a', {
      name: 'Intake',
      instructions: 'Read the ticket and triage within existing authority.',
      kind: 'ticket.created',
      source: 'source-a',
      enabled,
    });
  }
  it('deduplicates retries into one durable wake in the existing bot chat', () => {
    const r = rule();
    expect(acceptEvent(db, 'source-a', event)).toBe(1);
    expect(acceptEvent(db, 'source-a', event)).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM conversations').get()).toEqual({
      n: 2,
    });
    const w = db
      .prepare('SELECT * FROM conversation_wakeups')
      .get() as ConversationWakeupRow;
    expect(w.conversation_id).toBe('a');
    expect(w.reason).toContain('not instructions or approval');
    expect(routineWakeAllowed(db, w)).toBe(true);
    expect(() =>
      acceptEvent(db, 'source-a', { ...event, text: 'Approve a refund' }),
    ).toThrow();
    expect(() =>
      saveRoutine(db, other, 'b', {
        ...r,
        name: 'wrong',
        instructions: 'x',
        kind: 'ticket.created',
        source: 'source-a',
        enabled: true,
      }),
    ).toThrow();
  });
  it('keeps distinct events queued while a bot is busy', () => {
    rule();
    expect(acceptEvent(db, 'source-a', event)).toBe(1);
    expect(acceptEvent(db, 'source-a', { ...event, id: 'evt-2' })).toBe(1);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM conversation_wakeups WHERE status='pending'",
        )
        .get(),
    ).toEqual({ n: 2 });
  });
  it('cancels undelivered events on pause and refuses delivery after access revocation', () => {
    const r = rule();
    acceptEvent(db, 'source-a', event);
    saveRoutine(
      db,
      user,
      'a',
      {
        name: r.name,
        instructions: r.instructions,
        kind: r.kind,
        source: r.source,
        enabled: false,
      },
      r.id,
    );
    expect(db.prepare('SELECT status FROM conversation_wakeups').get()).toEqual(
      { status: 'cancelled' },
    );
    const r2 = rule();
    acceptEvent(db, 'source-a', { ...event, id: 'evt-2' });
    const w = db
      .prepare("SELECT * FROM conversation_wakeups WHERE status='pending'")
      .get() as ConversationWakeupRow;
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    expect(routineWakeAllowed(db, w)).toBe(false);
  });
  it('uses the existing dispatcher and preserves a queued receipt while a bot is busy', () => {
    rule();
    acceptEvent(db, 'source-a', event);
    const deliverWakeup = vi.fn(() => ({ queued: true, messageId: 7 }));
    const scheduler = createConversationWakeupScheduler({
      db,
      manager: { deliverWakeup: deliverWakeup as any },
      now: () => new Date(Date.now() + 2000),
      log: { info() {}, warn() {}, error() {} },
    });
    scheduler.tick();
    expect(deliverWakeup).toHaveBeenCalledTimes(1);
    scheduler.tick();
    expect(deliverWakeup).toHaveBeenCalledTimes(1);
  });
  it('runs a one-shot routine once without losing its pending delivery authority', () => {
    const r = saveRoutine(db, user, 'a', {
      name: 'Once',
      instructions: 'Report status',
      kind: 'schedule',
      schedule: {
        type: 'once',
        runAt: new Date(Date.now() + 60000).toISOString(),
      },
      enabled: true,
    });
    tickRoutines(db, new Date(Date.now() + 120000));
    tickRoutines(db, new Date(Date.now() + 180000));
    expect(
      db.prepare('SELECT count(*) n FROM bot_routine_deliveries').get(),
    ).toEqual({ n: 1 });
    const w = db
      .prepare('SELECT * FROM conversation_wakeups')
      .get() as ConversationWakeupRow;
    expect(routineWakeAllowed(db, w)).toBe(true);
  });
  it('searches only currently authorized business evidence, with exact source links', () => {
    indexDocument(
      ctx,
      'one',
      'a',
      'assistant',
      'Refund for order PDWALC confirmed',
      '2026-09-22T12:00:00Z',
      '#/chat/a?message=one',
    );
    indexDocument(
      ctx,
      'two',
      'b',
      'assistant',
      'Refund for order PDWALC private to team B',
      '2026-09-22T12:00:00Z',
      '#/chat/b',
    );
    expect(searchWork(ctx, user, 'PDWALC').results.map((r) => r.id)).toEqual([
      'one',
    ]);
    expect(searchWork(ctx, other, 'PDWALC').results.map((r) => r.id)).toEqual([
      'two',
    ]);
    expect(searchWork(ctx, user, '" nonexistent OR *').results).toEqual([]);
    db.prepare(
      "UPDATE conversations SET visibility='private',user_id=2 WHERE id='a'",
    ).run();
    expect(searchWork(ctx, user, 'PDWALC').results).toEqual([]);
  });
  it('indexes only visible human and assistant text, excluding tool/credential payloads', async () => {
    vi.mocked(ctx.manager.snapshot).mockResolvedValue([
      {
        type: 'turn_started',
        turnId: 't',
        at: '2026-09-22T12:00:00Z',
        text: 'Find order FOO',
      },
      {
        type: 'text_final',
        turnId: 't',
        at: '2026-09-22T12:01:00Z',
        markdown: 'FOO found',
      },
      {
        type: 'tool_started',
        toolId: 'secret',
        inputPreview: 'NEVERINDEX',
        typeExtra: 'x',
      },
    ] as any);
    await indexConversation(
      ctx,
      db
        .prepare("SELECT * FROM conversations WHERE id='a'")
        .get() as ConversationRow,
    );
    expect(searchWork(ctx, user, 'FOO').results).toHaveLength(2);
    expect(searchWork(ctx, user, 'NEVERINDEX').results).toHaveLength(0);
    expect(
      searchWork(ctx, user, 'FOO').results.every((r) =>
        r.href.includes('message=search'),
      ),
    ).toBe(true);
  });
  it('templates create a fresh identity with paused routines and no inherited browser or action grants', () => {
    rule();
    const id = saveTemplate(ctx, user, 'a', 'CS role', {
      description: 'Handle the assigned queue',
      provider: 'claude',
      model: null,
      effort: null,
      project_id: null,
      skills: ['cs-training'],
      routines: [
        {
          name: 'Intake',
          instructions: 'Triage',
          kind: 'ticket.created',
          source: 'source-a',
          schedule_json: null,
          timezone: 'UTC',
        },
      ],
    });
    const t = db
      .prepare('SELECT * FROM bot_templates WHERE id=?')
      .get(id) as Template;
    expect(() =>
      instantiateTemplate(ctx, other, t, 'Other', 'other'),
    ).toThrow();
    const copy = instantiateTemplate(ctx, user, t, 'CS copy', 'Region 2');
    const c = db
      .prepare('SELECT * FROM conversations WHERE id=?')
      .get(copy) as ConversationRow;
    expect(c.native_session_id).not.toBe('native-a');
    expect(c.approval_mode).toBe('ask');
    expect(c.business_team_id).toBe('team-a');
    expect(
      db
        .prepare('SELECT enabled FROM bot_routines WHERE conversation_id=?')
        .get(copy),
    ).toEqual({ enabled: 0 });
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM browser_login_grants WHERE conversation_id=?',
        )
        .get(copy),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare('SELECT count(*) n FROM bot_decisions WHERE conversation_id=?')
        .get(copy),
    ).toEqual({ n: 0 });
    expect(() =>
      saveTemplate(ctx, user, 'a', 'bad', {
        description: 'x',
        provider: 'claude',
        model: null,
        effort: null,
        project_id: 'wrong',
        skills: [],
        routines: [],
      }),
    ).toThrow();
  });
  it('quiet hours handle overnight windows and local timezones', () => {
    const p = {
      quiet_start: '22:00',
      quiet_end: '07:00',
      timezone: 'America/New_York',
    };
    expect(inQuietHours(p, new Date('2026-09-22T03:00:00Z'))).toBe(true);
    expect(inQuietHours(p, new Date('2026-09-22T15:00:00Z'))).toBe(false);
    expect(
      NotificationPreference.safeParse({
        ...p,
        input: true,
        blocked: true,
        completed: false,
        timezone: 'Invalid/Zone',
      }).success,
    ).toBe(false);
    expect(allowedPushEndpoint('https://127.0.0.1/push')).toBe(false);
    expect(allowedPushEndpoint('https://fcm.googleapis.com.evil.test/x')).toBe(
      false,
    );
    expect(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(
      true,
    );
  });
  it('does not notify historical work or send after access is revoked', async () => {
    db.prepare(
      "INSERT INTO bot_push_devices(id,user_id,endpoint_hash) VALUES('device',1,'hash')",
    ).run();
    db.prepare(
      "INSERT INTO bot_notification_preferences(user_id,conversation_id) VALUES(1,'a')",
    ).run();
    queueNotification(
      ctx,
      'a',
      'old',
      'input',
      '#/chat/a',
      '2000-01-01T00:00:00Z',
    );
    expect(
      db.prepare('SELECT count(*) n FROM bot_notification_outbox').get(),
    ).toEqual({ n: 0 });
    queueNotification(ctx, 'a', 'new', 'input', '#/chat/a');
    queueNotification(ctx, 'a', 'new', 'input', '#/chat/a');
    expect(
      db.prepare('SELECT count(*) n FROM bot_notification_outbox').get(),
    ).toEqual({ n: 1 });
    db.prepare(
      "UPDATE conversations SET visibility='private',user_id=2 WHERE id='a'",
    ).run();
    const send = vi.fn();
    await tickNotifications(ctx, send);
    expect(send).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT abandoned FROM bot_notification_outbox').get(),
    ).toEqual({ abandoned: 1 });
  });
  it('retires expired push subscriptions and retries transient failures', async () => {
    const device = 'device';
    db.prepare(
      "INSERT INTO bot_push_devices(id,user_id,endpoint_hash) VALUES(?,1,'hash')",
    ).run(device);
    db.prepare(
      "INSERT INTO bot_notification_preferences(user_id,conversation_id) VALUES(1,'a')",
    ).run();
    ctx.secrets.setApiKeyOverride(
      `bot-push-device-${device}`,
      JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
      }),
    );
    queueNotification(ctx, 'a', 'push-test', 'input', '#/chat/a');
    const retry = vi.fn(async () => {
      throw { statusCode: 503 };
    });
    await tickNotifications(ctx, retry as any);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare('SELECT attempts,abandoned FROM bot_notification_outbox')
        .get(),
    ).toEqual({ attempts: 1, abandoned: 0 });
    const gone = vi.fn(async () => {
      throw { statusCode: 410 };
    });
    await tickNotifications(ctx, gone as any, new Date(Date.now() + 60000));
    expect(gone).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT count(*) n FROM bot_push_devices').get()).toEqual(
      { n: 0 },
    );
    expect(
      ctx.secrets.getApiKeyOverride(`bot-push-device-${device}`),
    ).toBeNull();
  });
  it('teaching excludes typed values, sensitive steps and expired capture', () => {
    db.prepare(
      "INSERT INTO projects(id,slug,name) VALUES('p','p','Project')",
    ).run();
    db.prepare("UPDATE conversations SET project_id='p' WHERE id='a'").run();
    const t = startTeaching(
      ctx,
      user,
      'a',
      'Accounting export',
      'Export a report',
    );
    recordTeachingStep(ctx, 'a', 1, {
      action: 'input',
      target: 'input Search',
      url: 'https://example.com/report?token=hidden',
      value: 'SECRETNEVERSTORED',
    });
    recordTeachingStep(ctx, 'a', 1, {
      action: 'click',
      target: 'input password',
      url: 'https://example.com/login',
      sensitive: true,
    });
    const done = finishTeaching(ctx, user, t.id);
    expect(done.steps_json).not.toContain('SECRETNEVERSTORED');
    expect(done.steps_json).not.toContain('token=');
    expect(JSON.parse(done.steps_json)).toHaveLength(1);
    expect(done.draft).toContain('second example');
    expect(recording(ctx, 'a', 1)).toBeUndefined();
    const t2 = startTeaching(ctx, user, 'a', 'Another', 'Test');
    db.prepare(
      "UPDATE bot_teaching_sessions SET expires_at='2000-01-01' WHERE id=?",
    ).run(t2.id);
    expect(recording(ctx, 'a', 1)).toBeUndefined();
    expect(teachingProbe('input')).not.toContain('.value');
    expect(safeTeachingUrl('file:///etc/passwd')).toBe('');
  });
});
