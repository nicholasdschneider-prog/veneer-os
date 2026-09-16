import { describe, expect, it } from 'vitest';
import {
  guardLoopbackDeliverableEvents,
  guardLoopbackDeliverableMarkdown,
  isLoopbackHttpUrl,
} from '../src/runtime/loopbackDeliverables.js';
import type { ConversationEvent } from '../src/runtime/events.js';

describe('loopback deliverable guard', () => {
  it.each([
    'http://localhost:8788/testbench/',
    'https://app.localhost/',
    'http://127.0.0.1:3000/',
    'http://127.0.0.42/',
    'http://[::1]:4173/',
    'http://0.0.0.0:8000/',
  ])('recognizes %s as agent-local', (href) => {
    expect(isLoopbackHttpUrl(href)).toBe(true);
  });

  it.each([
    'https://example.com/docs?target=http://localhost:3000',
    'https://localhost.example.com/',
    'http://10.0.0.20:3000/',
    '/localhost/test',
  ])('does not mistake %s for a loopback URL', (href) => {
    expect(isLoopbackHttpUrl(href)).toBe(false);
  });

  it('guards linked, autolinked, and bare loopback previews offered for testing', () => {
    const markdown = [
      '[Open the preview](http://localhost:8788/testbench/)',
      '<http://127.0.0.1:3000/>',
      'Try http://app.localhost/ now.',
    ].join('\n');
    const guarded = guardLoopbackDeliverableMarkdown('Build this tool and give me a way to test it.', markdown);

    expect(guarded).not.toContain('](http://localhost');
    expect(guarded).not.toContain('<http://127.0.0.1');
    expect(guarded.match(/agent-only/g)).toHaveLength(3);
    expect(guarded).toContain('**Preview unavailable:**');
  });

  it('leaves technical discussion, commands, and external URLs unchanged', () => {
    const markdown = [
      'Localhost resolves on the current machine.',
      '`curl http://localhost:3000/health`',
      '```sh\ncurl http://127.0.0.1:3100/healthz\n```',
      '[Troubleshooting](https://example.com/docs?target=http://localhost:3000)',
    ].join('\n\n');

    expect(guardLoopbackDeliverableMarkdown('Explain how localhost works.', markdown)).toBe(markdown);
  });

  it.each([
    'Give me the localhost URL for this local-only test.',
    'Run the server locally and leave it local only.',
    'Start it on localhost so I can test the browser on that machine.',
    'Open 127.0.0.1 in the browser for this local test.',
  ])('honors an explicit local-only request: %s', (prompt) => {
    const markdown = 'Open <http://localhost:3000/>.';
    expect(guardLoopbackDeliverableMarkdown(prompt, markdown)).toBe(markdown);
  });

  it('does not treat a rejection of localhost as permission to return it', () => {
    const prompt = "Build the app, but don't give me a localhost link. I need to open it.";
    expect(guardLoopbackDeliverableMarkdown(prompt, 'Open http://localhost:3000/')).toContain('Preview unavailable');
  });

  it('applies the same guard when provider transcripts are reloaded', () => {
    const events: ConversationEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-1',
        role: 'user',
        text: 'Build a page I can preview.',
        at: '2026-08-21T00:00:00.000Z',
      },
      {
        type: 'text_final',
        turnId: 'turn-1',
        markdown: 'Open [the page](http://localhost:5173/).',
        at: '2026-08-21T00:00:01.000Z',
      },
    ];

    const guarded = guardLoopbackDeliverableEvents(events);
    expect(guarded[1]).toMatchObject({ type: 'text_final', markdown: expect.stringContaining('Preview unavailable') });
  });
});
