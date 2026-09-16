import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  OpenRouterPanel,
  OpenRouterSpend,
  UsageAccountCard,
  UsageCardGrid,
  limitResetText,
  oldestCapturedAt,
  orderUsageCards,
  resetSummary,
  segmentFill,
  switchClaudeAccount,
  windowLabel,
} from './UsagePage';
import type { ClaudeAccountUsage, UsageWindow } from '../../lib/api';
import { formatFreshness } from '../../lib/usageFormat';

const disconnectedProvider = {
  connected: false,
  planType: null,
  capturedAt: null,
  source: null,
  error: null,
  windows: [],
};

describe('provider usage compatibility', () => {
  it('renders the pre-Grok API response used during a rolling restart', () => {
    const html = renderToStaticMarkup(
      <UsageCardGrid
        now={Date.UTC(2026, 7, 13)}
        providers={{
          claude: disconnectedProvider,
          codex: disconnectedProvider,
        }}
      />,
    );

    expect(html).toContain('Claude');
    expect(html).toContain('Codex');
    expect(html).not.toContain('Grok');
  });
});

describe('Claude account identity', () => {
  it('shows the connected account email and hides it when absent or disconnected', () => {
    const base = { ...disconnectedProvider, connected: true, planType: 'Max 20x' };
    const withEmail = renderToStaticMarkup(
      <UsageAccountCard name="Claude" kind="claude" now={0} usage={{ ...base, accountEmail: 'owner@example.com' }} />,
    );
    expect(withEmail).toContain('owner@example.com');
    expect(withEmail).toContain('Max 20x');

    const noEmail = renderToStaticMarkup(<UsageAccountCard name="Claude" kind="claude" now={0} usage={base} />);
    expect(noEmail).not.toContain('example.com');

    const disconnected = renderToStaticMarkup(
      <UsageAccountCard name="Claude" kind="claude" now={0} usage={{ ...disconnectedProvider, accountEmail: 'owner@example.com' }} />,
    );
    expect(disconnected).not.toContain('owner@example.com');
  });
});

describe('segmented meters', () => {
  const window = (over: Partial<UsageWindow>): UsageWindow => ({
    id: 'five_hour',
    label: '5-hour',
    usedPercent: 0,
    resetsAt: null,
    windowMinutes: 300,
    status: null,
    ...over,
  });

  it('rounds a percentage to filled blocks', () => {
    expect(segmentFill(0)).toBe(0);
    expect(segmentFill(4)).toBe(0);
    expect(segmentFill(5)).toBe(1);
    expect(segmentFill(94)).toBe(9);
    expect(segmentFill(95)).toBe(10);
    expect(segmentFill(100)).toBe(10);
    // Out-of-range percentages clamp rather than overflowing the row.
    expect(segmentFill(-8)).toBe(0);
    expect(segmentFill(140)).toBe(10);
  });

  it('renders one screen-readable meter per window', () => {
    const html = renderToStaticMarkup(
      <UsageAccountCard
        name="Claude"
        kind="claude"
        now={Date.UTC(2026, 7, 12, 18)}
        usage={{
          connected: true,
          planType: 'Max 20x',
          capturedAt: new Date(Date.UTC(2026, 7, 12, 18)).toISOString(),
          source: 'stream',
          error: null,
          windows: [window({ usedPercent: 94, resetsAt: new Date(Date.UTC(2026, 7, 12, 22)).toISOString() })],
        }}
      />,
    );
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-label="5-hour: 94% used"');
    expect(html).toContain('aria-valuenow="94"');
    expect(html).toContain('94%');
    // 9 filled blocks at the warning tone, 1 unfilled.
    expect(html.match(/rounded-\[2px\]/g)).toHaveLength(10);
    expect(html.match(/transition-colors bg-amber-500/g)).toHaveLength(9);
    expect(html.match(/transition-colors bg-muted/g)).toHaveLength(1);
  });

  it('shortens the model-scoped weekly labels', () => {
    expect(windowLabel(window({ id: 'five_hour', label: '5-hour' }))).toBe('5-hour');
    expect(windowLabel(window({ id: 'seven_day', label: 'Weekly (all models)' }))).toBe('Weekly · all');
    expect(windowLabel(window({ id: 'seven_day_fable', label: 'Weekly (Fable)' }))).toBe('Weekly · Fable');
    expect(windowLabel(window({ id: 'seven_day_overage_included', label: 'Weekly' }))).toBe('Weekly · Fable');
    expect(windowLabel(window({ id: 'weekly', label: 'Weekly' }))).toBe('Weekly');
  });

  it('consolidates resets into one footer line, deduped per family', () => {
    const now = Date.UTC(2026, 7, 12, 18);
    const summary = resetSummary(
      [
        window({ id: 'five_hour', label: '5-hour', resetsAt: new Date(now + 4 * 3600_000).toISOString() }),
        window({
          id: 'seven_day',
          label: 'Weekly (all models)',
          resetsAt: new Date(now + 40 * 3600_000).toISOString(),
        }),
        window({
          id: 'seven_day_fable',
          label: 'Weekly (Fable)',
          resetsAt: new Date(now + 40 * 3600_000).toISOString(),
        }),
      ],
      now,
    );
    expect(summary).toBe('5-hour resets in 4h 0m · weekly in 1d 16h');
    expect(resetSummary([window({ resetsAt: null })], now)).toBeNull();
  });
});

