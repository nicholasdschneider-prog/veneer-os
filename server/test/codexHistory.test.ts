import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCodexHistory, readCodexHistoryFiles, recordCodexFork } from '../src/providers/codex/history.js';
import { appendShadowFiles, appendShadowTranscript } from '../src/providers/codex/transcript.js';

let root: string;
let dirs: { transcriptsDir: string; legacyTranscriptsDir: string };
let previousHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-'));
  dirs = { transcriptsDir: path.join(root, 'current'), legacyTranscriptsDir: path.join(root, 'legacy') };
  fs.mkdirSync(dirs.transcriptsDir);
  fs.mkdirSync(dirs.legacyTranscriptsDir);
  previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function text(dir: string, id: string, markdown: string) {
  appendShadowTranscript(dir, id, [{ type: 'text_final', turnId: markdown, markdown, at: '2026-09-08T12:00:00Z' }]);
}

async function messages(id: string) {
  return (await readCodexHistory(dirs, id)).filter((e) => e.type === 'text_final').map((e) => e.markdown);
}

function nativeParent(child: string, parent: string, payloadId = child) {
  const dir = path.join(root, 'sessions', '2026', '09', '08');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-test-${child}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: payloadId, forked_from_id: parent },
  }) + '\n' + JSON.stringify({ type: 'response_item', payload: { content: 'Native body must never become a chat event' } }) + '\n');
}

describe('Codex visible history across instruction forks', () => {
  it('keeps legacy, parent, and child messages in order across repeated forks and reads', async () => {
    text(dirs.legacyTranscriptsDir, 'parent', 'legacy');
    text(dirs.transcriptsDir, 'parent', 'parent');
    await recordCodexFork(dirs, 'child', 'parent');
    text(dirs.transcriptsDir, 'child', 'child');
    await recordCodexFork(dirs, 'grandchild', 'child');
    text(dirs.transcriptsDir, 'grandchild', 'grandchild');
    expect(await messages('grandchild')).toEqual(['legacy', 'parent', 'child', 'grandchild']);
    expect(await messages('grandchild')).toEqual(['legacy', 'parent', 'child', 'grandchild']);
  });

  it('freezes inherited bytes while the child continues appending', async () => {
    text(dirs.transcriptsDir, 'parent', 'original');
    await recordCodexFork(dirs, 'child', 'parent');
    text(dirs.transcriptsDir, 'parent', 'later parent work');
    text(dirs.legacyTranscriptsDir, 'parent', 'later legacy work');
    text(dirs.transcriptsDir, 'child', 'new child work');
    expect(await messages('child')).toEqual(['original', 'new child work']);
  });

  it('preserves inherited file refs without duplicates or later parent refs', async () => {
    appendShadowFiles(dirs.transcriptsDir, 'parent', [{ path: '/tmp/outline.png', source: 'write' }]);
    await recordCodexFork(dirs, 'child', 'parent');
    appendShadowFiles(dirs.transcriptsDir, 'parent', [{ path: '/tmp/later.png', source: 'write' }]);
    appendShadowFiles(dirs.transcriptsDir, 'child', [{ path: '/tmp/outline.png', source: 'bash' }, { path: '/tmp/new.png', source: 'bash' }]);
    expect(await readCodexHistoryFiles(dirs, 'child')).toEqual([
      { path: '/tmp/outline.png', source: 'write' }, { path: '/tmp/new.png', source: 'bash' },
    ]);
  });

  it('recovers already-forked chats from native ancestry using only normalized messages', async () => {
    const parent = '00000000-0000-0000-0000-000000000001';
    const child = '00000000-0000-0000-0000-000000000002';
    text(dirs.transcriptsDir, parent, 'Original image reply');
    text(dirs.transcriptsDir, child, 'After restart');
    nativeParent(child, parent);
    expect(await messages(child)).toEqual(['Original image reply', 'After restart']);
    expect(fs.existsSync(path.join(dirs.transcriptsDir, `${child}.parent.json`))).toBe(false);
  });

  it('rejects traversal, mismatched metadata and cyclic ancestry without duplicating history', async () => {
    text(dirs.transcriptsDir, 'child', 'child');
    await expect(recordCodexFork(dirs, 'child', '../outside')).rejects.toThrow('Invalid');
    await expect(recordCodexFork(dirs, 'child', 'child')).rejects.toThrow('Invalid');
    fs.writeFileSync(path.join(dirs.transcriptsDir, 'child.parent.json'), JSON.stringify({ sessionId: '../outside' }));
    expect(await messages('child')).toEqual(['child']);
    fs.writeFileSync(path.join(dirs.transcriptsDir, 'child.parent.json'), JSON.stringify({ sessionId: 'child' }));
    expect(await messages('child')).toEqual(['child']);
    const id = '00000000-0000-0000-0000-000000000002';
    nativeParent(id, '00000000-0000-0000-0000-000000000001', 'wrong-id');
    expect(await messages(id)).toEqual([]);
  });

  it('keeps the child readable when its parent file is missing or a size is invalid', async () => {
    await recordCodexFork(dirs, 'child', 'missing');
    text(dirs.transcriptsDir, 'child', 'child');
    expect(await messages('child')).toEqual(['child']);
    fs.writeFileSync(path.join(dirs.transcriptsDir, 'child.parent.json'), JSON.stringify({ sessionId: 'parent', transcriptBytes: -1 }));
    expect(await messages('child')).toEqual(['child']);
  });
});
