import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ModelPrefs, UsageResponse } from '@/lib/api';
import { MemberProviderCards } from './MemberProvidersPage';

const prefs: ModelPrefs = {
  defaultProvider: 'codex', providerDefaults: { codex: 'gpt-example' }, defaultEffort: 'high',
  openrouterModels: [], hiddenModels: ['codex:other'], modelOrder: { codex: ['other', 'gpt-example'] },
  defaultAgent: null, agents: {}, autoTitle: { enabled: true, model: 'example' },
};
const blank = { connected: false, windows: [], planType: null, capturedAt: null, source: null, error: null };
const usage: UsageResponse = {
  providers: {
    claude: { ...blank, connected: true, accounts: [{ ...blank, accountId: 'team', label: 'Team account', accountEmail: 'team@example.com', active: true, limitReset: null }] },
    codex: { ...blank, connected: true },
  },
  openrouter: { connected: false, capturedAt: null, summary: null, error: null, modelBreakdown: { configured: false, capturedAt: null, error: null, periods: { today: [], week: [], month: [], lifetime: [] } } },
};

it('shows provider status, account identity, ordered models and shared defaults without mutation controls', () => {
  const html = renderToStaticMarkup(<MemberProviderCards prefs={prefs} usage={usage} models={{
    claude: [], codex: [{ id: 'gpt-example', label: 'Example GPT' }, { id: 'other', label: 'Other model' }], openrouter: [], grok: [],
  }} />);
  for (const label of ['Claude', 'Codex', 'OpenRouter', 'Grok', 'Team account', 'team@example.com', 'Active', 'Connected', 'Not connected', 'Status unavailable', 'Default', 'Hidden from picker', 'high']) {
    expect(html).toContain(label);
  }
  expect(html.indexOf('Other model')).toBeLessThan(html.indexOf('Example GPT'));
  expect(html).not.toMatch(/<(button|input|select)\b/);
});
