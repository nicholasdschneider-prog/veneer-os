import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const entryPoints = [
  { path: '../components/chat/ArtifactsStrip.tsx', uses: 2 },
  { path: '../components/chat/ArtifactPanel.tsx', uses: 2 },
  { path: '../screens/Chat.tsx', uses: 1 },
  { path: '../screens/Files.tsx', uses: 2 },
];

describe('file download entry points', () => {
  it.each(entryPoints)('$path uses the PWA-safe download control', ({ path, uses }) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const componentReferences = source.match(/<FileDownloadLink\b/g) ?? [];

    expect(componentReferences).toHaveLength(uses);
    expect(source).not.toMatch(/\bdownload=\{/);
  });
});
