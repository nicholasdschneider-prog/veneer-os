import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRow } from '../src/db/db.js';
import {
  claudeCuratorArgs,
  codexCuratorArgs,
  curateConversationMemory,
  isFeatureLocalizedMemory,
  isSensitiveMemory,
  isTransientMemory,
  runCuratorModelWithFallback,
} from '../src/memory/curator.js';
import type { SupermemoryClient } from '../src/memory/supermemory.js';

function conversation(projectId: string | null = null): ConversationRow {
  return {
    id: 'conv-1', assistant_id: 1, user_id: 7, visibility: 'team', project_id: projectId, title: 'Test', title_auto: 0,
    provider: 'codex', model: null, effort: null, approval_mode: null, native_session_id: 'native-1',
    origin_conversation_id: null, channel: 'web', archived: 0, pin_order: null,
    created_at: '2026-07-22 00:00:00', last_active_at: '2026-07-22 00:00:00',
    last_input_tokens: null, files_synced_at: null,
  };
}

function client(): SupermemoryClient {
  return {
    configured: true,
    addMemory: vi.fn(async ({ content, isStatic = false, metadata = {} }) => ({
      id: 'saved-1', content, isStatic, metadata, createdAt: null, updatedAt: null, similarity: null,
    })),
    listMemories: vi.fn(async () => []),
    searchMemories: vi.fn(async () => []),
    updateMemory: vi.fn(async () => null),
    deleteMemory: vi.fn(async () => null),
    getProfile: vi.fn(async () => null),
  };
}

