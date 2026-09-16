import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Star, Trash2 } from 'lucide-react';
import {
  api,
  type AgentDefault,
  type AssistantType,
  type ModelOption,
  type ModelPrefs,
  type FileLockConfig,
} from '../../lib/api';
import { effortOptionsFor, isProvider, modelKey, orderModels, PROVIDERS, providerLabel, type Provider } from '../../lib/modelLabel';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ApprovalMode } from '../../lib/types';
import { resolveEffectiveApprovalMode } from '../../lib/approvalMode';

const APPROVAL_MODE_OPTIONS = [
  { value: 'ask', label: 'Ask first' },
  { value: 'auto', label: 'Autonomous' },
] as const;

export function AgentsPage() {
  // Model preferences resolve each agent's explicit model/thinking choice or
  // its inherited default from Settings → Providers & models.
  const [prefs, setPrefs] = useState<ModelPrefs | null>(null);
  const [models, setModels] = useState<Record<Provider, ModelOption[]> | null>(null);
  const [assistants, setAssistants] = useState<AssistantType[] | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<AssistantType | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    void Promise.all([
      api.modelPrefs().then((r) => r.prefs),
      api.models('claude').then((r) => r.models).catch(() => []),
      api.models('openrouter').then((r) => r.models).catch(() => []),
      api.models('codex').then((r) => r.models).catch(() => []),
      api.models('grok').then((r) => r.models).catch(() => []),
      api.assistants().then((r) => r.assistants).catch(() => [] as AssistantType[]),
    ])
      .then(([p, claude, openrouter, codex, grok, agents]) => {
        if (stop) return;
        setPrefs(p);
        setModels({ claude, openrouter, codex, grok });
        setAssistants(agents);
      })
      .catch((err: Error) => setPrefsError(err.message));
    return () => {
      stop = true;
    };
  }, []);

  const savePrefs = useCallback((next: ModelPrefs) => {
    setPrefs(next); // optimistic; the server response reconciles
    setPrefsError(null);
    void api
      .updateModelPrefs(next)
      .then((r) => setPrefs(r.prefs))
      .catch((err: Error) => setPrefsError(err.message));
  }, []);

  const setDefaultAgent = useCallback(
    (slug: string) => {
      if (!prefs) return;
      savePrefs({ ...prefs, defaultAgent: slug });
    },
    [prefs, savePrefs],
  );

  const renameAgent = useCallback((slug: string, name: string) => {
    // Optimistic: reflect the new name immediately, reconcile with the server.
    setAssistants((prev) => (prev ? prev.map((a) => (a.slug === slug ? { ...a, name } : a)) : prev));
    setPrefsError(null);
    void api
      .updateAssistant(slug, { name })
      .then((r) =>
        setAssistants((prev) => (prev ? prev.map((a) => (a.slug === slug ? r.assistant : a)) : prev)),
      )
      .catch((err: Error) => setPrefsError(err.message));
  }, []);

  const updateAgentInstructions = useCallback(async (slug: string, instructions: string) => {
    setPrefsError(null);
    try {
      const { assistant } = await api.updateAssistant(slug, { instructions });
      setAssistants((prev) => (prev ? prev.map((a) => (a.slug === slug ? assistant : a)) : prev));
    } catch (err) {
      setPrefsError((err as Error).message);
      throw err;
    }
  }, []);

  const updateAgentApprovalMode = useCallback((slug: string, approvalMode: ApprovalMode) => {
    const previousMode = assistants?.find((a) => a.slug === slug)?.approval_mode;
    if (!previousMode || previousMode === approvalMode) return;
    setAssistants((prev) => (prev ? prev.map((a) => (a.slug === slug ? { ...a, approval_mode: approvalMode } : a)) : prev));
    setPrefsError(null);
    void api
      .updateAssistant(slug, { approval_mode: approvalMode })
      .then((r) =>
        setAssistants((prev) => (prev ? prev.map((a) => (a.slug === slug ? r.assistant : a)) : prev)),
      )
      .catch((err: Error) => {
        setAssistants((prev) =>
          prev
            ? prev.map((a) =>
                a.slug === slug && a.approval_mode === approvalMode ? { ...a, approval_mode: previousMode } : a,
              )
            : prev,
        );
        setPrefsError(err.message);
      });
  }, [assistants]);

  const updateAgentFullAccess = useCallback((slug: string, fullAccess: boolean) => {
    const previous = assistants?.find((a) => a.slug === slug)?.full_access;
    if (previous === undefined || previous === fullAccess) return;
    setAssistants((current) =>
      current ? current.map((agent) => (agent.slug === slug ? { ...agent, full_access: fullAccess } : agent)) : current,
    );
    setPrefsError(null);
    void api
      .updateAssistant(slug, { full_access: fullAccess })
      .then(({ assistant }) =>
        setAssistants((current) =>
          current ? current.map((agent) => (agent.slug === slug ? assistant : agent)) : current,
        ),
      )
      .catch((err: Error) => {
        setAssistants((current) =>
          current
            ? current.map((agent) =>
                agent.slug === slug && agent.full_access === fullAccess
                  ? { ...agent, full_access: previous }
                  : agent,
              )
            : current,
        );
        setPrefsError(err.message);
      });
  }, [assistants]);

  const setAgentPref = useCallback(
    (slug: string, patch: Partial<AgentDefault>) => {
      if (!prefs) return;
      const current = prefs.agents[slug] ?? { provider: null, model: null, effort: null };
      savePrefs({ ...prefs, agents: { ...prefs.agents, [slug]: { ...current, ...patch } } });
    },
    [prefs, savePrefs],
  );

  const deleteAgent = useCallback(async () => {
    if (!deletingAgent || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    setPrefsError(null);
    try {
      const result = await api.deleteAssistant(deletingAgent.slug);
      setAssistants((prev) => (prev ? prev.filter((agent) => agent.slug !== deletingAgent.slug) : prev));
      setPrefs(result.prefs);
      setDeletingAgent(null);
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deletingAgent]);

  return (
    <div className="flex flex-col gap-4">
      {prefsError ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{prefsError}</div>
      ) : null}

      <AgentsCard
        assistants={assistants}
        prefs={prefs}
        models={models}
        onDefaultAgent={setDefaultAgent}
        onAgentPref={setAgentPref}
        onRename={renameAgent}
        onUpdateInstructions={updateAgentInstructions}
        onApprovalMode={updateAgentApprovalMode}
        onFullAccess={updateAgentFullAccess}
        selectedSlug={selectedAgentSlug}
        onSelect={setSelectedAgentSlug}
        onCreate={() => setCreatingAgent(true)}
        onDelete={(agent) => {
          setDeleteError(null);
          setDeletingAgent(agent);
        }}
      />

      <NewAgentDialog
        open={creatingAgent}
        onOpenChange={setCreatingAgent}
        onCreated={(agent) => {
          setAssistants((current) => (current ? [...current, agent] : [agent]));
          setSelectedAgentSlug(agent.slug);
          setCreatingAgent(false);
        }}
      />

      <AlertDialog
        open={deletingAgent !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) {
            setDeletingAgent(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deletingAgent?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the agent from settings and new chats. Existing chats keep their history and agent name.
              Project defaults and future automation runs move to another available agent. You cannot delete an agent
              while it is working or waiting for you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <p role="alert" className="text-sm text-destructive">{deleteError}</p> : null}
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="h-11 flex-1 rounded-xl" disabled={deleteBusy}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 flex-1 rounded-xl"
              disabled={deleteBusy}
              onClick={(event) => {
                event.preventDefault();
                void deleteAgent();
              }}
            >
              {deleteBusy ? 'Deleting…' : 'Delete agent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Union of every provider's thinking vocabulary; the picker only applies the
// default where the chosen model supports it (see Chat.tsx). 'ultra' arrived
// with GPT-5.6 Sol/Terra.
const ALL_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Thinking vocabulary for an agent's picked provider+model: the model's own
// reported set when known (per-model since GPT-5.6), else the provider
// fallback, else the cross-provider union. model '' = the provider's default
// model (the Settings star, else the one the CLI flags as default).
function effortVocabFor(
  models: Record<Provider, ModelOption[]>,
  prefs: ModelPrefs,
  provider: string | null | undefined,
  model: string | null | undefined,
): string[] {
  if (!provider || !isProvider(provider)) return ALL_EFFORTS;
  const list = models[provider];
  const resolved = model
    ? list.find((m) => m.id === model)
    : (prefs.providerDefaults[provider] ? list.find((m) => m.id === prefs.providerDefaults[provider]) : list.find((m) => m.isDefault));
  return effortOptionsFor(provider, resolved?.efforts);
}

// Flat provider+model list for an agent's model dropdown; model '' = that
// provider's default (the server resolves it to the starred model). Mirrors
// Chat.tsx's buildModelChoices, minus the not-connected Claude aliases.
function buildAgentChoices(
  models: Record<Provider, ModelOption[]>,
  prefs: ModelPrefs,
): { provider: Provider; model: string; label: string }[] {
  const choices: { provider: Provider; model: string; label: string }[] = [];
  for (const p of PROVIDERS) {
    const defId = prefs.providerDefaults[p];
    const defLabel = defId ? (models[p].find((m) => m.id === defId)?.label ?? defId) : null;
    choices.push({
      provider: p,
      model: '',
      label: `${providerLabel(p)} · ${defLabel ? `Default (${defLabel})` : 'Default'}`,
    });
    for (const m of orderModels(p, models[p], prefs.modelOrder).filter((m) => !prefs.hiddenModels.includes(modelKey(p, m.id)))) {
      choices.push({ provider: p, model: m.id, label: `${providerLabel(p)} · ${m.label}` });
    }
  }
  return choices;
}

/**
 * Agents card: elevates each assistant (Assistant, Platform Dev, …) to a
 * first-class agent. The star picks which one new chats open on; each gets its
 * own default model + thinking, or "Inherit default" to fall back to the New
 * chat defaults in Accounts. Every change saves immediately (PUT /api/model-prefs).
 */
function AgentsCard({
  assistants,
  prefs,
  models,
  onDefaultAgent,
  onAgentPref,
  onRename,
  onUpdateInstructions,
  onApprovalMode,
  onFullAccess,
  selectedSlug,
  onSelect,
  onCreate,
  onDelete,
}: {
  assistants: AssistantType[] | null;
  prefs: ModelPrefs | null;
  models: Record<Provider, ModelOption[]> | null;
  onDefaultAgent: (slug: string) => void;
  onAgentPref: (slug: string, patch: Partial<AgentDefault>) => void;
  onRename: (slug: string, name: string) => void;
  onUpdateInstructions: (slug: string, instructions: string) => Promise<void>;
  onApprovalMode: (slug: string, approvalMode: ApprovalMode) => void;
  onFullAccess: (slug: string, fullAccess: boolean) => void;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onCreate: () => void;
  onDelete: (agent: AssistantType) => void;
}) {
  const choices = models && prefs ? buildAgentChoices(models, prefs) : [];
  // Which agent is the effective default: the saved pick, else the built-in one.
  const defaultSlug = prefs?.defaultAgent ?? assistants?.find((a) => a.isDefault)?.slug ?? null;
  const activeSlug =
    selectedSlug && assistants?.some((agent) => agent.slug === selectedSlug)
      ? selectedSlug
      : defaultSlug ?? assistants?.[0]?.slug ?? null;
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Agents</CardTitle>
        <CardDescription>
          Choose the default agent, its model, thinking, approvals, and the custom instructions that shape how it works.
        </CardDescription>
        <CardAction>
          <Button size="sm" className="rounded-xl" onClick={onCreate}>
            <Plus className="size-4" /> New agent
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {!assistants || !prefs || !models ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Choose an agent to edit">
              {assistants.map((agent) => (
                <button
                  key={agent.slug}
                  type="button"
                  role="tab"
                  aria-selected={activeSlug === agent.slug}
                  onClick={() => onSelect(agent.slug)}
                  className={`shrink-0 rounded-xl border px-3 py-2 text-left transition-colors ${
                    activeSlug === agent.slug ? 'border-brand bg-accent' : 'hover:bg-muted/50'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {agent.name}
                    {defaultSlug === agent.slug ? <Star className="size-3 fill-brand text-brand" /> : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {agent.adminOnly ? 'Admins' : 'Everyone'}
                  </span>
                </button>
              ))}
            </div>
            {assistants.filter((agent) => agent.slug === activeSlug).map((a) => {
              const isDefault = defaultSlug === a.slug;
              const ov = prefs.agents[a.slug];
              const modelValue = !ov || ov.provider == null ? 'inherit' : `${ov.provider}|${ov.model ?? ''}`;
              const effortVocab = ov?.provider ? effortVocabFor(models, prefs, ov.provider, ov.model) : ALL_EFFORTS;
              const effortValue = ov?.effort ?? 'inherit';
              const effectiveApprovalMode = resolveEffectiveApprovalMode(a.full_access, null, a.approval_mode);
              return (
                <div key={a.slug} className="rounded-xl border p-3">
                  <div className="mb-2.5 flex items-center gap-2">
                    <button
                      type="button"
                      onPointerUp={() => onDefaultAgent(a.slug)}
                      aria-pressed={isDefault}
                      aria-label={isDefault ? `${a.name} is the default agent` : `Make ${a.name} the default agent`}
                      className="shrink-0"
                    >
                      <Star
                        className={`size-4 shrink-0 ${isDefault ? 'fill-brand text-brand' : 'text-muted-foreground/40'}`}
                      />
                    </button>
                    <AgentNameEditor name={a.name} onRename={(name) => onRename(a.slug, name)} />
                    {isDefault ? <span className="shrink-0 text-xs font-medium text-brand">Default</span> : null}
                    {a.adminOnly ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Admins</span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Delete ${a.name}`}
                      onPointerUp={() => onDelete(a)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2 pl-6">
                    <label className="flex items-center justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">Model</span>
                      <select
                        value={modelValue}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === 'inherit') {
                            onAgentPref(a.slug, { provider: null, model: null });
                            return;
                          }
                          const sep = v.indexOf('|');
                          const provider = v.slice(0, sep);
                          const model = v.slice(sep + 1) || null;
                          // Keep the thinking level only if the new model supports it.
                          const cur = ov?.effort ?? null;
                          const vocab = effortVocabFor(models, prefs, provider, model);
                          const effort = cur && vocab.includes(cur) ? cur : null;
                          onAgentPref(a.slug, { provider, model, effort });
                        }}
                        className="min-w-0 rounded-xl border bg-card px-3 py-2 outline-none focus:border-ring"
                      >
                        <option value="inherit">Inherit default</option>
                        {choices.map((c) => (
                          <option key={`${c.provider}|${c.model}`} value={`${c.provider}|${c.model}`}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">Thinking</span>
                      <select
                        value={effortValue}
                        onChange={(e) =>
                          onAgentPref(a.slug, { effort: e.target.value === 'inherit' ? null : e.target.value })
                        }
                        className="rounded-xl border bg-card px-3 py-2 outline-none focus:border-ring"
                      >
                        <option value="inherit">Inherit default</option>
                        {effortVocab.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {lvl[0]!.toUpperCase() + lvl.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {a.slug !== 'platform-dev' ? (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="shrink-0 text-muted-foreground">Approvals</span>
                          <div
                            className="inline-flex rounded-xl border bg-muted/40 p-0.5"
                            role="group"
                            aria-label={`${a.name} approvals`}
                          >
                            {APPROVAL_MODE_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                onPointerUp={() => onApprovalMode(a.slug, option.value)}
                                aria-pressed={effectiveApprovalMode === option.value}
                                disabled={a.full_access}
                                className={`rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors ${
                                  effectiveApprovalMode === option.value
                                    ? 'bg-card text-foreground shadow-sm ring-1 ring-foreground/10'
                                    : 'text-muted-foreground'
                                } disabled:cursor-not-allowed disabled:opacity-50`}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        {a.full_access ? (
                          <p className="text-xs text-muted-foreground">
                            Full Access bypasses approval settings.
                          </p>
                        ) : a.approval_mode === 'auto' ? (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            Runs tools — including connectors like Gmail and Shopify — without asking first. Deny rules
                            still apply.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="flex flex-col gap-1.5 border-t pt-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <span className="font-medium text-foreground">Full access</span>
                          <span className="ml-2 text-xs font-medium text-destructive">Dangerous</span>
                        </div>
                        <Switch
                          checked={a.full_access}
                          aria-label={`${a.name} full access`}
                          onCheckedChange={() => onFullAccess(a.slug, !a.full_access)}
                        />
                      </div>
                      <p className={`text-xs leading-5 ${a.full_access ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
                        Bypasses permission prompts and the provider sandbox. This agent can read, change, or delete
                        anything the Veneer service account can access.
                      </p>
                    </div>
                    <AgentInstructionsEditor
                      agentSlug={a.slug}
                      agentName={a.name}
                      instructions={a.instructions}
                      onSave={(instructions) => onUpdateInstructions(a.slug, instructions)}
                    />
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              “Inherit default” uses the new chat defaults under Providers & models.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NewAgentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: AssistantType) => void;
}) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setInstructions('');
    setBusy(false);
    setError(null);
  }, [open]);

  const create = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { assistant } = await api.createAssistant({
        name: trimmedName,
        instructions: instructions.trim() || undefined,
      });
      onCreated(assistant);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Create an agent for regular chats. You can choose its model, permissions, and defaults after creation.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">Name</span>
            <input
              autoFocus
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void create();
                }
              }}
              placeholder="e.g. Marketing Writer"
              className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">
              Instructions <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <textarea
              value={instructions}
              maxLength={50_000}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="What this agent does and how it should work…"
              rows={5}
              className="resize-y rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
            />
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            className="h-11 flex-1 rounded-xl"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            className="h-11 flex-1 rounded-xl"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Explicit editor for the standing prompt. Large prompts should never save on
 * blur: Save/Cancel prevents an accidental click from replacing an agent's
 * entire persona, while the collapsed preview keeps the Agents page compact.
 */
function AgentInstructionsEditor({
  agentSlug,
  agentName,
  instructions,
  onSave,
}: {
  agentSlug: string;
  agentName: string;
  instructions: string;
  onSave: (instructions: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(instructions);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(instructions);
  }, [instructions, editing]);

  if (!editing) {
    return (
      <div className="mt-1 border-t pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-foreground">Instructions</p>
            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {instructions.trim() || 'No custom instructions. This agent uses the standard platform guidance.'}
            </p>
          </div>
          <button
            type="button"
            onPointerUp={() => {
              setDraft(instructions);
              setEditing(true);
            }}
            className="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            Edit
          </button>
        </div>
      </div>
    );
  }

  const save = async () => {
    if (saving || draft === instructions) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      // The parent surfaces the API error above the card. Keep the draft open
      // so the user can retry without losing a long prompt.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1 border-t pt-3">
      <label className="font-medium text-foreground" htmlFor={`agent-instructions-${agentSlug}`}>
        Instructions
      </label>
      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
        Saved in each new chat's fixed context. Existing chats keep the snapshot they started with.
      </p>
      <textarea
        id={`agent-instructions-${agentSlug}`}
        autoFocus
        value={draft}
        maxLength={50_000}
        onChange={(event) => setDraft(event.target.value)}
        className="mt-2 min-h-64 w-full resize-y rounded-xl border bg-card px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-ring"
        aria-label={`${agentName} instructions`}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs tabular-nums text-muted-foreground">{draft.length.toLocaleString()} / 50,000</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving}
            onPointerUp={() => {
              setDraft(instructions);
              setEditing(false);
            }}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || draft === instructions}
            onPointerUp={() => void save()}
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground transition-opacity disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save instructions'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline editor for an agent's display name. Shows the name with a pencil
 * affordance; clicking it swaps to a text field that commits on Enter or blur
 * and cancels on Escape. Empty or unchanged input is discarded.
 */
function AgentNameEditor({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // Keep the draft in sync when the saved name changes under us (e.g. the
  // optimistic update reconciles with the server response).
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  if (!editing) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
        <button
          type="button"
          aria-label={`Rename ${name}`}
          onPointerUp={() => {
            setDraft(name);
            setEditing(true);
          }}
          className="shrink-0 text-muted-foreground/50 transition-colors hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </button>
      </span>
    );
  }

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== name) onRename(next);
  };
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setDraft(name);
          setEditing(false);
        }
      }}
      className="min-w-0 flex-1 rounded-lg border bg-card px-2 py-1 font-medium text-foreground outline-none focus:border-ring"
    />
  );
}

/**
 * Concurrent-editing file locks. Toggles/tunes the coordination the PreToolUse
 * hook enforces so multiple agents can share one checkout without git worktrees.
 * State lives in .claude/filelock.config.json (the hook reads it live), which the
 * server reads/writes for this card. Off/on takes effect immediately for all agents.
 */
export function FileLockSettings() {
  const [config, setConfig] = useState<FileLockConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    void api
      .fileLock()
      .then((result) => {
        if (!stopped) setConfig(result.config);
      })
      .catch((reason: Error) => {
        if (!stopped) setError(reason.message);
      });
    return () => {
      stopped = true;
    };
  }, []);

  const save = useCallback((next: FileLockConfig) => {
    setConfig(next);
    setError(null);
    void api
      .updateFileLock(next)
      .then((result) => setConfig(result.config))
      .catch((reason: Error) => setError(reason.message));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {error ? <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      <FileLockCard config={config} onChange={save} />
    </div>
  );
}

function FileLockCard({
  config,
  onChange,
}: {
  config: FileLockConfig | null;
  onChange: (next: FileLockConfig) => void;
}) {
  const ttlChoices = config
    ? [...new Set([30, 60, 90, 180, 300, config.ttlSeconds])].sort((a, b) => a - b)
    : [];
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Concurrent editing</CardTitle>
        <CardDescription>
          Blocks edits to a file another agent is actively editing, so agents can share this checkout without git
          worktrees.
        </CardDescription>
        <CardAction>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
              config?.enabled ? 'bg-accent text-brand' : 'bg-muted text-muted-foreground'
            }`}
          >
            {!config ? '…' : config.enabled ? 'On' : 'Off'}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {!config ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <>
            <label className="flex items-center justify-between gap-3">
              <span className="font-medium">File-edit locks</span>
              <Switch
                checked={config.enabled}
                aria-label="Toggle file-edit locks"
                onCheckedChange={() => onChange({ ...config, enabled: !config.enabled })}
              />
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Takes effect immediately for every agent. A blocked agent is told to edit a different file and retry —
              it never blocks different files or an agent's own re-edits.
            </p>

            {config.enabled ? (
              <>
                <label className="mt-4 flex items-center justify-between gap-3">
                  <span className="font-medium">Lock timeout</span>
                  <select
                    value={config.ttlSeconds}
                    onChange={(e) => onChange({ ...config, ttlSeconds: Number(e.target.value) })}
                    className="rounded-xl border bg-card px-3 py-2 outline-none focus:border-ring"
                  >
                    {ttlChoices.map((s) => (
                      <option key={s} value={s}>
                        {s}s
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mt-2 text-xs text-muted-foreground">
                  How long a lock survives with no edits before another agent may take over. Lower it if agents wait
                  too long; raise it if long edits to one file get interrupted.
                </p>
              </>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
