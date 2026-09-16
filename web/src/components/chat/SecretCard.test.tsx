import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { ChatItem } from '@/lib/transcript';
import { normalizeSecretValue, SecretCard, targetLocation } from './SecretCard';

const pending: Extract<ChatItem, { kind: 'question' }> = {
  kind: 'question',
  key: 'q-secret-1',
  requestId: 'secret-1',
  questions: [
    {
      id: 'q1',
      question: 'I need a Linear API key so I can file the bug reports.',
      options: [],
      multi: false,
      allowOther: true,
      kind: 'secret',
      secret: { name: 'LINEAR_API_KEY', project: 'veneer', config: 'prd' },
    },
  ],
  status: 'pending',
  answers: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SecretCard', () => {
  it('renders the purpose, the Doppler target, and a masked input', () => {
    const html = renderToStaticMarkup(<SecretCard item={pending} />);

    expect(html).not.toContain('Waiting for you');
    expect(html).toContain('I need a Linear API key so I can file the bug reports.');
    expect(html).toContain('LINEAR_API_KEY');
    expect(html).toContain('in veneer / prd');
    expect(html).toContain('aria-label="Value for LINEAR_API_KEY"');
    expect(html).toContain('-webkit-text-security:disc');
    expect(html).toContain('Paste the secret');
    expect(html).toContain('Private to you · agent cannot read');
    expect(html).not.toContain('Saved directly to Doppler.');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Show');
    // Nothing to save yet, so the action stays inert.
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Replaces the existing value.');
  });

  it('names the connected config when the target has no project or config', () => {
    const html = renderToStaticMarkup(
      <SecretCard item={{
        ...pending,
        questions: [{ ...pending.questions[0]!, secret: { name: 'STRIPE_KEY', project: null, config: null, exists: true } }],
      }} />,
    );

    expect(html).toContain('in the connected Doppler config');
    expect(html).toContain('Replaces the existing value.');
  });

  it('renders a value-free confirmation once the secret is saved', () => {
    const html = renderToStaticMarkup(
      <SecretCard item={{ ...pending, status: 'answered', answers: { q1: ['saved'] } }} />,
    );

    expect(html).toContain('Saved');
    expect(html).toContain('Saved LINEAR_API_KEY to veneer / prd.');
    expect(html).not.toContain('saved</li>');
    expect(html).not.toContain('textarea');
    expect(html).not.toContain('Paste the secret');
  });

  it('reports an expired request without claiming a save', () => {
    const html = renderToStaticMarkup(<SecretCard item={{ ...pending, status: 'expired' }} />);

    expect(html).not.toContain('No value given');
    expect(html).toContain('No value was saved.');
    expect(html).not.toContain('textarea');
  });

  it('renders no card once the request is dismissed', () => {
    expect(renderToStaticMarkup(<SecretCard item={{ ...pending, status: 'dismissed' }} />)).toBe('');
  });

  it('strips a single trailing newline from a pasted value', () => {
    expect(normalizeSecretValue('sk-live-123\n')).toBe('sk-live-123');
    expect(normalizeSecretValue('-----BEGIN KEY-----\nabc\n')).toBe('-----BEGIN KEY-----\nabc');
    expect(normalizeSecretValue('sk-live-123')).toBe('sk-live-123');
  });

  it('describes the target location', () => {
    expect(targetLocation({ name: 'A', project: 'veneer', config: 'prd' })).toBe('veneer / prd');
    expect(targetLocation({ name: 'A', project: 'veneer', config: null })).toBe('veneer');
    expect(targetLocation({ name: 'A', project: null, config: null })).toBeNull();
  });

  it('posts the value to the save-secret endpoint and nowhere else', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, status: 'working' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.saveSecret('secret 1', 'sk-live-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/questions/secret%201/save-secret');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ value: 'sk-live-123' }));
  });

  it('surfaces a save failure message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'DOPPLER_TOKEN is not set' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(api.saveSecret('secret-1', 'sk-live-123')).rejects.toThrow('DOPPLER_TOKEN is not set');
  });
});
