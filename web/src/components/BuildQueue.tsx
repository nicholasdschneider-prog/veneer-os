import { useState } from 'react';
import { Bot, CircleAlert, CircleHelp, CirclePause, Hammer, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { BuildQueueJob } from '../lib/types';
import { isProvider } from '../lib/modelLabel';
import { cn } from '../lib/utils';
import { AgentActivityOrb } from './AgentActivityOrb';
import { ProviderIcon } from './ProviderIcon';

function statusLabel(job: BuildQueueJob): string {
  if (job.conversationStatus === 'needs_you') return 'Needs your input';
  if (job.status === 'running') return 'Building';
  if (job.status === 'failed') return 'Blocked';
  if (job.status === 'stopped') return 'Stopped';
  return 'Waiting';
}

// Retry only makes sense for a job that already stopped; queued work is still
// on its way and a running build must not be touched.
function canResolve(job: BuildQueueJob): boolean {
  return job.status === 'failed' || job.status === 'stopped';
}

function elapsedLabel(timestamp: string): string {
  // SQLite datetime('now') is UTC without a zone suffix.
  const date = new Date(timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function BuildQueue({
  jobs,
  selectedId = null,
  onOpen,
  onRemoved,
}: {
  jobs: BuildQueueJob[];
  selectedId?: string | null;
  onOpen: (conversationId: string, projectId: string | null) => void;
  onRemoved: (jobId: number) => void;
}) {
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  // A blocked head pauses its whole workspace, so let it be restarted from here
  // instead of only through an agent. The 5s list poll picks up the new status.
  const retry = async (job: BuildQueueJob) => {
    if (!canResolve(job) || retryingId !== null) return;
    setRetryingId(job.id);
    setRemoveError(null);
    try {
      await api.retryBuildQueueJob(job.id);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Could not retry the build');
    } finally {
      setRetryingId(null);
    }
  };

  const remove = async (job: BuildQueueJob) => {
    if (job.status === 'running' || removingId !== null) return;
    if (!window.confirm(`Remove “${job.title}” from the build queue?`)) return;
    setRemovingId(job.id);
    setRemoveError(null);
    try {
      await api.removeBuildQueueJob(job.id);
      onRemoved(job.id);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Could not remove the build');
    } finally {
      setRemovingId(null);
    }
  };

  if (!jobs.length) return null;

  return (
    <section className="mt-2 border-t border-border pt-2">
      <div className="flex items-center gap-2 px-3 py-2">
        <Hammer className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Build queue</span>
        <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums">
          {jobs.length}
        </span>
      </div>

      {removeError ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {removeError}
        </p>
      ) : null}
      <ol className="flex flex-col gap-0.5">
        {jobs.map((job) => {
          const selected = job.conversationId === selectedId;
          const needsInput = job.conversationStatus === 'needs_you';
          const elapsedFrom = job.status === 'running' ? job.startedAt ?? job.createdAt : job.createdAt;
          return (
            <li
              key={job.id}
              className={cn('flex items-center rounded-xl', selected && 'bg-accent')}
            >
              <button
                type="button"
                onClick={() => onOpen(job.conversationId, job.projectId)}
                aria-current={selected ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl pt-3 pr-1 pb-3.5 pl-3 text-left active:bg-accent"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium tabular-nums">
                  {job.position}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{job.title}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {job.provider && isProvider(job.provider) ? (
                      <ProviderIcon provider={job.provider} className="size-3 shrink-0" />
                    ) : (
                      <Bot className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{job.conversationTitle ?? 'Untitled chat'}</span>
                  </span>
                </span>
                <span
                  title={job.error ?? undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums',
                    needsInput && 'text-amber-600 dark:text-amber-500',
                    !needsInput && job.status === 'running' && 'text-brand',
                    job.status === 'failed' && 'text-destructive',
                    job.status === 'stopped' && 'text-amber-600 dark:text-amber-400',
                    job.status === 'queued' && 'text-muted-foreground',
                  )}
                >
                  {needsInput ? <CircleHelp className="size-3" aria-hidden /> : null}
                  {job.status === 'running' && !needsInput ? (
                    <AgentActivityOrb
                      state="shaping"
                      size={64}
                      className="shrink-0"
                      style={{ width: 26, height: 26 }}
                      aria-hidden
                    />
                  ) : null}
                  {job.status === 'failed' ? <CircleAlert className="size-3" aria-hidden /> : null}
                  {job.status === 'stopped' ? <CirclePause className="size-3" aria-hidden /> : null}
                  <span>{statusLabel(job)} · {elapsedLabel(elapsedFrom)}</span>
                </span>
              </button>
              {canResolve(job) ? (
                <button
                  type="button"
                  onClick={() => void retry(job)}
                  disabled={retryingId !== null || removingId !== null}
                  aria-label={`Retry ${job.title}`}
                  title="Retry this build"
                  className="mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {retryingId === job.id ? (
                    <LoaderCircle className="vp-working size-4" aria-hidden />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden />
                  )}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void remove(job)}
                disabled={job.status === 'running' || removingId !== null || retryingId !== null}
                aria-label={`Remove ${job.title} from the build queue`}
                title={job.status === 'running' ? 'An active build cannot be removed' : 'Remove from queue'}
                className="mt-1.5 mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-35"
              >
                {removingId === job.id ? (
                  <LoaderCircle className="vp-working size-4" aria-hidden />
                ) : (
                  <Trash2 className="size-4" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
