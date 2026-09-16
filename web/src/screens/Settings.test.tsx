import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Settings } from './Settings';
import { ProviderVersionLine } from './settings/AccountsPage';
import { DEFAULT_WORKSPACE_NAVIGATION } from '../lib/navigation';

beforeAll(() => {
  const mql = { matches: false, media: '', addEventListener() {}, removeEventListener() {} };
  (globalThis as { window?: unknown }).window = {
    matchMedia: () => mql,
    location: { hash: '#/settings' },
  };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
});

beforeEach(() => {
  window.location.hash = '#/settings';
});

const noop = () => {};
const base = {
  section: 'index' as const,
  role: 'owner',
  onNavigate: noop,
  onToast: noop,
  navigation: DEFAULT_WORKSPACE_NAVIGATION,
  onNavigationChange: async (navigation: typeof DEFAULT_WORKSPACE_NAVIGATION) => navigation,
};

describe('Settings information architecture', () => {
  it('shows Usage as a direct Intelligence destination', () => {
    const html = renderToStaticMarkup(<Settings {...base} />);

    for (const group of ['For you', 'Intelligence', 'Workspace', 'Administration']) {
      expect(html).toContain(group);
    }
    for (const destination of [
      'Appearance &amp; branding',
      'Providers &amp; models',
      'Usage',
      'Agents',
      'Memory',
      'Skills',
      'Connections',
      'Navigation',
      'Browser',
      'Resolution and quality',
      'Files',
      'Tools',
      'People &amp; access',
      'Credentials',
      'Advanced',
    ]) {
      expect(html).toContain(destination);
    }
    for (const retiredLabel of ['Toolbox', 'Switch instance']) {
      expect(html).not.toContain(retiredLabel);
    }
    expect(html).not.toContain('Chat &amp; voice');
    expect(html).toContain('href="/cdn-cgi/access/logout"');
    expect(html).toContain('Log out');
    expect(html.indexOf('Advanced')).toBeLessThan(html.indexOf('href="/cdn-cgi/access/logout"'));
  });

  it('preserves admin role gating for sensitive destinations', () => {
    const html = renderToStaticMarkup(<Settings {...base} role="member" />);
    expect(html).toContain('Providers &amp; models');
    expect(html).toContain('Connections');
    expect(html).toContain('Files');
    expect(html).toContain('Usage');
    expect(html).not.toContain('Tools');
    expect(html).not.toContain('Sidebar items and order');
    expect(html).not.toContain('Live viewer quality and agent pointer');
    expect(html).not.toContain('People &amp; access');
    expect(html).not.toContain('Credentials');
    expect(html).not.toContain('Advanced');
  });

  it('combines AI defaults, providers, chat settings, and voice', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="providers" />);

    expect(html).toContain('AI defaults, accounts, models, chat, and voice');
    expect(html).toContain('Providers');
    expect(html).toContain('History');
    expect(html).toContain('Voice');
    expect(html).toContain('New chat defaults');
    expect(html).toContain('Claude account');
    expect(html).toContain('Claude Code response style');
    expect(html).toContain('Only affects new Claude Code chats. Codex, Grok, and OpenRouter are unchanged.');
    expect(html.match(/Checking version…/g)).toHaveLength(4);
    expect(html).not.toContain('>Defaults</button>');
    expect(html).not.toContain('Chat &amp; voice');
  });

  it('mounts member-readable providers without account administration controls', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="providers" role="member" />);
    expect(html).toContain('Loading providers…');
    expect(html).not.toContain('Test connection');
    expect(html).not.toContain('Claude Code response style');
    expect(html).not.toContain('Add OpenRouter model');
  });

  it('shows provider runtime versions and graceful unavailable states', () => {
    const installed = renderToStaticMarkup(
      <ProviderVersionLine
        info={{ runtime: 'Codex CLI', version: '0.147.0', supportsConciseOutputStyle: false }}
      />,
    );
    const unavailable = renderToStaticMarkup(
      <ProviderVersionLine info={{ runtime: 'Grok CLI', version: null, supportsConciseOutputStyle: false }} />,
    );
    expect(installed).toContain('Codex CLI 0.147.0');
    expect(unavailable).toContain('Grok CLI version unavailable');
  });

  it('exposes Doppler as a Credentials section', () => {
    window.location.hash = '#/settings/credentials?tab=vault';
    const html = renderToStaticMarkup(<Settings {...base} section="credentials" />);
    expect(html).toContain('>Doppler</button>');
    expect(html).toContain('Agent guidance');
  });
});

