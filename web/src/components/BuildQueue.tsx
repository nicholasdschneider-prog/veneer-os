import { useEffect, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, Bot, CircleAlert, CircleHelp, CirclePause, GripVertical, Hammer, History, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { BuildQueueJob, BuildQueueMoveTarget, BuildQueueReorder } from '../lib/types';
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

// Only a waiting build has a place to go: the running/failed/stopped head
// blocks its workspace wherever its key says, so it stays put.
function canMove(job: BuildQueueJob): boolean {
  return job.status === 'queued';
}

function viaLabel(entry: BuildQueueReorder): string {
  if (entry.via === 'james_api') return 'via the James API';
  if (entry.via === 'bot_tool') return 'by bot tool';
  if (entry.via === 'agent') return 'by a bot';
  return 'in Veneer';
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
  onJobsChanged,
}: {
  jobs: BuildQueueJob[];
  selectedId?: string | null;
  onOpen: (conversationId: string, projectId: string | null) => void;
  onRemoved: (jobId: number) => void;
  /** Receives the whole fresh queue (every workspace) right after a reorder, ahead of the next poll. */
  onJobsChanged?: (jobs: BuildQueueJob[]) => void;
}) {
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [movingId, setMovingId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: number; edge: 'before' | 'after' } | null>(null);
  const [history, setHistory] = useState<BuildQueueReorder[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const scopeKey = jobs[0]?.scopeKey ?? null;
  // The order fingerprint changes when the poll shows a different queue, so the
  // history refreshes exactly when a reorder (ours or James's) could have happened.
  const orderFingerprint = jobs.map((job) => `${job.id}:${job.position}`).join(',');

  useEffect(() => {
    if (!scopeKey || typeof fetch !== 'function') return;
    let stop = false;
    void api.buildQueueHistory(scopeKey, 10).then((r) => {
      if (!stop) setHistory(r.entries);
    }).catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [scopeKey, orderFingerprint, historyVersion]);

  const move = async (job: BuildQueueJob, target: BuildQueueMoveTarget) => {
    if (!canMove(job) || movingId !== null) return;
    setMovingId(job.id);
    setRemoveError(null);
    try {
      await api.moveBuildQueueJob(job.id, target);
      const fresh = await api.buildQueue();
      onJobsChanged?.(fresh.jobs);
      setHistoryVersion((v) => v + 1);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Could not move the build');
    } finally {
      setMovingId(null);
    }
  };

  const queuedJobs = jobs.filter(canMove);
  const neighbor = (job: BuildQueueJob, offset: -1 | 1): BuildQueueJob | null => {
    const index = queuedJobs.findIndex((candidate) => candidate.id === job.id);
    return index < 0 ? null : queuedJobs[index + offset] ?? null;
  };

  const dragEdge = (event: DragEvent<HTMLElement>): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };
  const drop = (target: BuildQueueJob, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const edge = dragEdge(event);
    const dragged = jobs.find((job) => job.id === draggingId);
    setDraggingId(null);
    setDropTarget(null);
    if (!dragged || dragged.id === target.id || !canMove(target)) return;
    void move(dragged, edge === 'before' ? { before: target.id } : { after: target.id });
  };

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
              draggable={canMove(job) && movingId === null}
              onDragStart={(event) => {
                if (!canMove(job)) return;
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(job.id));
                setDraggingId(job.id);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setDropTarget(null);
              }}
              onDragOver={(event) => {
                if (draggingId === null || !canMove(job) || job.id === draggingId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const edge = dragEdge(event);
                setDropTarget((current) => (current?.id === job.id && current.edge === edge ? current : { id: job.id, edge }));
              }}
              onDragLeave={() => setDropTarget((current) => (current?.id === job.id ? null : current))}
              onDrop={(event) => drop(job, event)}
              className={cn(
                'flex items-center rounded-xl border-y-2 border-transparent',
                selected && 'bg-accent',
                draggingId === job.id && 'opacity-50',
                dropTarget?.id === job.id && dropTarget.edge === 'before' && 'border-t-brand',
                dropTarget?.id === job.id && dropTarget.edge === 'after' && 'border-b-brand',
              )}
            >
              {canMove(job) ? (
                <span
                  aria-hidden
                  title="Drag to reorder"
                  className="mt-1.5 ml-1 flex size-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 active:cursor-grabbing"
                >
                  <GripVertical className="size-4" />
                </span>
              ) : (
                <span aria-hidden className="ml-1 size-5 shrink-0" />
              )}
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
              {canMove(job) ? (
                <span className="mt-1.5 flex shrink-0 flex-col">
                  <button
                    type="button"
                    onClick={() => {
                      const above = neighbor(job, -1);
                      if (above) void move(job, { before: above.id });
                    }}
                    disabled={movingId !== null || !neighbor(job, -1)}
                    aria-label={`Move ${job.title} up`}
                    title="Move up"
                    className="flex h-4 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {movingId === job.id ? <LoaderCircle className="vp-working size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const below = neighbor(job, 1);
                      if (below) void move(job, { after: below.id });
                    }}
                    disabled={movingId !== null || !neighbor(job, 1)}
                    aria-label={`Move ${job.title} down`}
                    title="Move down"
                    className="flex h-4 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowDown className="size-3" aria-hidden />
                  </button>
                </span>
              ) : null}
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
      {history.length ? (
        <div className="px-3 pt-1 pb-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <History className="size-3.5" aria-hidden />
            <span>History</span>
            <span className="tabular-nums">({history.length})</span>
          </button>
          {historyOpen ? (
            <ol data-testid="build-queue-history" className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
              {history.map((entry) => (
                <li key={entry.id} className="flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0 tabular-nums">
                    #{entry.jobId} {entry.oldPosition}→{entry.newPosition}
                  </span>
                  <span className="min-w-0 truncate">
                    {entry.jobTitle} moved by {entry.actorLabel} {viaLabel(entry)} · {elapsedLabel(entry.createdAt)} ago
                    {entry.authorityNote ? ` · on: ${entry.authorityNote}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
