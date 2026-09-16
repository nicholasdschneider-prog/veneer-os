import { useCallback, useEffect, useRef, useState } from 'react';
import { Braces, Check, Copy, RefreshCw, RotateCcw } from 'lucide-react';
import { api, type ConversationDebugContext } from '../../lib/api';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { DropdownMenuItem } from '../ui/dropdown-menu';

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-xs text-foreground" title={value ?? '—'}>
        {value || '—'}
      </dd>
    </div>
  );
}

function TagList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <code key={value} className="rounded-md bg-muted px-1.5 py-1 text-[11px] text-foreground">
          {value}
        </code>
      ))}
    </div>
  );
}

function InstructionBlock({
  title,
  role,
  version,
  content,
  status,
}: {
  title: string;
  role: string;
  version: string;
  content: string;
  status: string;
}) {
  return (
    <details className="rounded-lg border p-3 text-xs">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{title}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{role}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{version}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">{status}</span>
        </div>
      </summary>
      <pre className="mt-3 max-h-[38vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {content}
      </pre>
    </details>
  );
}

export function ChatContextDialog({
  conversationId,
  trigger = 'none',
  mobileTitle,
  onNavigate,
  open: controlledOpen,
  onOpenChange,
}: {
  conversationId: string;
  trigger?: 'none' | 'mobile-title';
  mobileTitle?: string;
  onNavigate?: (href: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [context, setContext] = useState<ConversationDebugContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [freshBusy, setFreshBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.conversationContext(conversationId);
      setContext(result.context);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load chat context');
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  const handleOpenChange = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const copyInstructions = async () => {
    const core = context?.instructions.core?.content;
    const snapshot = context?.instructions.chatSnapshot?.content;
    if (!core && !snapshot) return;
    try {
      await navigator.clipboard.writeText([core, snapshot].filter(Boolean).join('\n\n'));
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const startFresh = async () => {
    if (freshBusy) return;
    setFreshBusy(true);
    setError(null);
    try {
      const { conversation } = await api.freshConversationContext(conversationId);
      const query = conversation.projectId ? `?project=${encodeURIComponent(conversation.projectId)}` : '';
      const href = `#/chat/${conversation.id}${query}`;
      handleOpenChange(false);
      if (onNavigate) onNavigate(href);
      else window.location.hash = href;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a fresh chat');
    } finally {
      setFreshBusy(false);
    }
  };

  const runtime = context?.runtime;
  const instructions = context?.instructions;

  return (
    <>
      {trigger === 'mobile-title' ? (
        <button
          type="button"
          className="relative min-w-0 flex-1 truncate rounded-sm text-left md:hidden focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => handleOpenChange(true)}
          aria-label={`View chat context for ${mobileTitle || 'Untitled chat'}`}
          title="View chat context"
        >
          {mobileTitle || 'Untitled chat'}
          <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
        </button>
      ) : null}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0 pr-9">
            <DialogTitle>Chat context</DialogTitle>
            <DialogDescription>The instruction sources, roles, and tools used for this conversation.</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {loading && !context ? (
              <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
                <RefreshCw className="mr-2 size-4 animate-spin" />
                Loading context…
              </div>
            ) : error && !context ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                {error}
                <Button variant="outline" size="sm" className="mt-3 block" onClick={() => void load()}>
                  Try again
                </Button>
              </div>
            ) : context && runtime && instructions ? (
              <div className="space-y-5 pb-1">
                {error ? <p className="text-xs text-destructive">{error}</p> : null}

                <section className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-xs font-medium">Provider base prompt</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{context.providerSystemPrompt.note}</p>
                </section>

                <section>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium">Runtime</h3>
                    {loading ? <RefreshCw className="size-3.5 animate-spin text-muted-foreground" /> : null}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg border p-3 sm:grid-cols-4">
                    <Field label="Provider" value={runtime.provider} />
                    <Field label="Model" value={runtime.model} />
                    <Field label="Effort" value={runtime.effort} />
                    <Field label="Agent" value={runtime.assistantSlug} />
                    <Field label="Project" value={runtime.projectName} />
                    <Field label="Channel" value={runtime.channel} />
                    <Field label="Approval" value={runtime.effectiveApprovalMode} />
                    <Field label="Context used" value={runtime.contextTokens === null ? null : `${runtime.contextTokens.toLocaleString()} tokens`} />
                    <div className="col-span-2 sm:col-span-4"><Field label="Workspace" value={runtime.workspaceDir} /></div>
                  </dl>
                </section>

                <section className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium">Veneer instruction receipt</h3>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {instructions.exactReceipt ? 'Exact latest turn' : 'Not captured yet'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{instructions.note}</p>
                      {instructions.delivery ? (
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{instructions.delivery}</p>
                      ) : null}
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void copyInstructions()} disabled={!instructions.core && !instructions.chatSnapshot}>
                      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>

                  {instructions.core ? (
                    <InstructionBlock
                      title="Core Veneer rules"
                      role={instructions.core.role}
                      version={`v${instructions.core.version} · ${instructions.core.hash.slice(0, 12)}`}
                      content={instructions.core.content}
                      status={instructions.core.current ? 'Current' : instructions.exactReceipt ? 'Outdated' : 'Pending first turn'}
                    />
                  ) : null}
                  {instructions.chatSnapshot ? (
                    <InstructionBlock
                      title="Fixed agent + project snapshot"
                      role={instructions.chatSnapshot.role}
                      version={`v${instructions.chatSnapshot.version} · ${instructions.chatSnapshot.hash.slice(0, 12)}`}
                      content={instructions.chatSnapshot.content}
                      status={
                        !instructions.chatSnapshot.current
                          ? instructions.exactReceipt ? 'Receipt outdated' : 'Pending first turn'
                          : instructions.chatSnapshot.settingsCurrent ? 'Settings match' : 'Newer settings available'
                      }
                    />
                  ) : null}
                </section>

                <section className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">Repository guidance</h3>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">provider-native</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {instructions.repository?.current ? 'Current receipt' : 'Changed or pending'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {instructions.repository?.note ?? 'No provider receipt is available yet.'}
                  </p>
                  {instructions.repository?.files.length ? (
                    <div className="space-y-1.5 rounded-lg border p-3">
                      {instructions.repository.files.map((file) => (
                        <div key={file.path} className="flex min-w-0 items-center gap-2 text-xs">
                          <code className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</code>
                          <span className="shrink-0 text-[10px] text-muted-foreground">{file.version}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {file.current ? 'Current' : file.legacyGenerated ? 'Obsolete Veneer file' : 'Changed'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No standard provider file was found.</p>}
                </section>

                {instructions.memory?.present ? (
                  <InstructionBlock
                    title="Latest memory reference"
                    role={instructions.memory.role}
                    version="turn-scoped"
                    content={instructions.memory.content ?? ''}
                    status="Data only"
                  />
                ) : null}

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">Tool access</h3>
                  <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">MCP servers</p><TagList values={context.tooling.mcpServers} empty="No per-chat tool receipt yet." /></div>
                  <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">Workspace skills</p><TagList values={context.tooling.skills} empty="No workspace skill links." /></div>
                  <details className="rounded-lg border p-3 text-xs">
                    <summary className="cursor-pointer font-medium">Permission rules</summary>
                    <div className="mt-3 space-y-3">
                      <div><p className="mb-1.5 text-muted-foreground">Allowed</p><TagList values={context.tooling.allowedPermissions} empty="None recorded." /></div>
                      <div><p className="mb-1.5 text-muted-foreground">Denied</p><TagList values={context.tooling.deniedPermissions} empty="None recorded." /></div>
                    </div>
                  </details>
                </section>

                <section className="rounded-lg border bg-muted/20 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">Use the latest Agent and Project settings</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">Start an empty chat with the same agent, project, provider, and model.</p>
                    </div>
                    <Button variant="outline" onClick={() => void startFresh()} disabled={freshBusy}>
                      <RotateCcw className={freshBusy ? 'size-4 animate-spin' : 'size-4'} />
                      Start fresh with latest context
                    </Button>
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ChatInfoMenuItem({
  label = 'Chat info',
  onSelect,
}: {
  label?: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Braces className="size-4 shrink-0" aria-hidden="true" />
      {label}
    </DropdownMenuItem>
  );
}