describe('Settings shared layout', () => {
  it('uses one page header with a description and no scope pill', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="appearance" />);
    expect(html).toContain('Appearance &amp; branding');
    expect(html).toContain('Theme, chat icons, and workspace identity');
    // The scope pill is gone from every settings page header.
    expect(html).not.toContain('Mixed scope');
    expect(html).not.toContain('Admin only');
    expect(html).toContain('On this device');
    expect(html).not.toContain('For your account');
    expect(html).toContain('For this workspace');
    expect(html).toContain('Shared appearance is visible to everyone in this Veneer Pro install.');
    expect(html).toContain('Chat list icons');
    expect(html).toContain('Creator initial');
  });

  it('keeps workspace branding hidden from members', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="appearance" role="member" />);
    expect(html).toContain('On this device');
    expect(html).toContain('Theme');
    expect(html).toContain('System');
    expect(html).toContain('Light');
    expect(html).toContain('Dark');
    expect(html).not.toContain('For your account');
    expect(html).not.toContain('Creator initial');
    expect(html).not.toContain('Chat list icons');
    expect(html).not.toContain('For this workspace');
    expect(html).not.toContain('Client logo');
  });

  it('shows workspace navigation controls to administrators', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="navigation" />);
    expect(html).toContain('Sidebar items');
    expect(html).toContain('Chats and Settings always stay available.');
    expect(html).toContain('Show Terminal in the sidebar');
    expect(html).toContain('Hide Todos in the sidebar');
  });

  it('shows Auto 1.5x resolution and quality 80 as workspace defaults', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="browser" />);
    expect(html).toContain('These settings control the live Veneer Browser viewer. Higher resolution and quality look sharper and use more bandwidth.');
    expect(html).toContain('Display resolution');
    expect(html).toContain('Standard');
    expect(html).toContain('1.5× · Recommended');
    expect(html).toContain('Selected');
    expect(html).toContain('border-brand bg-brand/10');
    expect(html).toContain('Retina');
    expect(html).toContain('Quality');
    expect(html).not.toContain('JPEG quality');
    expect(html).not.toContain('Save changes');
    expect(html).not.toContain('floating thumbnail');
    expect(html).not.toContain('larger visual difference');
  });

  it('organizes memory into overview, suggestions, and saved-memory tabs', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="memory" />);
    expect(html).toContain('Overview');
    expect(html).toContain('Suggestions');
    expect(html).toContain('Saved memories');
  });

  it('shows Usage as a single title with no subtitle and no provider submenu', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="usage" />);
    // Exactly one "Usage" heading in the content pane, and nothing under it.
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('tracking-tight">Usage</h1>');
    expect(html).not.toContain('Provider limits and API spend');
    expect(html).not.toContain('Subscription rate-limit windows for each provider.');
    expect(html).not.toContain('Provider sections');
    expect(html).toContain('Refresh all usage');
  });

  it('keeps the Usage title and its refresh control on one row', () => {
    const html = renderToStaticMarkup(<Settings {...base} section="usage" />);
    // Same flex row: nothing closes between the heading and the control.
    const betweenTitleAndControl = html.slice(
      html.indexOf('Usage</h1>'),
      html.indexOf('Refresh all usage'),
    );
    expect(betweenTitleAndControl).not.toContain('</div>');
    expect(html).toContain('flex flex-wrap items-center justify-between');
  });
});
