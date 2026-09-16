import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SkillCommandPicker } from './SkillCommandPicker';

describe('SkillCommandPicker', () => {
  it('renders skill metadata and marks the active option', () => {
    const html = renderToStaticMarkup(
      <SkillCommandPicker
        items={[{ name: 'review', description: 'Review a plan', scopeLabel: 'Global', conflict: false }]}
        activeIndex={0}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('/review');
    expect(html).toContain('Review a plan');
    expect(html).toContain('Global');
  });

  it('shows an empty result and disables name conflicts', () => {
    expect(renderToStaticMarkup(<SkillCommandPicker items={[]} activeIndex={0} onSelect={() => undefined} />))
      .toContain('No matching skills');
    const conflict = renderToStaticMarkup(
      <SkillCommandPicker
        items={[{ name: 'review', description: null, scopeLabel: 'Name conflict', conflict: true }]}
        activeIndex={0}
        onSelect={() => undefined}
      />,
    );
    expect(conflict).toContain('disabled=""');
    expect(conflict).toContain('Name conflict');
  });
});
