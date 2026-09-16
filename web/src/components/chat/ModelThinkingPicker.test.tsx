import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildModelChoices, ModelRow, ProviderTabs } from './ModelThinkingPicker';

describe('buildModelChoices', () => {
  it('attaches a capability tier to each visible model', () => {
    const choices = buildModelChoices(
      {
        claude: [
          { id: 'claude-fable-5', label: 'Claude Fable 5' },
          { id: 'claude-opus-5', label: 'Claude Opus 5', isDefault: true },
        ],
        openrouter: [],
        codex: [],
        grok: [],
      },
      [],
      { claude: null },
      {},
    );

    expect(
      choices.filter((c) => c.provider === 'claude').map((c) => [c.short, c.tier, c.isDefault ?? false]),
    ).toEqual([
      ['Fable 5', 4, false],
      ['Opus 5', 3, true],
    ]);
  });

  it('keeps the tier on a hidden default pinned as the Default row', () => {
    const choices = buildModelChoices(
      {
        claude: [
          { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
          { id: 'claude-opus-5', label: 'Claude Opus 5' },
        ],
        openrouter: [],
        codex: [],
        grok: [],
      },
      ['claude:claude-opus-5'],
      { claude: 'claude-opus-5' },
      {},
    );

    expect(choices[0]).toMatchObject({ model: '', isDefault: true, tier: 3 });
  });
});

describe('ProviderTabs', () => {
  it('marks the active provider and shows every name when three or fewer fit', () => {
    const html = renderToStaticMarkup(
      <ProviderTabs providers={['claude', 'codex']} value="codex" onChange={() => undefined} />,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true" title="Codex"');
    expect(html).toContain('aria-selected="false" title="Claude"');
    expect(html).toContain('<span>Claude</span>');
    expect(html).toContain('<span>Codex</span>');
  });

  it('collapses inactive tabs to icons when four providers must fit', () => {
    const html = renderToStaticMarkup(
      <ProviderTabs
        providers={['claude', 'openrouter', 'codex', 'grok']}
        value="codex"
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('<span>Codex</span>');
    expect(html).not.toContain('<span>OpenRouter</span>');
    expect(html).not.toContain('<span>Claude</span>');
  });
});

describe('ModelRow', () => {
  it('renders the name, filled dots, and the Default pill', () => {
    const html = renderToStaticMarkup(
      <ModelRow name="Opus 5" tier={3} isDefault selected onPick={() => undefined} />,
    );

    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Opus 5');
    expect(html).toContain('aria-label="Capability 3 of 4"');
    expect(html.match(/bg-foreground\/15/g)).toHaveLength(1);
    expect(html).toContain('>Default<');
  });

  it('omits the dots when the tier is unknown', () => {
    const html = renderToStaticMarkup(
      <ModelRow name="Mystery" tier={null} selected={false} onPick={() => undefined} />,
    );

    expect(html).not.toContain('Capability');
  });
});
