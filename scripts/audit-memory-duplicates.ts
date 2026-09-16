/**
 * Read-only consolidation report for Supermemory. It intentionally never
 * updates or deletes records: review the JSON pairs in Settings → Memory and
 * use the existing edit/forget controls for any cleanup you approve.
 *
 * Run with the normal production environment, for example:
 *   doppler run -- npm run audit:memory-duplicates
 */
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db/db.js';
import {
  areNearDuplicateMemories,
  createSupermemoryClient,
  globalMemoryContainerTag,
  normalizeMemoryContent,
  profileMemoryContainerTag,
  projectMemoryContainerTag,
  type MemoryRecord,
} from '../server/src/memory/supermemory.js';

const config = loadConfig();
const db = openDb(config.dataDir);
const client = createSupermemoryClient({ baseUrl: config.supermemoryBaseUrl, apiKey: config.supermemoryApiKey });
if (!client.configured) throw new Error('SUPERMEMORY_API_KEY is not configured.');

async function listContainer(containerTag: string, max = 200): Promise<MemoryRecord[]> {
  const memories: MemoryRecord[] = [];
  for (let page = 1; memories.length < max; page += 1) {
    const requestLimit = Math.min(100, max - memories.length);
    const batch = await client.listMemories({ containerTag, limit: requestLimit, page });
    memories.push(...batch);
    if (batch.length < requestLimit) break;
  }
  return [...new Map(memories.map((memory) => [memory.id, memory])).values()];
}

const users = db.prepare('SELECT id FROM users ORDER BY id').all() as { id: number }[];
const report: Array<{
  userId: number;
  left: { id: string; containerTag: string; content: string };
  right: { id: string; containerTag: string; content: string };
}> = [];

for (const user of users) {
  const projectIds = db.prepare(
    'SELECT DISTINCT project_id FROM conversations WHERE user_id = ? AND project_id IS NOT NULL',
  ).all(user.id) as { project_id: string }[];
  const containerTags = [
    profileMemoryContainerTag(user.id),
    globalMemoryContainerTag(user.id),
    ...projectIds.map((row) => projectMemoryContainerTag(user.id, row.project_id)),
  ];
  const rows = (await Promise.all(containerTags.map(async (containerTag) =>
    (await listContainer(containerTag)).map((memory) => ({ containerTag, memory }))))).flat();

  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const left = rows[leftIndex]!;
      const right = rows[rightIndex]!;
      if (
        normalizeMemoryContent(left.memory.content) !== normalizeMemoryContent(right.memory.content) &&
        !areNearDuplicateMemories(left.memory.content, right.memory.content)
      ) continue;
      report.push({
        userId: user.id,
        left: { id: left.memory.id, containerTag: left.containerTag, content: left.memory.content },
        right: { id: right.memory.id, containerTag: right.containerTag, content: right.memory.content },
      });
    }
  }
}

process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), candidatePairs: report }, null, 2)}\n`);
db.close();
