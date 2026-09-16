import { describe, expect, it, vi } from 'vitest';
import {
  buildRememberedContext,
  globalMemoryContainerTag,
  profileMemoryContainerTag,
  projectMemoryContainerTag,
  type MemoryRecord,
  type SupermemoryClient,
} from '../src/memory/supermemory.js';

const USER_ID = 7;
const PROJECT_ID = 'veneer-pro';

function memory(id: string, content: string, similarity: number): MemoryRecord {
  return { id, content, similarity, isStatic: false, createdAt: null, updatedAt: null, metadata: {} };
}

function fixtureClient(rows: Record<string, MemoryRecord[]>): SupermemoryClient {
  return {
    configured: true,
    addMemory: vi.fn(),
    listMemories: vi.fn(async () => []),
    searchMemories: vi.fn(async ({ containerTag }) => rows[containerTag] ?? []),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    getProfile: vi.fn(async () => null),
  };
}

describe('memory recall quality fixture', () => {
  it('keeps request-specific facts, allows zero, and rejects recurring production noise', async () => {
    const profile = profileMemoryContainerTag(USER_ID);
    const global = globalMemoryContainerTag(USER_ID);
    const project = projectMemoryContainerTag(USER_ID, PROJECT_ID);
    const cases = [
      {
        name: 'Fable header',
        query: 'https://scrnsnp.com/example.png Add the Fable label to the chat header.',
        rows: {
          [global]: [memory('riverside', 'The demo booth is B-47 in Riverside Hall for the August open-house.', 0.61)],
          [project]: [
            memory('fable', 'Fable chats should show a Fable label in the chat header.', 0.84),
            memory('providers', 'Veneer Pro has generic Claude and Codex provider defaults.', 0.64),
            memory('subagent-ui', 'Sub-agent transcript rows render beneath the parent agent.', 0.63),
          ],
        },
        expected: ['project:fable'],
      },
      { name: 'low-signal test', query: 'test', rows: { [global]: [memory('riverside', 'Riverside Hall booth B-47.', 0.9)] }, expected: [] },
      {
        name: 'build queue',
        query: 'Please get this implementation into the build queue.',
        rows: {
          [global]: [
            memory('queue-a', 'Implementation work should join the build queue by default.', 0.88),
            memory('queue-b', 'By default, all implementation work belongs in the build queue.', 0.84),
          ],
        },
        expected: ['global:queue-a'],
      },
      {
        name: 'inbox review',
        query: 'Review my inbox and tell me which threads need a reply.',
        rows: {
          [profile]: [memory('inbox', 'When reviewing the inbox, check the latest message before flagging a thread for reply.', 0.9)],
          [project]: [memory('runner', 'The web and runner services communicate over loopback IPC.', 0.64)],
        },
        expected: ['profile:inbox'],
      },
      {
        name: 'voice follow-up',
        query: 'Continue the voice session and send the confirmed prompt.',
        rows: {
          [project]: [memory('voice', 'Voice sessions attach to an existing chat and can send a confirmed prompt.', 0.88)],
          [global]: [memory('riverside', 'The open-house booth is in Riverside Hall.', 0.62)],
        },
        expected: ['project:voice'],
      },
      {
        name: 'open-house booth',
        query: 'What is our open-house booth assignment and hall?',
        rows: {
          [global]: [memory('riverside', 'The open-house booth assignment is B-47 in Riverside Hall.', 0.92)],
          [project]: [memory('providers', 'Veneer Pro supports several agent providers.', 0.63)],
        },
        expected: ['global:riverside'],
      },
    ];

    let selectedTotal = 0;
    let relevantSelected = 0;
    let mustHave = 0;
    let mustHaveFound = 0;
    let capHits = 0;
    let emptyResults = 0;

    for (const fixture of cases) {
      const client = fixtureClient(fixture.rows);
      const result = await buildRememberedContext({
        client,
        userId: USER_ID,
        projectId: PROJECT_ID,
        query: fixture.query,
      });
      const selected = result.memories.map((item) => item.id);
      expect(selected, fixture.name).toEqual(fixture.expected);
      selectedTotal += selected.length;
      relevantSelected += selected.filter((id) => fixture.expected.includes(id)).length;
      mustHave += fixture.expected.length;
      mustHaveFound += fixture.expected.filter((id) => selected.includes(id)).length;
      if (selected.length >= 3) capHits += 1;
      if (!selected.length) emptyResults += 1;
    }

    const precisionAtK = selectedTotal ? relevantSelected / selectedTotal : 1;
    const mustHaveRecall = mustHave ? mustHaveFound / mustHave : 1;
    expect(precisionAtK).toBe(1);
    expect(mustHaveRecall).toBe(1);
    expect(selectedTotal / cases.length).toBeLessThanOrEqual(1);
    expect(capHits).toBe(0);
    expect(emptyResults).toBeGreaterThanOrEqual(1);
  });
});
