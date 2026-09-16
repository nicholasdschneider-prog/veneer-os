import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NavigationBrand, NavShell } from './NavBar';
import { DEFAULT_WORKSPACE_NAVIGATION } from '../lib/navigation';

vi.mock('../lib/useUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/useUsage')>();
  const provider = { connected: true, planType: null, capturedAt: null, source: null, error: null,
    windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 42, resetsAt: null, windowMinutes: 300, status: null }] };
  return { ...actual, useUsage: () => ({ usage: { providers: { claude: provider, codex: provider } }, now: 0, unavailable: false }) };
});

const terminalNavigation = {
  items: DEFAULT_WORKSPACE_NAVIGATION.items.map((item) =>
    item.kind === 'builtin' && item.key === 'terminal' ? { ...item, visible: true } : item,
  ),
};

describe('NavShell account menu', () => {
  it('mounts tappable brand triggers for desktop and mobile', () => {
    const html = renderToStaticMarkup(
      <NavShell
        current="chats"
        canManage
        signedInEmail="owner@example.com"
        onNavigate={() => {}}
      >
        <div>Content</div>
      </NavShell>,
    );

    expect(html.match(/aria-label="Account menu"/g)).toHaveLength(2);
    expect(html).toContain('data-placement="desktop"');
    expect(html).toContain('data-placement="mobile"');
  });
});

describe('NavShell window boundary', () => {
  it('preserves landscape safe areas and the bottom-navigation separator', () => {
    const html = renderToStaticMarkup(
      <NavShell current="chats" canManage signedInEmail="owner@example.com" onNavigate={() => {}}>
        <div>Content</div>
      </NavShell>,
    );
    const shell = html.match(/^<div[^>]+>/)?.[0] ?? '';

    expect(shell).toContain('flex-col-reverse');
    expect(shell).not.toContain('border-t');
    expect(html).toContain('h-[var(--vp-nav-h)] border-t');
    expect(html).toContain('pr-[env(safe-area-inset-right)]');
    expect(html).toContain('pl-[env(safe-area-inset-left)]');
  });

  it('does not leave the shell border exposed above a mobile detail screen either', () => {
    const html = renderToStaticMarkup(
      <NavShell
        current="chats"
        canManage
        signedInEmail="owner@example.com"
        onNavigate={() => {}}
        mobileHidden
      >
        <div>Chat</div>
      </NavShell>,
    );
    const shell = html.match(/^<div[^>]+>/)?.[0] ?? '';

    expect(shell).toContain('flex-col-reverse');
    expect(shell).not.toContain('border-t');
    expect(html).toContain('h-[var(--vp-nav-h)] border-t');
  });
});

describe('NavigationBrand', () => {
  it('fits a configured logo inside the fixed square footprint', () => {
    const html = renderToStaticMarkup(<NavigationBrand clientLogoUrl="blob:client-logo" />);

    expect(html).toContain('<img');
    expect(html).toContain('src="blob:client-logo"');
    expect(html).toContain('alt="Client logo"');
    expect(html).toContain('size-7');
    expect(html).toContain('shrink-0');
    expect(html).toContain('object-contain');
    expect(html).not.toContain('aria-label="Veneer"');
  });

  it('falls back to the Veneer mark when no client logo is available', () => {
    const html = renderToStaticMarkup(<NavigationBrand clientLogoUrl={null} />);

    expect(html).toContain('aria-label="Veneer"');
    expect(html).not.toContain('<img');
  });
});

describe('NavShell system usage', () => {
  it('reserves a graceful system-usage readout immediately before Settings', () => {
    const html = renderToStaticMarkup(
      <NavShell current="chats" canManage signedInEmail="owner@example.com" onNavigate={() => {}}>
        <div>Content</div>
      </NavShell>,
    );

    expect(html).toContain('aria-label="System usage unavailable"');
    expect(html).toContain('>–/–G<');
    expect(html).not.toContain('>CPU<');
    expect(html).not.toContain('>RAM<');
    expect(html).not.toContain('border-t border-border/60');
    expect(html.indexOf('System usage unavailable')).toBeLessThan(html.lastIndexOf('aria-label="Settings"'));
  });
});

describe('NavShell utility access', () => {
  it('keeps files and host tools out of primary navigation', () => {
    const manager = renderToStaticMarkup(
      <NavShell current="settings" canManage signedInEmail="owner@example.com" onNavigate={() => {}}>
        <div>Content</div>
      </NavShell>,
    );
    const member = renderToStaticMarkup(
      <NavShell
        current="settings"
        canManage={false}
        signedInEmail="client@example.com"
        onNavigate={() => {}}
      >
        <div>Content</div>
      </NavShell>,
    );

    expect(manager).not.toContain('aria-label="Files"');
    expect(manager).not.toContain('aria-label="Tools"');
    expect(manager).toContain('aria-current="page"');
    expect(member).not.toContain('aria-label="Files"');
    expect(member).not.toContain('aria-label="Tools"');
  });
});

