import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, Check, Loader2, Pencil, Search, Trash2, X } from 'lucide-react';
import {
  api,
  type MemoryCaptureSettings,
  type MemoryItem,
  type MemoryProfile,
  type MemorySuggestion,
} from '../../lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsTabs } from './SettingsPrimitives';

function formatMemoryDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function provenance(memory: MemoryItem): string[] {
  const labels: string[] = [];
  if (typeof memory.metadata.project_id === 'string') labels.push('Project-scoped');
  if (typeof memory.metadata.conversation_id === 'string') labels.push('Saved from a chat');
  return labels;
}

/** Settings → Memory. Per-user durable context shared by every agent provider. */
export function MemoryPage({ onToast }: { onToast: (message: string) => void }) {
  const [profile, setProfile] = useState<MemoryProfile | null>(null);
  const [captureSettings, setCaptureSettings] = useState<MemoryCaptureSettings | null>(null);
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([]);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resolvingSuggestionId, setResolvingSuggestionId] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'suggestions' | 'saved'>(() => {
    const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab');
    return value === 'suggestions' || value === 'saved' ? value : 'overview';
  });
  const changeTab = useCallback((value: 'overview' | 'suggestions' | 'saved') => {
    setTab(value);
    const [path, queryString = ''] = window.location.hash.split('?');
    const params = new URLSearchParams(queryString);
    params.set('tab', value);
    window.history.replaceState(window.history.state, '', `${path}?${params.toString()}`);
  }, []);

  const loadProfile = useCallback(async () => {
    const result = await api.memoryProfile();
    setProfile(result.profile);
  }, []);

  useEffect(() => {
    let stopped = false;
    void Promise.all([api.memoryProfile(), api.memories(), api.memorySuggestions()])
      .then(([profileResult, memoryResult, suggestionResult]) => {
        if (stopped) return;
        setProfile(profileResult.profile);
        setMemories(memoryResult.memories);
        setSuggestions(suggestionResult.suggestions);
      })
      .catch((error: Error) => {
        if (!stopped) setLoadError(error.message);
      });
    void api.memoryCaptureSettings()
      .then((captureResult) => {
        if (!stopped) setCaptureSettings(captureResult.settings);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, []);

  const setCaptureEnabled = useCallback(async (enabled: boolean) => {
    const previous = captureSettings;
    setCaptureSettings({ enabled, processor: 'Codex 5.6 Luna' });
    try {
      const result = await api.updateMemoryCaptureSettings(enabled);
      setCaptureSettings(result.settings);
      onToast(enabled ? 'Conversation learning enabled.' : 'Conversation learning disabled.');
    } catch (error) {
      setCaptureSettings(previous);
      onToast((error as Error).message);
    }
  }, [captureSettings, onToast]);

  const profileFacts = useMemo(() => {
    const facts = [...(profile?.static ?? []), ...(profile?.dynamic ?? [])];
    return [...new Set(facts.map((fact) => fact.trim()).filter(Boolean))];
  }, [profile]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleMemories = useMemo(() => {
    if (memories === null || !normalizedQuery) return memories;
    return memories.filter((memory) => memory.content.toLocaleLowerCase().includes(normalizedQuery));
  }, [memories, normalizedQuery]);

  const beginEdit = useCallback((memory: MemoryItem) => {
    setEditingId(memory.id);
    setDraft(memory.content);
  }, []);

  const saveEdit = useCallback(async (id: string) => {
    const content = draft.trim();
    if (!content) return;
    setSavingId(id);
    try {
      const result = await api.updateMemory(id, content);
      setMemories((current) => current?.map((memory) => (memory.id === id ? result.memory : memory)) ?? null);
      setEditingId(null);
      setDraft('');
      onToast('Memory updated.');
      void loadProfile().catch(() => undefined);
    } catch (error) {
      onToast((error as Error).message);
    } finally {
      setSavingId(null);
    }
  }, [draft, loadProfile, onToast]);

  const forget = useCallback(async (memory: MemoryItem) => {
    if (!window.confirm('Forget this memory? This cannot be undone.')) return;
    setDeletingId(memory.id);
    try {
      await api.deleteMemory(memory.id);
      setMemories((current) => current?.filter((item) => item.id !== memory.id) ?? null);
      if (editingId === memory.id) {
        setEditingId(null);
        setDraft('');
      }
      onToast('Memory forgotten.');
      void loadProfile().catch(() => undefined);
    } catch (error) {
      onToast((error as Error).message);
    } finally {
      setDeletingId(null);
    }
  }, [editingId, loadProfile, onToast]);

  const resolveSuggestion = useCallback(async (suggestion: MemorySuggestion, approve: boolean) => {
    setResolvingSuggestionId(suggestion.id);
    try {
      if (approve) {
        const result = await api.approveMemorySuggestion(suggestion.id);
        setMemories((current) => current ? [result.memory, ...current] : [result.memory]);
        void loadProfile().catch(() => undefined);
      } else {
        await api.dismissMemorySuggestion(suggestion.id);
      }
      setSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
      onToast(approve ? 'Memory approved.' : 'Suggestion dismissed.');
    } catch (error) {
      onToast((error as Error).message);
    } finally {
      setResolvingSuggestionId(null);
    }
  }, [loadProfile, onToast]);

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-sm text-muted-foreground">
        Veneer quietly finds durable facts and preferences in your conversations, then shares only the
        relevant ones across Claude, Codex, and OpenRouter chats.
      </p>

      {loadError ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{loadError}</div>
      ) : null}

      <SettingsTabs
        value={tab}
        onChange={changeTab}
        label="Memory sections"
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'suggestions', label: 'Suggestions', count: suggestions.length },
          { value: 'saved', label: 'Saved memories', count: memories?.length },
        ]}
      />

      {tab === 'overview' ? <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Learn from conversations</CardTitle>
          <CardDescription>
            Automatically turn completed chats into useful memories for later conversations.
          </CardDescription>
          <CardAction>
            <Switch
              checked={captureSettings?.enabled ?? false}
              disabled={!captureSettings}
              aria-label="Toggle conversation learning"
              onCheckedChange={() => void setCaptureEnabled(!(captureSettings?.enabled ?? false))}
            />
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Codex 5.6 Luna reviews completed turns. Clear, user-supported memories are saved automatically;
            uncertain ones wait for your review. System prompts, tool output, credentials, and financial identifiers
            are excluded.
          </p>
        </CardContent>
      </Card> : null}

      {tab === 'suggestions' ? suggestions.length ? (
        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Suggested memories</CardTitle>
            <CardDescription>These may be useful, but were not safe or reusable enough to save silently.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {suggestions.map((suggestion) => (
              <Card key={suggestion.id} size="sm" className="bg-background/50">
                <CardHeader>
                  <CardTitle className="font-sans text-sm font-medium capitalize">
                    {suggestion.scope} · {suggestion.kind}
                  </CardTitle>
                  <CardAction className="flex gap-1">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Approve suggested memory"
                      disabled={resolvingSuggestionId === suggestion.id}
                      onClick={() => void resolveSuggestion(suggestion, true)}
                    >
                      {resolvingSuggestionId === suggestion.id
                        ? <Loader2 className="size-4 animate-spin" />
                        : <Check className="size-4 text-emerald-600" />}
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Dismiss suggested memory"
                      disabled={resolvingSuggestionId === suggestion.id}
                      onClick={() => void resolveSuggestion(suggestion, false)}
                    >
                      <X className="size-4" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-relaxed">{suggestion.content}</p>
                  <p className="mt-2 text-xs text-muted-foreground">From: “{suggestion.evidence}”</p>
                </CardContent>
              </Card>
            ))}
          </CardContent>
        </Card>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No memory suggestions need review.
        </p>
      ) : null}

      {tab === 'overview' ? <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <Brain className="size-5 text-brand" /> Memory profile
          </CardTitle>
          <CardDescription>A compact summary agents can use at the start of a turn.</CardDescription>
        </CardHeader>
        <CardContent>
          {memories === null && !loadError ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : profileFacts.length ? (
            <ul className="space-y-2 text-sm">
              {profileFacts.slice(0, 8).map((fact) => (
                <li key={fact} className="flex gap-2">
                  <span aria-hidden="true" className="text-brand">•</span>
                  <span>{fact}</span>
                </li>
              ))}
              {profileFacts.length > 8 ? (
                <li className="text-xs text-muted-foreground">+{profileFacts.length - 8} more profile facts</li>
              ) : null}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No profile yet. It will take shape as Veneer finds durable memories.
            </p>
          )}
        </CardContent>
      </Card> : null}

      {tab === 'saved' ? <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Saved memories</CardTitle>
          <CardDescription>Search, edit, or forget the facts available to your agents.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search memories"
              aria-label="Search memories"
              aria-controls="saved-memory-list"
              aria-describedby="saved-memory-count"
              className="h-10 rounded-xl pr-10 pl-9 text-base [&::-webkit-search-cancel-button]:appearance-none md:text-sm"
            />
            {query ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Clear memory search"
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
                onClick={() => setQuery('')}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>

          {memories !== null && visibleMemories !== null ? (
            <>
              <p
                id="saved-memory-count"
                aria-live="polite"
                className="mt-2 px-1 text-xs text-muted-foreground"
              >
                {normalizedQuery
                  ? `${visibleMemories.length} of ${memories.length} matching`
                  : `${memories.length} saved ${memories.length === 1 ? 'memory' : 'memories'}`}
              </p>
              <div
                id="saved-memory-list"
                role="region"
                aria-label="Saved memory results"
                tabIndex={visibleMemories.length ? 0 : undefined}
                className="mt-3 max-h-[min(60vh,32rem)] overflow-y-auto overscroll-contain rounded-xl border bg-muted/20 p-2 outline-none [scrollbar-gutter:stable] focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <div className="flex flex-col gap-2">
                  {visibleMemories.length ? visibleMemories.map((memory) => {
                    const labels = provenance(memory);
                    const date = formatMemoryDate(memory.updatedAt ?? memory.createdAt);
                    const editing = editingId === memory.id;
                    return (
                      <Card key={memory.id} size="sm" className="gap-1.5 bg-background/70 py-2.5">
                        <CardHeader className="px-3">
                          <CardDescription className="pr-16 text-xs leading-tight">
                            {[date ? `Updated ${date}` : null, ...labels].filter(Boolean).join(' · ')
                              || 'Durable memory'}
                          </CardDescription>
                          <CardAction className="flex gap-0.5">
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Edit memory"
                              onClick={() => beginEdit(memory)}
                              disabled={deletingId === memory.id}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Forget memory"
                              onClick={() => void forget(memory)}
                              disabled={deletingId === memory.id}
                            >
                              {deletingId === memory.id ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Trash2 className="size-4 text-destructive" />
                              )}
                            </Button>
                          </CardAction>
                        </CardHeader>
                        <CardContent className="px-3">
                          {editing ? (
                            <div className="flex flex-col gap-2">
                              <textarea
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                maxLength={10_000}
                                rows={3}
                                aria-label="Memory content"
                                className="w-full resize-y rounded-lg border bg-card px-3 py-2 text-base outline-none focus:border-ring md:text-sm"
                              />
                              <div className="flex justify-end gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setEditingId(null);
                                    setDraft('');
                                  }}
                                >
                                  <X className="size-4" /> Cancel
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => void saveEdit(memory.id)}
                                  disabled={!draft.trim() || savingId === memory.id}
                                >
                                  {savingId === memory.id ? <Loader2 className="size-4 animate-spin" /> : null}
                                  Save
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap break-words text-sm leading-snug">{memory.content}</p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  }) : (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {normalizedQuery ? 'No matching memories.' : 'No memories saved yet.'}
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card> : null}
    </div>
  );
}
