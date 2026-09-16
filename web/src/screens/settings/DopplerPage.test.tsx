import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DopplerConnection } from '@/lib/api';
import { DopplerGuidanceCard } from './DopplerPage';

function connection(
  mode: DopplerConnection['access']['mode'],
  additionalGuidance = '',
): DopplerConnection {
  const main = mode === 'main_full';
  const none = mode === 'none';
  return {
    connected: !none,
    project: none ? null : main ? 'veneer' : 'client-one',
    config: none ? null : 'prd',
    connectedAt: '2026-07-30T12:00:00.000Z',
    access: {
      mode,
      label: none
        ? 'Doppler not connected'
        : main ? 'Main Pro · Full workplace access' : 'Client · Connected project only',
      locked: true,
      safetyGuidance: none
        ? 'Doppler is not connected on this machine, so Veneer secrets tooling is unavailable.'
        : main
          ? 'Every Veneer agent has full Doppler access through this machine profile.'
          : 'Use only the client-scoped Doppler tools. Do not run doppler login.',
    },
    additionalGuidance,
    runtime: { configured: !none, healthy: !none, lastCheckedAt: null, error: null },
    agent: { configured: !none },
  };
}

describe('Doppler agent guidance settings', () => {
  it('shows the main Pro mode and its locked safety rule', () => {
    const html = renderToStaticMarkup(
      <DopplerGuidanceCard
        connection={connection('main_full')}
        draft=""
        canEdit
        saving={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(html).toContain('Main Pro · Full workplace access');
    expect(html).toContain('Connected to veneer/prd.');
    expect(html).toContain('Platform safety guidance');
    expect(html).toContain('Locked');
    expect(html).toContain('Every Veneer agent has full Doppler access');
    expect(html).toContain('Save guidance');
  });

  it('says Doppler is not connected instead of advertising a vault', () => {
    const html = renderToStaticMarkup(
      <DopplerGuidanceCard
        connection={connection('none')}
        draft=""
        canEdit
        saving={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(html).toContain('Doppler not connected');
    expect(html).not.toContain('Full workplace access');
    expect(html).toContain('secrets tooling is unavailable');
  });

  it('shows client-only access and keeps guidance read-only for non-owners', () => {
    const html = renderToStaticMarkup(
      <DopplerGuidanceCard
        connection={connection('client_project', 'Use the client vendor account.')}
        draft="Use the client vendor account."
        canEdit={false}
        saving={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(html).toContain('Client · Connected project only');
    expect(html).toContain('Connected to client-one/prd.');
    expect(html).toContain('Do not run doppler login.');
    expect(html).toContain('Use the client vendor account.');
    expect(html).toContain('Only the owner can change this guidance.');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Save guidance');
  });
});
