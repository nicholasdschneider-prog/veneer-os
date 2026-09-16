import { useCallback, useEffect, useState } from 'react';
import { api, type ChatAutoArchiveSettings, type TodoPlanningSettings } from '../../lib/api';
import { DEFAULT_TODO_PLANNING_PROMPT } from '../../lib/todoChatPrompt';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ChatsPage({ onToast }: { onToast: (message: string) => void }) {
  const [settings, setSettings] = useState<ChatAutoArchiveSettings | null>(null);
  const [daysDraft, setDaysDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stopped = false;
    void api
      .chatAutoArchiveSettings()
      .then((archiveResult) => {
        if (stopped) return;
        setSettings(archiveResult.settings);
        setDaysDraft(String(archiveResult.settings.inactivityDays));
      })
      .catch((loadError: Error) => {
        if (!stopped) setError(loadError.message);
      });
    return () => {
      stopped = true;
    };
  }, []);

  const save = useCallback(
    async (next: ChatAutoArchiveSettings) => {
      if (!settings || saving) return;
      const previous = settings;
      setSettings(next);
      setDaysDraft(String(next.inactivityDays));
      setSaving(true);
      setError(null);
      try {
        const result = await api.updateChatAutoArchiveSettings(next);
        setSettings(result.settings);
        setDaysDraft(String(result.settings.inactivityDays));
        onToast(
          result.archivedCount > 0
            ? `${result.archivedCount} inactive ${result.archivedCount === 1 ? 'chat was' : 'chats were'} archived.`
            : 'Chat archive settings updated.',
        );
      } catch (saveError) {
        setSettings(previous);
        setDaysDraft(String(previous.inactivityDays));
        setError((saveError as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [onToast, saving, settings],
  );

  const commitDays = useCallback(() => {
    if (!settings || saving) return;
    const days = Number(daysDraft);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      setDaysDraft(String(settings.inactivityDays));
      setError('Choose a whole number from 1 to 3650 days.');
      return;
    }
    if (days === settings.inactivityDays) return;
    void save({ ...settings, inactivityDays: days });
  }, [daysDraft, save, saving, settings]);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Auto-archive chats</CardTitle>
          <CardDescription>
            Keep Chats tidy by moving inactive conversations to Archive automatically.
          </CardDescription>
          <CardAction>
            <Switch
              checked={settings?.enabled ?? false}
              disabled={!settings || saving}
              aria-label="Toggle automatic chat archiving"
              onCheckedChange={() => {
                if (settings) void save({ ...settings, enabled: !settings.enabled });
              }}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="text-sm">
          {!settings ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <label className="block">
                <span className="font-medium">Archive after</span>
                <div className="mt-1.5 flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    value={daysDraft}
                    disabled={!settings.enabled || saving}
                    onChange={(event) => setDaysDraft(event.target.value)}
                    onBlur={commitDays}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    className="h-11 w-28 rounded-xl px-3 text-base md:text-base"
                    aria-label="Days before a chat is automatically archived"
                  />
                  <span className="text-muted-foreground">days of inactivity</span>
                </div>
              </label>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Opening a chat or sending it a new prompt resets the timer. Pinned chats are always kept, and you can
                restore anything from Archive later.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function TodoPlanningPromptSettings({ onToast }: { onToast: (message: string) => void }) {
  const [settings, setSettings] = useState<TodoPlanningSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stopped = false;
    void api
      .todoPlanningSettings()
      .then((result) => {
        if (stopped) return;
        setSettings(result.settings);
        setDraft(result.settings.prompt);
      })
      .catch((loadError: Error) => {
        if (!stopped) setError(loadError.message);
      });
    return () => {
      stopped = true;
    };
  }, []);

  const save = useCallback(async () => {
    if (!settings || saving || !draft.trim() || draft === settings.prompt) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateTodoPlanningSettings({ prompt: draft });
      setSettings(result.settings);
      setDraft(result.settings.prompt);
      onToast('To-do planning prompt updated.');
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, onToast, saving, settings]);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">To-do planning prompt</CardTitle>
          <CardDescription>
            Added after your first message when you start a new chat from a to-do. It applies only to that first turn.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {!settings ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <textarea
                name="todo-planning-prompt"
                value={draft}
                maxLength={50_000}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-72 w-full resize-y rounded-xl border bg-card px-3 py-2 font-mono text-base/7 outline-none focus:border-ring sm:text-sm/6"
                aria-label="To-do planning prompt"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {draft.length.toLocaleString()} / 50,000
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={saving || draft === DEFAULT_TODO_PLANNING_PROMPT}
                    onPointerUp={() => setDraft(DEFAULT_TODO_PLANNING_PROMPT)}
                    className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    Reset to default
                  </button>
                  <button
                    type="button"
                    disabled={
                      saving ||
                      !draft.trim() ||
                      draft === settings.prompt
                    }
                    onPointerUp={() => void save()}
                    className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground transition-opacity disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save prompt'}
                  </button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
