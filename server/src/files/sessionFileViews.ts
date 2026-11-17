import fs from 'node:fs';
import path from 'node:path';
import type { CreatedFileRef } from '../providers/types.js';

export interface SessionFileView {
  name: string;
  path: string;
  size: number;
  mtime: number;
  source: 'write' | 'bash';
  /** Other absolute paths the chat used for this file, such as a symlinked
   * folder that now lives on another disk. Markdown links may use any of them. */
  aliases?: string[];
}

export function sessionFileView(ref: CreatedFileRef, createdAtMs: number): SessionFileView | null {
  try {
    const canonicalPath = fs.realpathSync(ref.path);
    const st = fs.statSync(canonicalPath);
    if (!st.isFile()) return null;
    if (ref.source === 'bash' && st.mtimeMs < createdAtMs) return null;
    const referenced = path.resolve(ref.path);
    return {
      name: path.basename(canonicalPath),
      path: canonicalPath,
      size: st.size,
      mtime: st.mtimeMs,
      source: ref.source,
      ...(referenced !== canonicalPath ? { aliases: [referenced] } : {}),
    };
  } catch {
    return null;
  }
}

/** One view per canonical file; the paths the chat used for it become aliases. */
export function sessionFileViews(refs: readonly CreatedFileRef[], createdAtMs: number): SessionFileView[] {
  const byPath = new Map<string, SessionFileView>();
  for (const ref of refs) {
    const view = sessionFileView(ref, createdAtMs);
    if (!view) continue;
    const existing = byPath.get(view.path);
    if (!existing) {
      byPath.set(view.path, view);
      continue;
    }
    if (view.source === 'write') existing.source = 'write';
    for (const alias of view.aliases ?? []) {
      if (!existing.aliases?.includes(alias)) existing.aliases = [...(existing.aliases ?? []), alias];
    }
  }
  return [...byPath.values()];
}
