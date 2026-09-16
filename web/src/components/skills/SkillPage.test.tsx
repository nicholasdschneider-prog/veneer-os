import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SkillMeta, SkillScopeGroup } from '@/lib/skills';
import { SkillPage } from './SkillPage';

const meta = (over: Partial<SkillMeta>): SkillMeta => ({
  scope: 'global',
  name: 'crewseating-access',
  displayName: null,
  description: 'Get past Cloudflare Access.',
  providers: { claude: 'ok', codex: 'ok', grok: 'ok' },
  shared: true,
  enabled: true,
  origin: 'user',
  readOnly: false,
  issues: [],
  hasExtraFiles: false,
  mtime: 1,
  entryKind: 'original',
  source: null,
  dependents: [],
  ...over,
});

const groups: SkillScopeGroup[] = [
  { scope: 'global', label: 'Global', kind: 'global', root: '/g', skills: [] },
  { scope: 'project:p1', label: 'Crew Seating', kind: 'project', root: '/p1', skills: [] },
  { scope: 'project:p2', label: 'Daily Brief', kind: 'project', root: '/p2', skills: [] },
];

const render = (placements: SkillMeta[], role = 'admin') =>
  renderToStaticMarkup(
    <SkillPage
      name="crewseating-access"
      groups={groups}
      initialPlacements={placements}
      role={role}
      onClose={vi.fn()}
      onToast={vi.fn()}
    />,
  );

describe('SkillPage', () => {
  it('shows editor and rail together on one page', () => {
    const html = render([meta({})]);
    // Editor column loads async — a placeholder for it, plus the rail, render at once.
    expect(html).toContain('Loading…');
    expect(html).toContain('Availability');
    expect(html).toContain('Where it’s active');
    expect(html).toContain('Actions');
    expect(html).toContain('Add to a project…');
    expect(html).toContain('Remove from Global…');
  });

  it('marks the edited placement and offers scope pills only with several placements', () => {
    const single = render([meta({})]);
    expect(single).not.toContain('Editing the placement in');

    const multi = render([meta({}), meta({ scope: 'project:p1' })]);
    expect(multi).toContain('Editing the placement in');
    expect(multi).toContain('· Editing');
    expect(multi).toContain('Crew Seating');
  });

  it('prefers the global copy and notes project copies shadow it', () => {
    const html = render([meta({ scope: 'project:p1' }), meta({})]);
    expect(html).toContain('· Editing');
    expect(html).toContain('shadow');
    expect(html).not.toContain('>Make global<');
  });

  it('clearly identifies the original and the linked placement', () => {
    const html = render([
      meta({
        entryKind: 'link',
        source: { scope: 'project:p1', name: 'crewseating-access' },
      }),
      meta({
        scope: 'project:p1',
        dependents: [{ scope: 'global', name: 'crewseating-access' }],
      }),
    ]);
    expect(html).toContain('Linked to Crew Seating');
    expect(html).toContain('Original · Active');
    expect(html).toContain('Remove Global link…');
    expect(html).toContain('Linked placements use the same original file.');
    expect(html).not.toContain('Copies in');
  });

  it('offers Make global when no global copy exists', () => {
    const html = render([meta({ scope: 'project:p1' })]);
    expect(html).toContain('Make global');
  });

  it('hides admin actions and switches from members', () => {
    const html = render([meta({})], 'member');
    expect(html).not.toContain('Actions');
    expect(html).not.toContain('Remove from');
    expect(html).not.toContain('role="switch"');
  });
});
