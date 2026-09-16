import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PageArtifact } from '../../lib/artifacts';
import type { FileArtifact } from '../../lib/artifacts';
import { ArtifactPanel } from './ArtifactPanel';

const page: PageArtifact = {
  type: 'page',
  id: 'page-1',
  title: 'Updated page',
  slug: 'updated-page',
  url: 'https://pages.example.com/p/updated-page',
  updatedAt: '2026-07-29T18:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('ArtifactPanel page preview', () => {
  it('shows an accessible refresh control in the header', () => {
    const html = renderToStaticMarkup(
      <ArtifactPanel
        artifact={page}
        deletable
        isDesktop={false}
        revision={0}
        onClose={vi.fn()}
        onArtifactDeleted={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Refresh page preview"');
    expect(html.indexOf('Refresh page preview')).toBeLessThan(html.indexOf('Open in new tab'));
    expect(html).toContain('Published page · Expires in');
  });
});

const officeFile = (name: string): FileArtifact => ({
  type: 'file',
  id: `file-${name}`,
  name,
  path: `/tmp/${name}`,
  size: 4096,
  updatedAt: Date.now(),
  kind: 'other',
});

describe('ArtifactPanel office preview', () => {
  it.each([
    ['mobile DOCX', officeFile('Report.docx'), false],
    ['desktop XLSX', officeFile('Workbook.xlsx'), true],
  ])('uses the safe office preview on %s', (_label, artifact, isDesktop) => {
    const html = renderToStaticMarkup(
      <ArtifactPanel
        artifact={artifact}
        deletable
        isDesktop={isDesktop}
        revision={0}
        onClose={vi.fn()}
        onArtifactDeleted={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    expect(html).toContain('Preparing document preview…');
    expect(html).not.toContain('No preview for this file type');
    expect(html).toContain(`aria-label="Download ${artifact.name}"`);
  });
});

describe('ArtifactPanel HTML preview', () => {
  it('uses the shared rendered-first HTML viewer', () => {
    const artifact: FileArtifact = {
      ...officeFile('index.html'),
      kind: 'html',
    };
    const html = renderToStaticMarkup(
      <ArtifactPanel
        artifact={artifact}
        deletable
        isDesktop
        revision={0}
        onClose={vi.fn()}
        onArtifactDeleted={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    expect(html).toContain('Rendered');
    expect(html).toContain('Source');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Rendered/);
    expect(html).toContain('/api/generated-files/file-index.html/download?inline=1');
    expect(html).not.toContain('allow-same-origin');
  });
});
