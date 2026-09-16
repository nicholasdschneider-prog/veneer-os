import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  ChevronDown,
  CircleAlert,
  Copy,
  History,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Pin,
  Play,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';
import {
  api,
  type ModelOption,
  type ModelPrefs,
} from '../lib/api';
import { agentBadge, effortOptionsFor, isProvider, modelLabel, providerLabel, type Provider } from '../lib/modelLabel';
import { ProviderIcon } from '@/components/ProviderIcon';
import {
  ModelThinkingPicker,
  buildModelChoices,
  effortLabel,
  type ModelChoice,
  type ModelThinkingValue,
} from '@/components/chat/ModelThinkingPicker';
import type {
  AutomationFilter,
  AutomationsSummary,
  Project,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
} from '../lib/types';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsTabs } from './settings/SettingsPrimitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_SCHEDULE_TIME_ZONE = 'America/New_York';
type ScheduleType = ScheduledTaskSchedule['type'];
interface Draft {
  name: string;
  prompt: string;
  triggerKind: 'schedule' | 'event';
  type: ScheduleType;
  time: string;
  weekday: number;
  runAt: string;
  cron: string;
  timezone: string;
  projectId: string;
  provider: Provider;
  model: string;
  effort: string;
  connectorId: number | null;
  channelId: string;
  minimumWords: number;
}

function localInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function blankDraft(modelChoice?: ModelThinkingValue): Draft {
  return {
    name: '',
    prompt: '',
    triggerKind: 'schedule',
    type: 'weekdays',
    time: '08:00',
    weekday: 1,
    runAt: localInput(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    cron: '0 8-17 * * 1-5',
    timezone: DEFAULT_SCHEDULE_TIME_ZONE,
    projectId: '',
    provider: modelChoice?.provider ?? 'claude',
    model: modelChoice?.model ?? '',
    effort: modelChoice?.effort ?? '',
    connectorId: null,
    channelId: '',
    minimumWords: 4,
  };
}

function draftFor(task: ScheduledTask, prefs: ModelPrefs | null): Draft {
  const schedule = task.schedule;
  const wordFilter = task.filters.find(
    (filter) => filter.field === 'message.text' && filter.operator === 'word_count_gt',
  );
  return {
    name: task.name,
    prompt: task.prompt,
    triggerKind: task.triggerKind,
    type: schedule?.type ?? 'weekdays',
    time: !schedule || schedule.type === 'once' || schedule.type === 'cron' ? '08:00' : schedule.time,
    weekday: schedule?.type === 'weekly' ? schedule.weekday : 1,
    runAt: schedule?.type === 'once' ? localInput(new Date(schedule.runAt)) : blankDraft().runAt,
    cron: schedule?.type === 'cron' ? schedule.expression : blankDraft().cron,
    timezone: task.timezone,
    projectId: task.projectId ?? '',
    provider: task.provider,
    model: task.model && task.model !== prefs?.providerDefaults[task.provider] ? task.model : '',
    effort: task.effort ?? '',
    connectorId: task.connectorId,
    channelId: typeof task.triggerConfig.channelId === 'string' ? task.triggerConfig.channelId : '',
    minimumWords: typeof wordFilter?.value === 'number' ? wordFilter.value : 4,
  };
}

function scheduleFrom(draft: Draft): ScheduledTaskSchedule {
  if (draft.type === 'once') return { type: 'once', runAt: new Date(draft.runAt).toISOString() };
  if (draft.type === 'cron') return { type: 'cron', expression: draft.cron.trim() };
  if (draft.type === 'weekly') return { type: 'weekly', time: draft.time, weekday: draft.weekday };
  return { type: draft.type, time: draft.time };
}

function exactTime(value: string | null): string {
  if (!value) return 'No upcoming run';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function runLabel(status: ScheduledTask['recentRuns'][number]['status']): string {
  if (status === 'needs_you') return 'Needs you';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** The latest run failed or waits for the user, or the trigger itself is broken. */
function needsAttention(task: ScheduledTask): boolean {
  const latest = task.recentRuns[0];
  if (latest && (latest.status === 'failed' || latest.status === 'needs_you')) return true;
  return task.triggerStatus === 'error' || task.triggerError !== null;
}

function isRunning(task: ScheduledTask): boolean {
  const latest = task.recentRuns[0];
  return latest ? latest.status === 'running' || latest.status === 'queued' : false;
}

type TabValue = 'all' | 'attention' | 'paused';

function defaultModelChoice(prefs: ModelPrefs | null, choices: ModelChoice[] | null): ModelThinkingValue {
  const provider = prefs && isProvider(prefs.defaultProvider) ? prefs.defaultProvider : 'claude';
  const selected = choices?.find((choice) => choice.provider === provider && choice.model === '');
  const effort = effortOptionsFor(provider, selected?.efforts).includes(prefs?.defaultEffort ?? '')
    ? prefs!.defaultEffort!
    : '';
  return { provider, model: '', effort };
}

export function Scheduled({
  onNavigate,
  onToast,
  focusTaskId,
}: {
  onNavigate: (hash: string) => void;
  onToast: (message: string) => void;
  /** ?task=<id> — open that automation's editor on arrival (the chat strip links here). */
  focusTaskId?: string | null;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [summary, setSummary] = useState<AutomationsSummary | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [prefs, setPrefs] = useState<ModelPrefs | null>(null);
  const [modelChoices, setModelChoices] = useState<ModelChoice[] | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [historyTask, setHistoryTask] = useState<ScheduledTask | null>(null);
  const [historyRuns, setHistoryRuns] = useState<ScheduledTaskRun[] | null>(null);
  const [tab, setTab] = useState<TabValue>('all');
  // Open rows live in state so the 5s refresh does not collapse them.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [deleteTask, setDeleteTask] = useState<ScheduledTask | null>(null);

  const load = useCallback(() => {
    void api
      .scheduledTasks()
      .then((result) => {
        setTasks(result.scheduledTasks);
        setSummary(result.summary);
      })
      .catch((err: Error) => onToast(err.message));
  }, [onToast]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) load();
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.projects().then((result) => result.projects),
      api.modelPrefs().then((result) => result.prefs),
      api.models('claude').then((result) => result.models).catch(() => [] as ModelOption[]),
      api.models('openrouter').then((result) => result.models).catch(() => [] as ModelOption[]),
      api.models('codex').then((result) => result.models).catch(() => [] as ModelOption[]),
      api.models('grok').then((result) => result.models).catch(() => [] as ModelOption[]),
    ])
      .then(([nextProjects, nextPrefs, claude, openrouter, codex, grok]) => {
        if (!active) return;
        setProjects(nextProjects);
        setPrefs(nextPrefs);
        setModelChoices(buildModelChoices(
          { claude, openrouter, codex, grok },
          nextPrefs.hiddenModels,
          nextPrefs.providerDefaults,
          nextPrefs.modelOrder,
        ));
      })
      .catch((err: Error) => onToast(err.message));
    return () => {
      active = false;
    };
  }, [onToast]);

  const openEditor = (task?: ScheduledTask) => {
    setEditingId(task?.id ?? null);
    setDraft(task ? draftFor(task, prefs) : blankDraft(defaultModelChoice(prefs, modelChoices)));
    setConfirmDelete(false);
    setDialogOpen(true);
  };

  /** Duplicate opens the editor with an unsaved copy of the task's draft. */
  const duplicateTask = (task: ScheduledTask) => {
    setEditingId(null);
    setDraft({ ...draftFor(task, prefs), name: `${task.name} copy` });
    setConfirmDelete(false);
    setDialogOpen(true);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Arriving from a run's chat via ?task=<id>: open that editor once the list
  // has loaded, then drop the param so the 5s refresh and any later Back don't
  // reopen the dialog over the user.
  const focusedTaskId = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTaskId || !tasks || focusedTaskId.current === focusTaskId) return;
    focusedTaskId.current = focusTaskId;
    const task = tasks.find((candidate) => candidate.id === focusTaskId);
    if (task) openEditor(task);
    else onToast('That automation no longer exists');
    onNavigate('#/automations');
  }, [focusTaskId, tasks, onNavigate, onToast]);

  const save = async () => {
    setBusy(true);
    try {
      const filters: AutomationFilter[] = [
        { field: 'message.text', operator: 'word_count_gt', value: draft.minimumWords },
      ];
      if (editingId) {
        const currentTask = tasks?.find((task) => task.id === editingId);
        const currentModel =
          currentTask?.model && currentTask.model !== prefs?.providerDefaults[currentTask.provider]
            ? currentTask.model
            : '';
        const modelChanged =
          draft.provider !== currentTask?.provider || draft.model !== currentModel;
        const effortChanged = draft.effort !== (currentTask?.effort ?? '');
        await api.updateScheduledTask(editingId, {
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          projectId: draft.projectId || null,
          provider: modelChanged ? draft.provider : undefined,
          model: modelChanged ? draft.model || undefined : undefined,
          effort: modelChanged || effortChanged ? draft.effort || null : undefined,
          ...(draft.triggerKind === 'event'
            ? { filters }
            : { schedule: scheduleFrom(draft), timezone: draft.timezone }),
        });
      } else if (draft.triggerKind === 'event') {
        await api.createScheduledTask({
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          triggerKind: 'event',
          recipe: 'slack.dm.received',
          connectorId: draft.connectorId!,
          triggerConfig: { channelId: draft.channelId.trim() },
          filters,
          projectId: draft.projectId || null,
          provider: draft.provider,
          model: draft.model || undefined,
          effort: draft.effort || undefined,
        });
      } else {
        await api.createScheduledTask({
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          triggerKind: 'schedule',
          schedule: scheduleFrom(draft),
          timezone: draft.timezone,
          projectId: draft.projectId || null,
          provider: draft.provider,
          model: draft.model || undefined,
          effort: draft.effort || undefined,
        });
      }
      setDialogOpen(false);
      onToast(editingId ? 'Automation updated' : 'Automation created');
      load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not save automation');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editingId) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await api.deleteScheduledTask(editingId);
      setDialogOpen(false);
      onToast('Automation deleted; its run chats were archived');
      load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not delete automation');
    } finally {
      setBusy(false);
    }
  };

  const removeTask = async (task: ScheduledTask) => {
    setBusy(true);
    try {
      await api.deleteScheduledTask(task.id);
      setDeleteTask(null);
      onToast('Automation deleted; its run chats were archived');
      load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not delete automation');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (task: ScheduledTask) => {
    try {
      const result = await api.updateScheduledTask(task.id, { enabled: !task.enabled });
      setTasks((current) => current?.map((item) => (item.id === task.id ? result.scheduledTask : item)) ?? current);
      onToast(task.enabled ? 'Automation paused' : 'Automation resumed');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not update automation');
    }
  };

  const togglePin = async (task: ScheduledTask) => {
    try {
      await api.updateScheduledTask(task.id, { pinned: !task.pinned });
      onToast(task.pinned ? 'Automation unpinned' : 'Automation pinned in Chats');
      load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not pin automation');
    }
  };

  const runNow = async (task: ScheduledTask) => {
    try {
      const result = await api.runScheduledTaskNow(task.id);
      onToast('Automation started');
      onNavigate(`#/chat/${result.conversationId}?from=automations`);
    } catch (err) {
      onToast(err instanceof Error && err.message === 'already_running' ? 'This automation is already running' : err instanceof Error ? err.message : 'Could not start run');
    }
  };

  const openHistory = async (task: ScheduledTask) => {
    setHistoryTask(task);
    setHistoryRuns(null);
    try {
      const result = await api.scheduledTaskRuns(task.id);
      setHistoryRuns(result.runs);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not load run history');
      setHistoryTask(null);
    }
  };

  const toggleImportant = async (task: ScheduledTask, run: ScheduledTaskRun) => {
    try {
      const result = await api.updateScheduledTaskRun(task.id, run.id, !run.important);
      setHistoryRuns((current) => current?.map((item) => (item.id === run.id ? result.run : item)) ?? current);
      setTasks((current) =>
        current?.map((item) =>
          item.id === task.id
            ? { ...item, recentRuns: item.recentRuns.map((entry) => (entry.id === run.id ? result.run : entry)) }
            : item,
        ) ?? current,
      );
      onToast(run.important ? 'Run removed from Chats' : 'Important run will appear in Chats');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not update run');
    }
  };

  const allTasks = tasks ?? [];
  const pausedTasks = allTasks.filter((task) => !task.enabled);
  const attentionTasks = allTasks.filter(needsAttention);
  const visibleTasks = tab === 'paused' ? pausedTasks : tab === 'attention' ? attentionTasks : allTasks;
  const selectedModel = modelChoices?.find(
    (choice) => choice.provider === draft.provider && choice.model === draft.model,
  );
  const modelChipLabel =
    providerLabel(draft.provider) +
    (selectedModel?.short || draft.model
      ? ` ${selectedModel?.short ?? modelLabel(draft.model) ?? draft.model}`
      : '') +
    (draft.effort ? ` · ${effortLabel(draft.effort)}` : '');

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center justify-between gap-4 px-5 pb-4 pt-6">
        <div>
          <h1 className="text-2xl font-semibold">Automations</h1>
          <p className="mt-1 text-sm text-muted-foreground">Background agents, organized by automation and run.</p>
          {summary ? (
            <p className="mt-1 text-sm text-muted-foreground" aria-label="Automation status summary">
              <span className="font-medium text-foreground tabular-nums">{summary.running}</span> running
              <span className="px-1.5 text-border">·</span>
              <span className={summary.needsAttention > 0 ? 'font-medium text-amber-600' : undefined}>
                <span className="tabular-nums">{summary.needsAttention}</span> need attention
              </span>
              <span className="px-1.5 text-border">·</span>
              <span className="font-medium text-foreground tabular-nums">{summary.recentlyCompleted}</span> completed, 24 h
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button className="h-11 rounded-xl" onClick={() => openEditor()}>
            <Plus className="size-4" /> New
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-[calc(var(--vp-nav-h)+1.25rem)] md:pb-6">
        {tasks === null ? (
          <p className="py-16 text-center text-muted-foreground">Loading…</p>
        ) : tasks.length === 0 ? (
          <div className="py-20 text-center">
            <CalendarClock className="mx-auto size-11 text-muted-foreground" />
            <p className="mt-4 text-lg font-medium">No automations yet</p>
            <p className="mx-auto mt-1 max-w-sm text-muted-foreground">
              Create one here, or ask an agent: “Every weekday at 8, review my inbox.”
            </p>
            <Button className="mt-5 h-11 rounded-xl" onClick={() => openEditor()}>
              Create automation
            </Button>
          </div>
        ) : (
          <div>
            <div className="mb-3">
              <SettingsTabs
                label="Filter automations"
                value={tab}
                onChange={setTab}
                items={[
                  { value: 'all', label: 'All', count: allTasks.length },
                  { value: 'attention', label: 'Needs attention', count: attentionTasks.length },
                  { value: 'paused', label: 'Paused', count: pausedTasks.length },
                ]}
              />
            </div>

            {visibleTasks.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {tab === 'attention' ? 'Nothing needs attention.' : 'No paused automations.'}
              </p>
            ) : (
              <div className="divide-y overflow-hidden rounded-xl border bg-card">
                {visibleTasks.map((task) => {
                  const open = expanded.has(task.id);
                  const running = isRunning(task);
                  const attention = needsAttention(task);
                  const dotClass = !task.enabled
                    ? 'bg-muted-foreground/40'
                    : attention
                      ? 'bg-amber-500'
                      : running
                        ? 'bg-emerald-600 animate-pulse ring-2 ring-emerald-600/25'
                        : 'bg-emerald-600';
                  return (
                    <div key={task.id} className={open ? 'bg-muted/30' : undefined}>
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => toggleExpanded(task.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggleExpanded(task.id);
                          }
                        }}
                        className={`flex min-h-12 cursor-pointer select-none items-center gap-3 px-3 py-2 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring ${!task.enabled ? 'opacity-70' : ''}`}
                      >
                        <span className={`size-2 shrink-0 rounded-full ${dotClass}`} aria-hidden />
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium">{task.name}</span>
                          {task.pinned ? (
                            <Pin className="size-3 shrink-0 fill-current text-primary" aria-label="Pinned in Chats" />
                          ) : null}
                        </span>
                        <span className="ml-auto hidden truncate text-sm text-muted-foreground md:inline">
                          {task.scheduleText}
                        </span>
                        <span className="ml-auto hidden shrink-0 whitespace-nowrap text-sm text-muted-foreground md:ml-0 sm:inline">
                          {running ? (
                            <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 text-xs font-medium text-emerald-700">Running</span>
                          ) : attention ? (
                            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">Needs attention</span>
                          ) : task.triggerKind === 'event' ? (
                            <span className="inline-flex items-center gap-1.5">
                              <MessageSquareText className="size-3.5" /> Slack DM
                            </span>
                          ) : !task.enabled ? (
                            'Paused'
                          ) : (
                            `Next: ${exactTime(task.nextRunAt)}`
                          )}
                        </span>
                        <span
                          className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Switch
                            checked={task.enabled}
                            onCheckedChange={() => void toggle(task)}
                            aria-label={task.enabled ? `Pause ${task.name}` : `Resume ${task.name}`}
                          />
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${task.name}`}>
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                              {task.triggerKind === 'schedule' ? (
                                <DropdownMenuItem onSelect={() => void runNow(task)}>
                                  <Play /> Run now
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem onSelect={() => openEditor(task)}>
                                <Pencil /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => void openHistory(task)}>
                                <History /> Full history
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => void togglePin(task)}>
                                <Pin /> {task.pinned ? 'Unpin' : 'Pin'}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => duplicateTask(task)}>
                                <Copy /> Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTask(task)}>
                                <Trash2 /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                      </div>

                      {open ? (
                        <div className="border-t border-dashed px-3 pb-4 pt-3 sm:pl-8">
                          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.prompt}</p>
                          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                            <span className="sm:hidden">{task.scheduleText}</span>
                            {task.triggerKind === 'schedule' ? <span>{task.timezone}</span> : null}
                            <span>{agentBadge(task.provider, task.model) ?? providerLabel(task.provider)}</span>
                            <span>{task.effort ? `${task.effort[0]!.toUpperCase()}${task.effort.slice(1)} thinking` : 'Provider-default thinking'}</span>
                            <span>{task.projectName ?? 'Automations workspace'}</span>
                            {task.triggerError ? <span className="text-amber-700">{task.triggerError}</span> : null}
                          </div>
                          {task.triggerKind === 'schedule' && task.upcomingRuns.length > 0 ? (
                            <p className="mt-2 text-base/7 text-muted-foreground sm:text-sm/6">
                              Next runs: {task.upcomingRuns.map(exactTime).join(' · ')}
                            </p>
                          ) : null}

                          {task.recentRuns.length > 0 ? (
                            <div className="mt-3 rounded-xl border bg-background">
                              <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
                                <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  <History className="size-3.5" /> Recent runs
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void openHistory(task)}
                                  className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                                >
                                  Full history
                                </button>
                              </div>
                              <div className="divide-y">
                                {task.recentRuns.slice(0, 3).map((run) => (
                                  <div key={run.id} className="flex items-center gap-1 px-2">
                                    <button
                                      type="button"
                                      disabled={!run.conversationId}
                                      onClick={() => run.conversationId && onNavigate(`#/chat/${run.conversationId}?from=automations`)}
                                      className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-1 py-2 text-left text-sm disabled:cursor-default"
                                    >
                                      <span className="truncate text-muted-foreground">{exactTime(run.scheduledFor)}</span>
                                      <span className={run.status === 'failed' || run.status === 'needs_you' ? 'text-amber-600' : ''}>
                                        {runLabel(run.status)}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void toggleImportant(task, run)}
                                      className={`rounded-full p-1.5 ${run.important ? 'text-amber-600' : 'text-muted-foreground/60'}`}
                                      aria-label={run.important ? 'Remove important mark' : 'Mark run important'}
                                      title={run.important ? 'Remove from Chats' : 'Mark important and show in Chats'}
                                    >
                                      <Star className={`size-3.5 ${run.important ? 'fill-current' : ''}`} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {task.triggerKind === 'schedule' ? (
                              <Button variant="outline" size="sm" onClick={() => void runNow(task)}>
                                <Play /> Run now
                              </Button>
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                Send a DM in the selected conversation to test
                              </span>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => openEditor(task)}>
                              Edit
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !busy && setDialogOpen(open)}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit automation' : 'New automation'}</DialogTitle>
            <DialogDescription>Each run is kept in this automation's history instead of the main chat list.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Name</span>
              <Input name="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Morning inbox review" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">When</span>
              <select
                name="triggerKind"
                value={draft.triggerKind}
                disabled={editingId !== null}
                onChange={(e) => setDraft({ ...draft, triggerKind: e.target.value as Draft['triggerKind'] })}
                className="h-10 w-full rounded-xl border border-input bg-background px-3 disabled:opacity-60"
              >
                <option value="schedule">On a schedule</option>
                {editingId && draft.triggerKind === 'event' ? (
                  <option value="event">Removed connector event</option>
                ) : null}
              </select>
              {editingId ? <span className="block text-xs text-muted-foreground">The trigger source is fixed after creation.</span> : null}
            </label>
            {draft.triggerKind === 'event' ? (
              <div className="space-y-4 rounded-xl border bg-muted/30 p-3">
                <p className="text-sm text-amber-700">
                  This automation uses a connector that is no longer available. You can edit its prompt or delete it.
                </p>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">Only if</span>
                  <div className="flex items-center gap-2 text-sm">
                    <span>Message has more than</span>
                    <Input
                      name="minimumWords"
                      type="number"
                      min={0}
                      max={1_000}
                      value={draft.minimumWords}
                      onChange={(e) => setDraft({ ...draft, minimumWords: Number(e.target.value) })}
                      className="w-20"
                    />
                    <span>words</span>
                  </div>
                </label>
              </div>
            ) : null}
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Agent prompt</span>
              <textarea
                name="prompt"
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                placeholder="Review my new email and tell me what needs attention."
                rows={5}
                className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {draft.triggerKind === 'event' ? (
                <span className="block text-xs text-muted-foreground">
                  The matching DM is attached as untrusted context. This sample never replies to Slack.
                </span>
              ) : null}
            </label>
            <div className="flex">
              <button
                type="button"
                onPointerUp={() => setModelPickerOpen(true)}
                aria-label="Automation model and thinking"
                className="flex min-w-0 items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ProviderIcon provider={draft.provider} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{modelChipLabel}</span>
                <ChevronDown className="size-3.5 shrink-0" />
              </button>
            </div>
            {draft.triggerKind === 'schedule' ? <>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="group" aria-label="Schedule mode">
              <button
                type="button"
                aria-pressed={draft.type !== 'cron'}
                onClick={() => setDraft({ ...draft, type: 'weekdays' })}
                className={`h-8 rounded-lg px-2.5 text-sm font-medium ${draft.type !== 'cron' ? 'bg-background text-foreground shadow-xs dark:shadow-none' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Simple
              </button>
              <button
                type="button"
                aria-pressed={draft.type === 'cron'}
                onClick={() => setDraft({ ...draft, type: 'cron' })}
                className={`h-8 rounded-lg px-2.5 text-sm font-medium ${draft.type === 'cron' ? 'bg-background text-foreground shadow-xs dark:shadow-none' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Advanced
              </button>
            </div>
            {draft.type === 'cron' ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Cron expression</span>
                <Input
                  name="cron"
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                  placeholder="0 8-17 * * 1-5"
                  className="font-mono"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <span className="block text-base/7 text-muted-foreground sm:text-sm/6">
                  Five fields: minute, hour, day, month, weekday. Example runs hourly from 8 AM through 5 PM on weekdays.
                </span>
              </label>
            ) : <><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Repeats</span>
                <select
                  name="scheduleType"
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as ScheduleType })}
                  className="h-10 w-full rounded-xl border border-input bg-background px-3"
                >
                  <option value="once">Once</option>
                  <option value="daily">Every day</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
              {draft.type === 'weekly' ? (
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">Day</span>
                  <select
                    name="weekday"
                    value={draft.weekday}
                    onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}
                    className="h-10 w-full rounded-xl border border-input bg-background px-3"
                  >
                    {DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
                  </select>
                </label>
              ) : null}
            </div>
            {draft.type === 'once' ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Run at</span>
                <Input name="runAt" type="datetime-local" value={draft.runAt} onChange={(e) => setDraft({ ...draft, runAt: e.target.value })} />
              </label>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Time</span>
                <Input name="time" type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
              </label>
            )}
            </>}
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Timezone</span>
              <Input name="timezone" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} />
            </label>
            </> : null}
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Run workspace</span>
              <select
                name="projectId"
                value={draft.projectId}
                onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
                className="h-10 w-full rounded-xl border border-input bg-background px-3"
              >
                <option value="">Automations workspace</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <span className="block text-xs text-muted-foreground">Project context applies to future runs; history stays with this automation.</span>
            </label>
          </div>

          {confirmDelete ? (
            <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              Delete this automation? Its previous run chats will move to Archived chats.
            </div>
          ) : null}

          <DialogFooter>
            {editingId ? (
              <Button variant={confirmDelete ? 'destructive' : 'ghost'} disabled={busy} onClick={() => void remove()}>
                <Trash2 className="size-4" /> {confirmDelete ? 'Confirm delete' : 'Delete'}
              </Button>
            ) : null}
            <Button
              disabled={
                busy ||
                !draft.name.trim() ||
                !draft.prompt.trim() ||
                (draft.triggerKind === 'schedule' && draft.type === 'once' && !draft.runAt) ||
                (draft.triggerKind === 'schedule' && draft.type === 'cron' && !draft.cron.trim()) ||
                (draft.triggerKind === 'event' &&
                  (!draft.connectorId ||
                    !/^D[A-Z0-9]+$/i.test(draft.channelId.trim()) ||
                    !Number.isFinite(draft.minimumWords) ||
                    draft.minimumWords < 0))
              }
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : editingId ? 'Save changes' : draft.triggerKind === 'event' ? 'Create trigger' : 'Schedule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ModelThinkingPicker
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        choices={modelChoices}
        value={{ provider: draft.provider, model: draft.model, effort: draft.effort }}
        defaultEffort={prefs?.defaultEffort ?? null}
        onChange={(choice) => setDraft((current) => ({ ...current, ...choice }))}
        title="Automation model"
      />

      <Dialog open={historyTask !== null} onOpenChange={(open) => !open && setHistoryTask(null)}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{historyTask?.name ?? 'Run history'}</DialogTitle>
            <DialogDescription>Every run stays here. Star a result to also surface it in Chats.</DialogDescription>
          </DialogHeader>
          {historyRuns === null ? (
            <p className="py-10 text-center text-muted-foreground">Loading…</p>
          ) : historyRuns.length === 0 ? (
            <p className="py-10 text-center text-muted-foreground">This automation has not run yet.</p>
          ) : (
            <div className="divide-y">
              {historyRuns.map((run) => (
                <div key={run.id} className="flex items-center gap-2 py-3">
                  <button
                    type="button"
                    disabled={!run.conversationId}
                    onClick={() => run.conversationId && onNavigate(`#/chat/${run.conversationId}?from=automations`)}
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                  >
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate font-medium">{exactTime(run.scheduledFor)}</span>
                      <span className={run.status === 'failed' || run.status === 'needs_you' ? 'text-amber-600' : 'text-muted-foreground'}>
                        {runLabel(run.status)}
                      </span>
                    </div>
                    {run.error ? <p className="mt-1 line-clamp-2 text-xs text-destructive">{run.error}</p> : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => historyTask && void toggleImportant(historyTask, run)}
                    className={`rounded-full p-2 ${run.important ? 'text-amber-600' : 'text-muted-foreground'}`}
                    aria-label={run.important ? 'Remove important mark' : 'Mark run important'}
                  >
                    <Star className={`size-4 ${run.important ? 'fill-current' : ''}`} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTask !== null} onOpenChange={(open) => !open && !busy && setDeleteTask(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTask?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its previous run chats will move to Archived chats.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (deleteTask) void removeTask(deleteTask);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
