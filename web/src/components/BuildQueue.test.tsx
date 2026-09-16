import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BuildQueueJob } from '../lib/types';
import { BuildQueue } from './BuildQueue';

const jobs: BuildQueueJob[] = [
  {
    id: 1,
    conversationId: 'running-chat',
    conversationTitle: 'Running chat',
    assistantName: 'Platform Dev',
    provider: 'codex',
    projectId: null,
    projectName: null,
    scopeKey: 'source',
    position: 1,
    title: 'Running build',
    status: 'running',
    conversationStatus: 'working',
    error: null,
    createdAt: '2026-07-23 12:00:00',
    startedAt: '2026-07-23 12:01:00',
  },
  {
    id: 2,
    conversationId: 'selected-chat',
    conversationTitle: 'Selected chat',
    assistantName: 'Platform Dev',
    provider: 'codex',
    projectId: null,
    projectName: null,
    scopeKey: 'source',
    position: 2,
    title: 'Selected build',
    status: 'queued',
    conversationStatus: 'idle',
    error: null,
    createdAt: '2026-07-23 12:02:00',
    startedAt: null,
  },
];

describe('BuildQueue', () => {
  it('prioritizes the chat title beside the provider icon without the assistant type', () => {
    const html = renderToStaticMarkup(
      <BuildQueue
        jobs={jobs}
        onOpen={vi.fn()}
        onRemoved={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Codex"');
    expect(html).toContain('Running chat');
    expect(html).toContain('Selected chat');
    expect(html).not.toContain('Platform Dev');
  });

  it('shows queue age from creation and build time from start', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 6, 23, 12, 5));
    const html = renderToStaticMarkup(
      <BuildQueue
        jobs={jobs}
        onOpen={vi.fn()}
        onRemoved={vi.fn()}
      />,
    );

    expect(html).toContain('Building · 4m');
    expect(html).toContain('Waiting · 3m');
    expect(html).toContain('<canvas');
    expect(html).toContain('width:26px;height:26px');
    expect(html).toContain('pt-3 pr-1 pb-3.5 pl-3');
    vi.restoreAllMocks();
  });

  it('highlights the selected conversation instead of the running job', () => {
    const html = renderToStaticMarkup(
      <BuildQueue
        jobs={jobs}
        selectedId="selected-chat"
        onOpen={vi.fn()}
        onRemoved={vi.fn()}
      />,
    );
    const rowClasses = [...html.matchAll(/<li class="([^"]*)"/g)].map((match) => match[1]?.split(' ') ?? []);

    expect(rowClasses).toHaveLength(2);
    expect(rowClasses[0]).not.toContain('bg-accent');
    expect(rowClasses[0]).not.toContain('bg-brand/5');
    expect(rowClasses[1]).toContain('bg-accent');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it('prioritizes a pending question over the running build presentation', () => {
    const html = renderToStaticMarkup(
      <BuildQueue
        jobs={[{ ...jobs[0]!, conversationStatus: 'needs_you' }]}
        onOpen={vi.fn()}
        onRemoved={vi.fn()}
      />,
    );

    expect(html).toContain('Needs your input');
    expect(html).toContain('text-amber-600');
    expect(html).not.toContain('Building');
    expect(html).not.toContain('<canvas');
    expect(html).toContain('disabled=""');
    expect(html).toContain('An active build cannot be removed');
  });

  it('labels an intentional user stop as Stopped instead of Blocked', () => {
    const stopped: BuildQueueJob = {
      ...jobs[1]!,
      id: 3,
      title: 'Paused build',
      status: 'stopped',
    };
    const html = renderToStaticMarkup(
      <BuildQueue
        jobs={[stopped]}
        onOpen={vi.fn()}
        onRemoved={vi.fn()}
      />,
    );

    expect(html).toContain('Stopped');
    expect(html).not.toContain('Blocked');
  });

  it('offers retry only on a paused job, so a blocked queue is recoverable here', () => {
    const blocked: BuildQueueJob = {
      ...jobs[1]!,
      id: 4,
      title: 'Blocked build',
      status: 'failed',
      error: 'tests failed',
    };
    const html = renderToStaticMarkup(
      <BuildQueue jobs={[blocked]} onOpen={vi.fn()} onRemoved={vi.fn()} />,
    );

    expect(html).toContain('aria-label="Retry Blocked build"');
    expect(html).toContain('Retry this build');

    // A queued job is still on its way and a running one must not be touched.
    const untouched = renderToStaticMarkup(
      <BuildQueue jobs={jobs} onOpen={vi.fn()} onRemoved={vi.fn()} />,
    );
    expect(untouched).not.toContain('Retry this build');
  });
});
