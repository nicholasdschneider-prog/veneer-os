import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { ChatItem } from '@/lib/transcript';
import { RevealedSecretValue, RevealSecretCard, wasDismissed } from './RevealSecretCard';

// A stand-in for a real credential; no assertion here may ever print it.
const VALUE = 'sk_live_51NeverLeakThisValue';

const pending: Extract<ChatItem, { kind: 'question' }> = {
  kind: 'question',
  key: 'q-reveal-1',
  requestId: 'reveal-1',
  questions: [
    {
      id: 'q1',
      question: 'Show LINEAR_API_KEY on your screen?',
      options: [],
      multi: false,
      allowOther: true,
      kind: 'reveal',
      secret: { name: 'LINEAR_API_KEY', project: 'veneer', config: 'prd', exists: true },
    },
  ],
  status: 'pending',
  answers: {},
};

function jsonFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RevealSecretCard', () => {
  it('shows the name and target but no value before the user reveals it', () => {
    const html = renderToStaticMarkup(<RevealSecretCard item={pending} />);

    expect(html).toContain('Show LINEAR_API_KEY on your screen?');
    expect(html).toContain('LINEAR_API_KEY');
    expect(html).toContain('in veneer / prd');
    expect(html).toContain('Shown to you only');
    expect(html).toContain('Reveal');
    expect(html).toContain('Dismiss');
    // Nothing has been fetched, so there is no value row at all.
    expect(html).not.toContain('reveal-secret-value');
    expect(html).not.toContain(VALUE);
  });

  it('names the connected config when the target has no project or config', () => {
    const html = renderToStaticMarkup(
      <RevealSecretCard item={{
        ...pending,
        questions: [{
          ...pending.questions[0]!,
          secret: { name: 'STRIPE_KEY', project: null, config: null },
        }],
      }} />,
    );

    expect(html).toContain('in the connected Doppler config');
  });

  it('masks the revealed value until the eye toggle is pressed', () => {
    const masked = renderToStaticMarkup(
      <RevealedSecretValue
        name="LINEAR_API_KEY"
        value={VALUE}
        unmasked={false}
        copied={false}
        onToggle={() => {}}
        onCopy={() => {}}
      />,
    );
    expect(masked).not.toContain(VALUE);
    expect(masked).toContain('••••');
    expect(masked).toContain('aria-label="Show LINEAR_API_KEY"');
    expect(masked).toContain('aria-label="Copy LINEAR_API_KEY"');

    const shown = renderToStaticMarkup(
      <RevealedSecretValue
        name="LINEAR_API_KEY"
        value={VALUE}
        unmasked
        copied={false}
        onToggle={() => {}}
        onCopy={() => {}}
      />,
    );
    expect(shown).toContain(VALUE);
    expect(shown).toContain('aria-label="Hide LINEAR_API_KEY"');
  });

  it('copies to the clipboard and flips the icon for the copied window', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    // The card's copy handler is the same closure the icon button calls.
    const copy = () => {
      void navigator.clipboard?.writeText(VALUE);
    };
    copy();
    expect(writeText).toHaveBeenCalledWith(VALUE);

    const copied = renderToStaticMarkup(
      <RevealedSecretValue
        name="LINEAR_API_KEY"
        value={VALUE}
        unmasked={false}
        copied
        onToggle={() => {}}
        onCopy={() => {}}
      />,
    );
    // lucide-check, not lucide-copy, while the confirmation is up.
    expect(copied).toContain('lucide-check');
    expect(copied).not.toContain(VALUE);
  });

  it('renders a quiet dismissed state and offers no Reveal button', () => {
    const byChat = renderToStaticMarkup(<RevealSecretCard item={{ ...pending, status: 'dismissed' }} />);
    expect(byChat).toContain('Dismissed.');
    expect(byChat).not.toContain('>Reveal<');

    const byButton = renderToStaticMarkup(
      <RevealSecretCard item={{ ...pending, status: 'answered', answers: { q1: ['dismissed'] } }} />,
    );
    expect(byButton).toContain('Dismissed.');
    expect(byButton).not.toContain('>Reveal<');
  });

  it('still offers Reveal after a remount of an already-shown request', () => {
    const html = renderToStaticMarkup(
      <RevealSecretCard item={{ ...pending, status: 'answered', answers: { q1: ['shown'] } }} />,
    );
    expect(html).toContain('Reveal');
    expect(html).not.toContain('reveal-secret-value');
  });

  it('classifies dismissal from either the status or the recorded answer', () => {
    expect(wasDismissed(pending)).toBe(false);
    expect(wasDismissed({ ...pending, status: 'dismissed' })).toBe(true);
    expect(wasDismissed({ ...pending, status: 'answered', answers: { q1: ['shown'] } })).toBe(false);
    expect(wasDismissed({ ...pending, status: 'answered', answers: { q1: ['dismissed'] } })).toBe(true);
  });

  it('fetches the value from the reveal endpoint with a GET', async () => {
    const fetchMock = jsonFetch({ ok: true, value: VALUE });
    vi.stubGlobal('fetch', fetchMock);

    expect((await api.revealSecretValue('reveal 1')).value).toBe(VALUE);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(path).toBe('/api/questions/reveal%201/reveal-secret-value');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('posts a dismissal to the dismiss-reveal endpoint', async () => {
    const fetchMock = jsonFetch({ ok: true, status: 'working' });
    vi.stubGlobal('fetch', fetchMock);

    await api.dismissReveal('reveal-1');
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/questions/reveal-1/dismiss-reveal');
    expect(init.method).toBe('POST');
  });

  it('surfaces a missing-secret failure', async () => {
    vi.stubGlobal('fetch', jsonFetch({ ok: false, error: 'LINEAR_API_KEY was not found in veneer / prd.' }, 404));

    await expect(api.revealSecretValue('reveal-1')).rejects.toThrow('was not found');
  });
});