describe('NavShell pinned terminal', () => {
  it('keeps the terminal out of the rail until it is pinned', () => {
    const html = renderToStaticMarkup(
      <NavShell current="chats" canManage signedInEmail="owner@example.com" onNavigate={() => {}}>
        <div>Content</div>
      </NavShell>,
    );

    expect(html).not.toContain('aria-label="Terminal"');
  });

  it('adds a terminal item once pinned, before the system usage readout', () => {
    const html = renderToStaticMarkup(
      <NavShell
        current="chats"
        canManage
        navigation={terminalNavigation}
        signedInEmail="owner@example.com"
        onNavigate={() => {}}
      >
        <div>Content</div>
      </NavShell>,
    );

    expect(html).toContain('aria-label="Terminal"');
    expect(html.indexOf('aria-label="Terminal"')).toBeGreaterThan(html.indexOf('aria-label="Apps"'));
    expect(html.indexOf('aria-label="Terminal"')).toBeLessThan(html.indexOf('System usage unavailable'));
  });

  it('marks the pinned terminal as the current page on the terminal route', () => {
    const html = renderToStaticMarkup(
      <NavShell
        current="terminal"
        canManage
        navigation={terminalNavigation}
        signedInEmail="owner@example.com"
        onNavigate={() => {}}
      >
        <div>Content</div>
      </NavShell>,
    );

    expect(html).toContain('aria-label="Terminal" aria-current="page"');
  });

  it('never pins the terminal into a member rail', () => {
    const html = renderToStaticMarkup(
      <NavShell
        current="chats"
        canManage={false}
        navigation={terminalNavigation}
        signedInEmail="client@example.com"
        onNavigate={() => {}}
      >
        <div>Content</div>
      </NavShell>,
    );

    expect(html).not.toContain('aria-label="Terminal"');
  });
});

const customNavigation = {
  items: [
    { kind: 'builtin' as const, key: 'pages' as const, visible: true },
    { kind: 'builtin' as const, key: 'todos' as const, visible: false },
    { kind: 'builtin' as const, key: 'automations' as const, visible: true },
    { kind: 'builtin' as const, key: 'apps' as const, visible: true },
    { kind: 'builtin' as const, key: 'terminal' as const, visible: false },
    {
      kind: 'app' as const,
      appId: 'sales-app',
      visible: true,
      icon: 'chart' as const,
      label: null,
      title: 'Sales Pulse',
    },
  ],
};

describe('NavShell workspace navigation', () => {
  it('uses the saved order and hides disabled built-ins', () => {
    const html = renderToStaticMarkup(
      <NavShell
        current="app:sales-app"
        canManage
        navigation={customNavigation}
        signedInEmail="owner@example.com"
        onNavigate={() => {}}
      >
        <div>Content</div>
      </NavShell>,
    );
    expect(html).not.toContain('aria-label="Todos"');
    // lastIndexOf: the mobile bar (rendered first) also carries Automations.
    expect(html.lastIndexOf('aria-label="Pages"')).toBeLessThan(html.lastIndexOf('aria-label="Automations"'));
    expect(html).toContain('aria-label="Sales Pulse"');
    expect(html).toContain('aria-label="Sales Pulse" aria-current="page"');
  });

  it('adds focus-aware tooltip triggers to the desktop rail only', () => {
    const html = renderToStaticMarkup(
      <NavShell current="chats" canManage signedInEmail="owner@example.com" onNavigate={() => {}}>
        <div>Content</div>
      </NavShell>,
    );

    expect(html).toMatch(/aria-label="Chats"[^>]*data-state="closed"/);
    expect(html).toMatch(/aria-label="Pages"[^>]*data-state="closed"/);
    expect(html).toMatch(/aria-label="Settings"[^>]*data-state="closed"/);
    expect(html).toContain('aria-label="Chats" title="Chats"');
    expect(html.match(/title="Chats"/g)).toHaveLength(1);
  });

  it('puts extra mobile destinations in a More menu', () => {
    const html = renderToStaticMarkup(
      <NavShell
        current="chats"
        canManage
        navigation={customNavigation}
        signedInEmail="owner@example.com"
        onNavigate={() => {}}
      >
        <div>Content</div>
      </NavShell>,
    );
    expect(html).toContain('aria-label="More navigation"');
  });
});

describe('NavShell mobile bar', () => {
  const render = () =>
    renderToStaticMarkup(
      <NavShell
        current="chats"
        canManage
        navigation={customNavigation}
        signedInEmail="owner@example.com"
        onNavigate={() => {}}
      >
        <div>Content</div>
      </NavShell>,
    );

  it('drops the black New chat button — the Chats screen header owns it now', () => {
    expect(render()).not.toContain('aria-label="New chat"');
  });

  it('reads Chats · Automations · More · Settings, everything else behind More', () => {
    const html = render();
    const menu = html.slice(html.indexOf('aria-label="More navigation"'));

    // Only the mobile items carry a `title` (the desktop rail uses tooltips
    // instead), so a title is the tell for "this is in the bottom bar".
    expect(html).toContain('title="Chats"');
    expect(html).toContain('title="Automations"');
    expect(html).toContain('title="Settings"');
    expect(html).toContain('aria-label="More navigation"');
    expect(html.indexOf('title="Chats"')).toBeLessThan(html.indexOf('title="Automations"'));
    expect(html.indexOf('title="Automations"')).toBeLessThan(html.indexOf('aria-label="More navigation"'));
    expect(html.indexOf('aria-label="More navigation"')).toBeLessThan(html.lastIndexOf('title="Settings"'));
    for (const label of ['Pages', 'Apps', 'Sales Pulse']) {
      expect(html).not.toContain(`title="${label}"`);
      expect(menu).toContain(label);
    }
    expect(menu).not.toContain('>Automations<');
  });
});


it('shows provider usage meters to members', () => {
  const html = renderToStaticMarkup(
    <NavShell current="chats" canManage={false} signedInEmail="member@example.com" onNavigate={() => {}}>
      <div>Content</div>
    </NavShell>,
  );
  expect(html).toContain('42% of 5hr used');
  expect(html).toContain('Open usage settings.');
});
