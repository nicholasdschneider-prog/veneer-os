import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionFile } from '../../lib/api';
import type { AppArtifact, Artifact, FileArtifact, PageArtifact } from '../../lib/artifacts';
import { ArtifactsStrip } from './ArtifactsStrip';

const page: PageArtifact = {
  type: 'page',
  id: 'page-1',
  title: 'Published summary',
  slug: 'published-summary',
  url: 'https://pages.example.com/p/published-summary',
  updatedAt: '2026-07-31T12:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const app: AppArtifact = {
  type: 'app',
  id: 'app-1',
  title: 'Forecast tool',
  slug: 'forecast-tool',
  url: 'https://veneer.example/tools/forecast-tool',
  runtime: 'cloudflare',
  status: 'deployed',
  lastError: null,
  updatedAt: '2026-07-31T12:00:00.000Z',
};

const file = (id: string): FileArtifact => ({
  type: 'file',
  id,
  name: `${id}.png`,
  path: `/tmp/${id}.png`,
  size: 1024,
  kind: 'image',
  updatedAt: '2026-07-31T12:00:00.000Z',
});

function render(artifacts: Artifact[], sessionFiles: SessionFile[] = []) {
  return renderToStaticMarkup(
    <ArtifactsStrip
      conversationId="chat-1"
      artifacts={artifacts}
      sessionFiles={sessionFiles}
      onOpenArtifact={vi.fn()}
      onOpenSessionFile={vi.fn()}
    />,
  );
}

const csv: FileArtifact = {
  type: 'file',
  id: 'q3-report',
  name: 'q3-report.csv',
  path: '/tmp/q3-report.csv',
  size: 4096,
  kind: 'csv',
  updatedAt: '2026-07-31T12:00:00.000Z',
};

describe('ArtifactsStrip', () => {
  it('renders expanded by default with a collapse toggle on the header', () => {
    const html = render([page, file('one')]);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Artifacts from this chat');
    expect(html).toContain('aria-label="Preview Published summary"');
  });

  it('gives the page card a thumbnail image URL', () => {
    const html = render([page]);

    expect(html).toContain('src="/api/pages/page-1/thumbnail"');
  });

  it('promotes csv files to the primary row with a preview card', () => {
    const html = render([page, csv, file('one'), file('two'), file('three'), file('four')]);

    expect(html).toContain('aria-label="Preview q3-report.csv"');
    expect(html).toContain('CSV · 4 KB');
    expect(html).toContain('4 artifacts');
    expect(html).not.toContain('5 artifacts');
  });

  it('keeps published pages and apps visible while file artifacts collapse', () => {
    const html = render([page, app, file('one'), file('two'), file('three'), file('four')]);

    expect(html).toContain('aria-label="Preview Published summary"');
    expect(html).toContain('aria-label="Preview Forecast tool"');
    expect(html).toContain('4 artifacts');
    expect(html).not.toContain('6 artifacts');
  });

  it('preserves the collapse rule for ordinary files', () => {
    const html = render([file('one'), file('two'), file('three'), file('four')]);

    expect(html).toContain('4 artifacts');
    expect(html).not.toContain('aria-label="Preview one.png"');
  });

  it('keeps only the durable artifact when a session file uses a macOS alias path', () => {
    const durable = { ...file('mention-chip'), path: '/private/tmp/mention-chip.png' };
    const session: SessionFile = {
      name: 'mention-chip.png',
      path: '/tmp/mention-chip.png',
      size: 1024,
      mtime: 1,
      source: 'bash',
    };

    const html = render([durable], [session]);

    expect(html.match(/aria-label="Preview mention-chip\.png"/g)).toHaveLength(1);
    expect(html).toContain('/api/generated-files/mention-chip/download/mention-chip.png');
    expect(html).not.toContain('/api/conversations/chat-1/files/content');
  });
});
