import fs from 'node:fs';
import path from 'node:path';
import type { CreatedFileRef } from '../providers/types.js';

export interface SessionFileView {
  name: string;
  path: string;
  size: number;
  mtime: number;
  source: 'write' | 'bash';
}

export function sessionFileView(ref: CreatedFileRef, createdAtMs: number): SessionFileView | null {
  try {
    const canonicalPath = fs.realpathSync(ref.path);
    const st = fs.statSync(canonicalPath);
    if (!st.isFile()) return null;
    if (ref.source === 'bash' && st.mtimeMs < createdAtMs) return null;
    return {
      name: path.basename(canonicalPath),
      path: canonicalPath,
      size: st.size,
      mtime: st.mtimeMs,
      source: ref.source,
    };
  } catch {
    return null;
  }
}