describe('Luna memory curator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE conversations (id TEXT PRIMARY KEY);
      CREATE TABLE memory_suggestions (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, conversation_id TEXT, project_id TEXT,
        scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, evidence TEXT NOT NULL,
        replace_memory_id TEXT NOT NULL DEFAULT '',
        is_static INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'suggested',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
      );
      INSERT INTO users (id) VALUES (7);
      INSERT INTO conversations (id) VALUES ('conv-1');
    `);
  });

  it('uses Luna at xhigh and Haiku at medium', () => {
    const codexArgs = codexCuratorArgs('/tmp/schema.json', '/tmp/output.json', '/tmp/work');
    const claudeArgs = claudeCuratorArgs();

    expect(codexArgs).toEqual(expect.arrayContaining([
      '--model', 'gpt-5.6-luna', '--config', 'model_reasoning_effort="xhigh"',
    ]));
    expect(claudeArgs).toEqual(expect.arrayContaining([
      '--model', 'claude-haiku-4-5', '--effort', 'medium', '--tools', '',
    ]));
  });

  it('falls back to customer Claude when Codex fails', async () => {
    const codex = vi.fn(async () => { throw new Error('codex is not installed'); });
    const claude = vi.fn(async () => ({ candidates: [] }));

    const result = await runCuratorModelWithFallback({
      prompt: 'curate this',
      codexBin: 'codex',
      claudeBin: 'claude',
      runners: { codex, claude },
    });

    expect(result).toEqual({ candidates: [] });
    expect(codex).toHaveBeenCalledWith('curate this');
    expect(claude).toHaveBeenCalledWith('curate this');
  });

  it('returns a safe error when both customer providers fail', async () => {
    await expect(runCuratorModelWithFallback({
      prompt: 'private transcript text',
      codexBin: 'codex',
      claudeBin: 'claude',
      runners: {
        codex: async () => { throw new Error('codex detail'); },
        claude: async () => { throw new Error('claude detail'); },
      },
    })).rejects.toThrow('Automatic memory curation could not use Codex Luna or Claude Haiku.');
  });

  it('saves only high-confidence, user-supported, non-sensitive memories', async () => {
    const memory = client();
    const result = await curateConversationMemory({
      db,
      client: memory,
      codexBin: 'codex',
      conversation: conversation(),
      messages: [
        { role: 'user', content: 'I prefer concise status updates. My bank account ending in 9416 is at Chase.' },
        { role: 'assistant', content: 'The user lives on 123 Main Street.' },
      ],
      runModel: async () => ({
        candidates: [
          {
            content: 'The user prefers concise status updates.', operation: 'new', scope: 'profile', kind: 'preference',
            confidence: 'high', basis: 'user_statement', isStatic: false,
            durability: 'indefinite',
            reuse: 'frequent',
            breadth: 'cross_context',
            evidence: 'I prefer concise status updates.', replaceId: '',
          },
          {
            content: 'The user has a Chase bank account ending in 9416.', operation: 'new', scope: 'profile', kind: 'fact',
            confidence: 'high', basis: 'user_statement', isStatic: false,
            durability: 'indefinite',
            reuse: 'frequent',
            breadth: 'cross_context',
            evidence: 'My bank account ending in 9416 is at Chase.', replaceId: '',
          },
          {
            content: 'The user lives on 123 Main Street.', operation: 'new', scope: 'profile', kind: 'identity',
            confidence: 'high', basis: 'user_statement', isStatic: true,
            durability: 'indefinite',
            reuse: 'frequent',
            breadth: 'cross_context',
            evidence: 'The user lives on 123 Main Street.', replaceId: '',
          },
        ],
      }),
    });

    expect(result.saved.map((item) => item.content)).toEqual(['The user prefers concise status updates.']);
    expect(result.skipped).toHaveLength(2);
    expect(memory.addMemory).toHaveBeenCalledTimes(1);
    expect(memory.addMemory).toHaveBeenCalledWith(expect.objectContaining({
      containerTag: 'veneer-user:7:profile',
      content: 'The user prefers concise status updates.',
    }));
  });

  it('queues medium-confidence project memories for review', async () => {
    db.exec("INSERT INTO projects (id) VALUES ('project-1')");
    const result = await curateConversationMemory({
      db,
      client: client(),
      codexBin: 'codex',
      conversation: conversation('project-1'),
      messages: [{ role: 'user', content: 'We may want the project dashboard to default to weekly totals.' }],
      runModel: async () => ({
        candidates: [{
          content: 'The project dashboard should default to weekly totals.', operation: 'new', scope: 'project', kind: 'decision',
          confidence: 'medium', basis: 'user_statement', isStatic: false,
          durability: 'project_lifetime',
          reuse: 'occasional',
          breadth: 'feature_area',
          evidence: 'We may want the project dashboard to default to weekly totals.', replaceId: '',
        }],
      }),
    });

    expect(result.suggested).toHaveLength(1);
    expect(db.prepare('SELECT scope, project_id, status FROM memory_suggestions').get()).toEqual({
      scope: 'project', project_id: 'project-1', status: 'suggested',
    });
  });

  it('holds occasional-use facts for review and rejects unlikely-use facts', async () => {
    db.exec("INSERT INTO projects (id) VALUES ('project-1')");
    const result = await curateConversationMemory({
      db,
      client: client(),
      codexBin: 'codex',
      conversation: conversation('project-1'),
      messages: [{ role: 'user', content: 'Use bronze for exports. The repository uses Vite.' }],
      runModel: async () => ({
        candidates: [
          {
            content: 'Project exports should use bronze accents.', operation: 'new', scope: 'project', kind: 'preference',
            confidence: 'high', durability: 'project_lifetime', reuse: 'occasional',
            breadth: 'feature_area',
            basis: 'user_statement', isStatic: false, evidence: 'Use bronze for exports.', replaceId: '',
          },
          {
            content: 'The repository uses Vite.', operation: 'new', scope: 'project', kind: 'fact',
            confidence: 'high', durability: 'project_lifetime', reuse: 'unlikely',
            breadth: 'project_wide',
            basis: 'user_statement', isStatic: false, evidence: 'The repository uses Vite.', replaceId: '',
          },
        ],
      }),
    });

    expect(result.suggested.map((item) => item.content)).toEqual(['Project exports should use bronze accents.']);
    expect(result.rejectionReasons).toEqual(['low_future_utility']);
  });

  it('recognizes common private identifiers', () => {
    expect(isSensitiveMemory('Account ending in 9416')).toBe(true);
    expect(isSensitiveMemory('API key: abcdefghijklmnop')).toBe(true);
    expect(isSensitiveMemory('The user prefers short answers.')).toBe(false);
  });

  it('allows operational references to credential names and locations', () => {
    const allowed = [
      'Cloudflare token creation is never a blocker: Doppler example/prd has CLOUDFLARE_GLOBAL_API_KEY, which belongs to Cloudflare user owner@example.com and is Super Administrator on every Cloudflare account we manage. An agent can mint its own scoped API token. Never print the key or the new token.',
      'Cloudflare token creation is never a blocker: Doppler example/prd has the global key for the Cloudflare account login owner@example.com. An agent can mint its own scoped token and must never print either value.',
      "The Doppler project example (prd config) contains the owner's account-level Cloudflare credential for the acme-media login. Agents may use it to create their own scoped Cloudflare token.",
      "When a task needs a Cloudflare token we don't have yet, it is not a blocker: check the Doppler project example. It has owner-level Cloudflare access covering every Cloudflare account we manage, so an agent can create its own scoped token for the target account and store it in that client's Doppler project.",
      "Cloudflare API token creation is never a blocker. Doppler project example (config prd) holds CLOUDFLARE_GLOBAL_API_KEY for the Cloudflare user owner@example.com, who is Super Administrator on every Cloudflare account we manage (example, acme-media, tech@acme-parts.example, tech@acme-modular.example, acme-labs). Use it (X-Auth-Email + X-Auth-Key) to POST /user/tokens with a policy scoped to the target account/zone, store the new token in that client's Doppler project, verify it, and never print either value.",
    ];

    for (const memory of allowed) expect(isSensitiveMemory(memory)).toBe(false);
  });

  it('rejects actual credential values', () => {
    const rejected = [
      'API key: 0123456789abcdef0123456789abcdef01234567',
      'Shopify token shpat_0123456789abcdef0123456789abcdef',
      '-----BEGIN PRIVATE KEY-----\nabc123secretmaterial\n-----END PRIVATE KEY-----',
      'password=correct-horse-battery-staple',
      'Opaque value q3ZsP9vLm2Qx7Nc4Rt8Wy6Ua1Bk5Hj0EfdSi',
    ];

    for (const memory of rejected) expect(isSensitiveMemory(memory)).toBe(true);
  });

  it('routes localized product details to review even when the model overstates their breadth', async () => {
    db.exec("INSERT INTO projects (id) VALUES ('project-1')");
    const memory = client();
    const result = await curateConversationMemory({
      db,
      client: memory,
      codexBin: 'codex',
      conversation: conversation('project-1'),
      messages: [{ role: 'user', content: 'The mobile navigation should use icons only.' }],
      runModel: async () => ({
        candidates: [{
          content: 'The mobile navigation should use icons only.', operation: 'new', scope: 'project', kind: 'decision',
          confidence: 'high', durability: 'project_lifetime', reuse: 'frequent', breadth: 'project_wide',
          basis: 'user_statement', isStatic: false,
          evidence: 'The mobile navigation should use icons only.', replaceId: '',
        }],
      }),
    });

    expect(isFeatureLocalizedMemory('The mobile navigation should use icons only.')).toBe(true);
    expect(result.saved).toHaveLength(0);
    expect(result.suggested).toHaveLength(1);
    expect(memory.addMemory).not.toHaveBeenCalled();
  });

  it('scans the scope broadly and rejects a paraphrased existing memory', async () => {
    const memory = client();
    vi.mocked(memory.listMemories).mockImplementation(async ({ containerTag }) => containerTag.endsWith(':profile')
      ? [{
          id: 'existing-inbox',
          content: 'For inbox reviews, always check the latest message in each thread before flagging it for reply.',
          isStatic: false,
          createdAt: null,
          updatedAt: null,
          similarity: null,
          metadata: {},
        }]
      : []);
    const result = await curateConversationMemory({
      db,
      client: memory,
      codexBin: 'codex',
      conversation: conversation(),
      messages: [{ role: 'user', content: 'When reviewing emails, check the latest message in each thread before flagging it for a reply.' }],
      runModel: async () => ({ candidates: [{
        content: 'When reviewing emails, check the latest message in each thread before flagging it for a reply.',
        operation: 'new', scope: 'profile', kind: 'preference', confidence: 'high', durability: 'indefinite',
        reuse: 'frequent', breadth: 'cross_context', basis: 'user_statement', isStatic: false,
        evidence: 'When reviewing emails, check the latest message in each thread before flagging it for a reply.',
        replaceId: '',
      }] }),
    });

    expect(result.rejectionReasons).toEqual(['existing_duplicate']);
    expect(memory.listMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, page: 1 }));
    expect(memory.searchMemories).not.toHaveBeenCalled();
    expect(memory.addMemory).not.toHaveBeenCalled();
  });

  it('updates a superseded memory instead of adding another record', async () => {
    const memory = client();
    const existing = {
      id: 'old-frequency', content: 'The user prefers weekly inbox summaries.', isStatic: false,
      createdAt: null, updatedAt: null, similarity: null, metadata: {},
    };
    vi.mocked(memory.listMemories).mockImplementation(async ({ containerTag }) => containerTag.endsWith(':profile') ? [existing] : []);
    vi.mocked(memory.updateMemory).mockImplementation(async ({ id, content }) => ({ ...existing, id, content }));
    const result = await curateConversationMemory({
      db,
      client: memory,
      codexBin: 'codex',
      conversation: conversation(),
      messages: [{ role: 'user', content: 'I now prefer daily inbox summaries.' }],
      runModel: async () => ({ candidates: [{
        content: 'The user prefers daily inbox summaries.', operation: 'update', scope: 'profile', kind: 'preference',
        confidence: 'high', durability: 'indefinite', reuse: 'frequent', breadth: 'cross_context',
        basis: 'user_statement', isStatic: false, evidence: 'I now prefer daily inbox summaries.', replaceId: 'old-frequency',
      }] }),
    });

    expect(result.saved).toHaveLength(1);
    expect(memory.updateMemory).toHaveBeenCalledWith({
      containerTag: 'veneer-user:7:profile',
      id: 'old-frequency',
      content: 'The user prefers daily inbox summaries.',
    });
    expect(memory.addMemory).not.toHaveBeenCalled();
  });

  it('rejects facts already supplied by standing project instructions', async () => {
    db.exec("INSERT INTO projects (id) VALUES ('project-1')");
    const memory = client();
    const result = await curateConversationMemory({
      db,
      client: memory,
      codexBin: 'codex',
      conversation: conversation('project-1'),
      knownContext: 'All implementation work must join the build queue before any project files are changed.',
      messages: [{ role: 'user', content: 'All implementation work must join the build queue before any project files are changed.' }],
      runModel: async () => ({ candidates: [{
        content: 'All implementation work must join the build queue before any project files are changed.',
        operation: 'new', scope: 'project', kind: 'decision', confidence: 'high', durability: 'project_lifetime',
        reuse: 'frequent', breadth: 'project_wide', basis: 'user_statement', isStatic: false,
        evidence: 'All implementation work must join the build queue before any project files are changed.', replaceId: '',
      }] }),
    });

    expect(result.rejectionReasons).toEqual(['standing_context_restatement']);
    expect(memory.addMemory).not.toHaveBeenCalled();
  });

  it('rejects temporary work status and to-dos', () => {
    expect(isTransientMemory('In this project, fix isStatic after the queue work is complete.')).toBe(true);
    expect(isTransientMemory('Cap the Vast/Supermemory pilot spend at $3.')).toBe(true);
    expect(isTransientMemory('The dashboard should default to weekly totals.')).toBe(false);
  });
});
