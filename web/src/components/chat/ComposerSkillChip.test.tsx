import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComposerSkillChip, ComposerSkillDetails } from './ComposerSkillChip';

const command = {
  name: 'review',
  description: 'Review a plan for gaps',
  scopeLabel: 'Current project',
  conflict: false,
};

describe('ComposerSkillChip', () => {
  it('renders a tappable disclosure for the selected skill', () => {
    const html = renderToStaticMarkup(
      <ComposerSkillChip command={command} open onToggle={() => undefined} />,
    );

    expect(html).toContain('<button');
    expect(html).toContain('aria-label="About /review"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('/review');
  });

  it('shows the description, scope, provider, close, and remove controls', () => {
    const html = renderToStaticMarkup(
      <ComposerSkillDetails
        command={command}
        provider="Codex"
        onClose={() => undefined}
        onRemove={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('Review a plan for gaps');
    expect(html).toContain('Current project · Codex');
    expect(html).toContain('Close skill details');
    expect(html).toContain('Remove skill');
  });
});