const account = (over: Partial<ClaudeAccountUsage>): ClaudeAccountUsage => ({
  accountId: 'a',
  label: 'Account',
  accountEmail: null,
  planType: 'Max 20x',
  active: false,
  windows: [],
  capturedAt: null,
  source: 'stream',
  limitReset: null,
  ...over,
});

const used = (pct: number): UsageWindow[] => [
  { id: 'five_hour', label: '5-hour', usedPercent: pct, resetsAt: null, windowMinutes: 300, status: null },
];

/** Two connected Claude accounts — the only shape that offers switching. */
const twoAccounts = {
  claude: {
    ...disconnectedProvider,
    connected: true,
    accounts: [
      account({ accountId: 'a1', label: 'Personal', active: true, windows: used(40) }),
      account({ accountId: 'a2', label: 'Team', windows: used(10) }),
    ],
  },
  codex: disconnectedProvider,
};

/**
 * The suite renders to static markup and there is no DOM in this project's test
 * setup, so "clicking" means finding the element in the returned tree and
 * invoking the handler it was given.
 */
function findProps(
  node: unknown,
  match: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProps(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return null;
  if (match(props)) return props;
  return findProps(props.children, match);
}

describe('usage card order', () => {
  it('keeps Claude accounts in registry order, then the other providers', () => {
    const cards = orderUsageCards({
      claude: {
        ...disconnectedProvider,
        connected: true,
        accounts: [
          account({ accountId: 'spent', label: 'Spent', windows: used(99) }),
          account({ accountId: 'fresh', label: 'Fresh', windows: used(12) }),
          account({ accountId: 'active', label: 'Active one', active: true, windows: used(87) }),
          account({ accountId: 'middle', label: 'Middle', windows: used(60) }),
        ],
      },
      codex: disconnectedProvider,
      grok: disconnectedProvider,
    });

    // The active account is third in the registry and stays third: cards hold
    // still, so activating one moves the tab instead of reshuffling the grid.
    expect(cards.map((c) => c.key)).toEqual(['spent', 'fresh', 'active', 'middle', 'codex', 'grok']);
    expect(cards[0]?.active).toBe(false);
    expect(cards[2]?.active).toBe(true);
    expect(cards[2]?.accountId).toBe('active');
  });

  it('falls back to a single Claude card when only one account is connected', () => {
    const cards = orderUsageCards({ claude: disconnectedProvider, codex: disconnectedProvider });
    expect(cards.map((c) => c.key)).toEqual(['claude', 'codex']);
    // No accountId means no switch button — there is nothing to switch to.
    expect(cards.every((c) => c.accountId === undefined)).toBe(true);
  });
});

describe('active account card', () => {
  it('marks the active card with a brand ring and a hanging tab, not an inline pill', () => {
    const html = renderToStaticMarkup(<UsageCardGrid now={0} providers={twoAccounts} />);

    expect(html).toContain('ring-2 ring-brand');
    // Flush to the top border, hanging down, square top / rounded bottom.
    expect(html).toContain('absolute right-4 top-0 rounded-b-md');
    expect(html).toContain('bg-brand text-background');
    expect(html).toContain('Active<span class="sr-only"> account</span>');
    // One Active marker on the page, and no leftover inline pill in the title row.
    expect(html.match(/Active/g)).toHaveLength(1);
    expect(html).not.toContain('bg-brand/10');
  });

  it('leaves non-active cards unringed', () => {
    const html = renderToStaticMarkup(
      <UsageAccountCard name="Team" kind="claude" now={0} usage={{ ...disconnectedProvider, connected: true }} />,
    );
    expect(html).not.toContain('ring-brand');
    expect(html).not.toContain('Active');
  });
});

describe('switching account from the usage page', () => {
  it('offers "Use this" only on non-active cards, and only when switching is wired', () => {
    const html = renderToStaticMarkup(
      <UsageCardGrid now={0} providers={twoAccounts} onActivate={() => {}} />,
    );
    expect(html.match(/aria-label="Use this account: /g)).toHaveLength(1);
    expect(html).toContain('aria-label="Use this account: Team"');
    expect(html).not.toContain('aria-label="Use this account: Personal"');

    // A read-only grid (no handler) renders no switch tabs.
    const readOnly = renderToStaticMarkup(<UsageCardGrid now={0} providers={twoAccounts} />);
    expect(readOnly).not.toContain('Use this');

    // One connected account has nothing to switch to.
    const single = renderToStaticMarkup(
      <UsageCardGrid
        now={0}
        providers={{ claude: { ...disconnectedProvider, connected: true }, codex: disconnectedProvider }}
        onActivate={() => {}}
      />,
    );
    expect(single).not.toContain('Use this');
  });

  it('puts the switch in the corner slot the Active tab occupies, not the footer', () => {
    const html = renderToStaticMarkup(
      <UsageCardGrid now={0} providers={twoAccounts} onActivate={() => {}} />,
    );

    // Both tabs wear identical geometry, so the slot changes state in place.
    expect(html.match(/absolute right-4 top-0 rounded-b-md/g)).toHaveLength(2);
    // A real button, muted so the brand-filled Active tab stays dominant.
    expect(html).toContain('bg-muted text-muted-foreground');
    expect(html).toContain('hover:bg-brand hover:text-background');
    // Within its own card it hangs in the corner: before the header, not the footer.
    const card = renderToStaticMarkup(
      <UsageAccountCard
        name="Team"
        kind="claude"
        now={0}
        usage={{ ...disconnectedProvider, connected: true }}
        onActivate={() => {}}
      />,
    );
    expect(card.indexOf('Use this account: Team')).toBeLessThan(card.indexOf('data-slot="card-header"'));
  });

  it('keeps the footer for reset lines only, and drops it when there are none', () => {
    const html = renderToStaticMarkup(
      <UsageAccountCard
        name="Team"
        kind="claude"
        now={0}
        usage={{ ...disconnectedProvider, connected: true }}
        onActivate={() => {}}
      />,
    );
    // Connected but no windows: switch tab present, no empty footer bar.
    expect(html).toContain('Use this');
    expect(html).not.toContain('data-slot="card-footer"');

    const metered = renderToStaticMarkup(
      <UsageAccountCard
        name="Team"
        kind="claude"
        now={Date.UTC(2026, 7, 12, 18)}
        usage={{
          ...disconnectedProvider,
          connected: true,
          capturedAt: new Date(Date.UTC(2026, 7, 12, 18)).toISOString(),
          windows: [
            {
              id: 'five_hour',
              label: '5-hour',
              usedPercent: 10,
              resetsAt: new Date(Date.UTC(2026, 7, 12, 22)).toISOString(),
              windowMinutes: 300,
              status: null,
            },
          ],
        }}
        onActivate={() => {}}
      />,
    );
    expect(metered).toContain('data-slot="card-footer"');
    expect(metered).toContain('5-hour resets in 4h 0m');
    // Freshness is reported once for the page, never per card.
    expect(metered).not.toContain('as of');
  });

  it('hands the clicked card its own account id', () => {
    const activated: string[] = [];
    const grid = UsageCardGrid({ now: 0, providers: twoAccounts, onActivate: (id) => activated.push(id) });

    // The grid passes each non-active card a handler bound to that account.
    const card = findProps(grid, (p) => p.name === 'Team');
    expect(card?.active).toBeFalsy();
    (card?.onActivate as () => void)();
    expect(activated).toEqual(['a2']);

    // …and the card wires that handler to its button.
    const clicks: string[] = [];
    const rendered = UsageAccountCard({
      name: 'Team',
      kind: 'claude',
      now: 0,
      usage: { ...disconnectedProvider, connected: true },
      onActivate: () => clicks.push('clicked'),
    });
    const button = findProps(rendered, (p) => p['aria-label'] === 'Use this account: Team');
    (button?.onPointerUp as () => void)();
    expect(clicks).toEqual(['clicked']);
  });

  it('activates then re-fetches, and surfaces a failure on the page banner', async () => {
    const calls: string[] = [];
    let reloaded = 0;
    await switchClaudeAccount('a2', {
      activate: async (id) => {
        calls.push(id);
      },
      reload: () => {
        reloaded += 1;
      },
      onError: () => expect.unreachable('should not error'),
    });
    expect(calls).toEqual(['a2']);
    expect(reloaded).toBe(1);

    const errors: string[] = [];
    await switchClaudeAccount('a2', {
      activate: () => Promise.reject(new Error('Account is no longer connected')),
      reload: () => expect.unreachable('should not reload after a failure'),
      onError: (message) => errors.push(message),
    });
    expect(errors).toEqual(['Account is no longer connected']);
  });

  it('disables every switch button while one is pending', () => {
    const three = {
      ...twoAccounts,
      claude: {
        ...twoAccounts.claude,
        accounts: [...twoAccounts.claude.accounts, account({ accountId: 'a3', label: 'Spare', windows: used(20) })],
      },
    };
    const html = renderToStaticMarkup(
      <UsageCardGrid now={0} providers={three} onActivate={() => {}} switching="a2" />,
    );

    expect(html.match(/aria-label="Use this account: /g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    // The pending card swaps its label for a spinner.
    expect(html.match(/animate-spin/g)).toHaveLength(1);
  });
});

describe('Claude weekly session reset', () => {
  const resetStatus = {
    available: true,
    nextAvailableAt: '2026-09-10T17:00:00Z',
    weeklyResetsAt: '2026-09-08T12:00:00Z',
    resetsPerWeek: 1,
    capturedAt: '2026-09-03T17:00:00Z',
  };

  it('shows Claude\'s once-weekly offer and cooldown without implying weekly usage resets', () => {
    expect(limitResetText(resetStatus, Date.parse('2026-09-03T17:00:00Z'))).toBe(
      '1/week · still counts toward weekly usage',
    );
    expect(limitResetText(
      { ...resetStatus, available: false },
      Date.parse('2026-09-03T17:00:00Z'),
    )).toBe('Session reset used · available in 7d 0h');

    const html = renderToStaticMarkup(
      <UsageAccountCard
        name="Personal"
        kind="claude"
        now={Date.parse('2026-09-03T17:00:00Z')}
        usage={{ ...disconnectedProvider, connected: true, limitReset: resetStatus }}
        onLimitReset={() => {}}
      />,
    );
    expect(html).toContain('1/week · still counts toward weekly usage');
    expect(html).toContain('Reset session');
    expect(html).not.toContain('reset your weekly');

    const spent = renderToStaticMarkup(
      <UsageAccountCard
        name="Personal"
        kind="claude"
        now={Date.parse('2026-09-03T17:00:00Z')}
        usage={{ ...disconnectedProvider, connected: true, limitReset: { ...resetStatus, available: false } }}
        onLimitReset={() => {}}
      />,
    );
    expect(spent).toContain('Session reset used · available in 7d 0h');
    expect(spent).not.toContain('Reset session');
  });

  it('binds the action to the card account without activating it', () => {
    const providers = {
      ...twoAccounts,
      claude: {
        ...twoAccounts.claude,
        accounts: twoAccounts.claude.accounts.map((item) =>
          item.accountId === 'a2' ? { ...item, limitReset: resetStatus } : item),
      },
    };
    const resets: Array<{ id: string; name: string }> = [];
    const activations: string[] = [];
    const grid = UsageCardGrid({
      now: 0,
      providers,
      onActivate: (id) => activations.push(id),
      onLimitReset: (id, name) => resets.push({ id, name }),
    });
    const card = findProps(grid, (p) => p.name === 'Team');
    (card?.onLimitReset as () => void)();
    expect(resets).toEqual([{ id: 'a2', name: 'Team' }]);
    expect(activations).toEqual([]);
  });
});

describe('one freshness line for the page', () => {
  it('reports the stalest card, skipping providers that never captured', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 7, 12, h)).toISOString();
    const providers = {
      claude: {
        ...disconnectedProvider,
        connected: true,
        accounts: [
          account({ accountId: 'a1', label: 'Personal', capturedAt: at(17), active: true }),
          account({ accountId: 'a2', label: 'Team', capturedAt: at(12) }),
          account({ accountId: 'a3', label: 'Spare', capturedAt: null }),
        ],
      },
      codex: { ...disconnectedProvider, capturedAt: at(16) },
    };

    expect(oldestCapturedAt(providers)).toBe(at(12));
    // What the page actually prints, next to the refresh control.
    expect(formatFreshness(oldestCapturedAt(providers), Date.UTC(2026, 7, 12, 18))).toBe('as of 6h ago');
  });

  it('has nothing to report when no provider has captured', () => {
    expect(oldestCapturedAt({ claude: disconnectedProvider, codex: disconnectedProvider })).toBeNull();
  });

  it('leaves no "as of" line on the cards themselves', () => {
    const html = renderToStaticMarkup(<UsageCardGrid now={0} providers={twoAccounts} />);
    expect(html).not.toContain('as of');
  });
});

describe('card identity line', () => {
  const connected = { ...disconnectedProvider, connected: true };

  it('drops the email when it only repeats the card name', () => {
    const unnamed = renderToStaticMarkup(
      <UsageAccountCard
        name="owner@example.com"
        kind="claude"
        now={0}
        usage={{ ...connected, accountEmail: 'owner@example.com' }}
      />,
    );
    expect(unnamed.match(/owner@example\.com/g)).toHaveLength(1);
    expect(unnamed).not.toContain('data-slot="card-description"');
  });

  it('keeps the email when the account carries a custom label', () => {
    const renamed = renderToStaticMarkup(
      <UsageAccountCard
        name="Personal"
        kind="claude"
        now={0}
        usage={{ ...connected, accountEmail: 'owner@example.com' }}
      />,
    );
    expect(renamed).toContain('Personal');
    expect(renamed).toContain('owner@example.com');
    expect(renamed).toContain('data-slot="card-description"');
  });
});

describe('OpenRouter accordion', () => {
  const openrouter = {
    connected: true,
    capturedAt: new Date(Date.UTC(2026, 6, 20, 12)).toISOString(),
    summary: {
      todayUsd: 0.43,
      weekUsd: 1.25,
      monthUsd: 4.5,
      lifetimeUsd: 39.63,
      limitUsd: null,
      remainingUsd: null,
      limitReset: null,
    },
    modelBreakdown: {
      configured: true,
      capturedAt: null,
      periods: { today: [], week: [], month: [], lifetime: [] },
      error: null,
    },
    error: null,
  };
  const usage = {
    providers: { claude: disconnectedProvider, codex: disconnectedProvider },
    openrouter,
  };

  it('starts collapsed on every visit, with a compact total in the header row', () => {
    const html = renderToStaticMarkup(
      <OpenRouterPanel usage={usage} now={Date.UTC(2026, 6, 20, 12)} loading={false} />,
    );

    expect(html).toContain('<details');
    // No `open` attribute anywhere: nothing is persisted, so it opens closed.
    expect(html).not.toContain('open=""');
    expect(html).toContain('OpenRouter spend');
    expect(html).toContain('$1.25 this week');
    expect(html).toContain('group-open:rotate-180');
  });

  it('holds the full spend detail inside, ready to reveal', () => {
    const html = renderToStaticMarkup(
      <OpenRouterPanel usage={usage} now={Date.UTC(2026, 6, 20, 12)} loading={false} />,
    );

    // Everything the expanded panel shows lives after the summary, inside <details>.
    const body = html.slice(html.indexOf('</summary>'));
    expect(body).toContain('This week');
    expect(body).toContain('Cost by model');
    expect(body).toContain('OpenRouter data as of just now');
    expect(html.indexOf('</details>')).toBeGreaterThan(html.indexOf('Cost by model'));
  });

  it('keeps the summary keyboard reachable with a visible focus style', () => {
    const html = renderToStaticMarkup(<OpenRouterPanel usage={null} now={0} loading />);
    expect(html).toContain('<summary');
    expect(html).toContain('focus-visible:ring-2');
    expect(html).toContain('Loading…');
  });
});

describe('OpenRouter spend summary', () => {
  it('renders inference-key totals without model analytics', () => {
    const now = Date.UTC(2026, 6, 20, 12);
    const html = renderToStaticMarkup(
      <OpenRouterSpend
        now={now}
        usage={{
          connected: true,
          capturedAt: new Date(now).toISOString(),
          summary: {
            todayUsd: 0.43,
            weekUsd: 1.25,
            monthUsd: 4.5,
            lifetimeUsd: 39.63,
            limitUsd: 25,
            remainingUsd: 20.5,
            limitReset: 'monthly',
          },
          modelBreakdown: {
            configured: true,
            capturedAt: new Date(now).toISOString(),
            periods: {
              today: [{
                model: 'anthropic/claude-opus-4.6',
                costUsd: 0.478138,
                requestCount: 4,
                tokensTotal: 12000,
              }],
              week: [],
              month: [],
              lifetime: [],
            },
            error: null,
          },
          error: null,
        }}
      />,
    );

    expect(html).toContain('Today');
    expect(html).toContain('This week');
    expect(html).toContain('This month');
    expect(html).toContain('Lifetime');
    expect(html).toContain('$20.50 remaining of $25.00');
    expect(html).toContain('Cost by model');
    expect(html).toContain('anthropic/claude-opus-4.6');
    expect(html).toContain('$0.48');
    expect(html).toContain('12K');
  });
});

describe('Grok usage block', () => {
  it('renders the weekly credits meter', () => {
    const now = Date.UTC(2026, 7, 12, 18);
    const html = renderToStaticMarkup(
      <UsageAccountCard
        name="Grok"
        now={now}
        kind="grok"
        usage={{
          connected: true,
          planType: 'SuperGrok Heavy',
          capturedAt: new Date(now).toISOString(),
          source: 'live',
          error: null,
          windows: [
            {
              id: 'weekly',
              label: 'Weekly',
              usedPercent: 5,
              resetsAt: '2026-08-17T19:43:17.117Z',
              windowMinutes: 10080,
              status: null,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('Grok');
    expect(html).toContain('SuperGrok Heavy');
    expect(html).toContain('Weekly');
    expect(html).toContain('5%');
  });

  it('uses the live empty copy, not Claude’s first-turn hint', () => {
    const html = renderToStaticMarkup(
      <UsageAccountCard
        name="Grok"
        now={Date.now()}
        kind="grok"
        usage={{
          connected: true,
          planType: null,
          capturedAt: null,
          source: null,
          error: null,
          windows: [],
        }}
      />,
    );
    expect(html).toContain('No usage data yet.');
    expect(html).not.toContain('first Claude turn');
  });
});
