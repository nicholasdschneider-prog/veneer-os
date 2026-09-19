import { ChevronDown, FileText, Mic, Paperclip, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type ModelOption } from '@/lib/api';
import { isComposerSubmitKey } from '@/lib/composerKeys';
import { handleComposerImagePaste } from '@/lib/composerPaste';
import { botModelChipLabel, joinDictation, withAttachmentFooter } from '@/lib/botComposer';
import { isProvider, type Provider } from '@/lib/modelLabel';
import { loadModelCatalogsProgressively } from '@/lib/newChatSelection';
import { micDictation } from '@/lib/stt';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { ProviderIcon } from './ProviderIcon';
import {
  buildExistingChatModelChoices,
  ModelThinkingPicker,
  type ModelChoice,
  type ModelThinkingValue,
} from './chat/ModelThinkingPicker';

const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  previewUrl: string | null;
  path: string | null;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The chat composer's essentials for a bot decision thread: attach files,
 * dictate, pick the bot's model and thinking level, and send. Messages go
 * through `onSend` (the decision thread), which wakes the bot's conversation;
 * the model chip edits that conversation directly so the next reply uses it.
 */
export function BotComposer({
  conversationId,
  botName,
  busy = false,
  onSend,
}: {
  conversationId: string;
  botName: string;
  busy?: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dictationBaseRef = useRef('');

  // Auto-grow with content; the max-h caps it and it scrolls past that.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const addFiles = useCallback((list: FileList | readonly File[] | null) => {
    if (!list?.length) return;
    setError(null);
    for (const file of Array.from(list)) {
      const id = crypto.randomUUID();
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setAttachments((prev) => [
        ...prev,
        { id, name: file.name, size: file.size, previewUrl, path: null, status: 'uploading' },
      ]);
      void api
        .uploadFile(file)
        .then((meta) =>
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: 'done' as const, path: meta.path, name: meta.name } : a)),
          ),
        )
        .catch((err: unknown) =>
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { ...a, status: 'error' as const, error: err instanceof Error ? err.message : 'Upload failed' }
                : a,
            ),
          ),
        );
    }
  }, []);
  const removeAttachment = (id: string) =>
    setAttachments((prev) => {
      const hit = prev.find((a) => a.id === id);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      if (micDictation.isActive) micDictation.stop('cancel');
    },
    [],
  );

  // Dictation: partials preview live, committed text joins the draft.
  const toggleDictation = () => {
    if (recording || micDictation.isActive) {
      micDictation.stop();
      return;
    }
    dictationBaseRef.current = draft;
    setError(null);
    void micDictation
      .start({
        onPartial: (text) => setDraft(joinDictation(dictationBaseRef.current, text)),
        onCommitted: (text) => {
          dictationBaseRef.current = joinDictation(dictationBaseRef.current, text);
          setDraft(dictationBaseRef.current);
        },
        onFinalizing: () => setTranscribing(true),
        onError: (message) => setError(message),
        onEnd: () => {
          setRecording(false);
          setTranscribing(false);
        },
      })
      .then(() => setRecording(true))
      .catch((e: unknown) => {
        setRecording(false);
        setError(e instanceof Error ? e.message : 'Microphone unavailable');
      });
  };

  // Model chip: read the bot conversation's current selection, offer the
  // same picker the chat uses, and switch the conversation on apply.
  const [provider, setProvider] = useState<Provider | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);
  const [options, setOptions] = useState<ModelOption[]>([]);
  const defaultEffortRef = useRef<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pick, setPick] = useState<ModelThinkingValue>({ provider: 'claude', model: '', effort: '' });
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    void api
      .conversation(conversationId)
      .then(({ conversation }) => {
        if (stop || !isProvider(conversation.provider)) return;
        setProvider(conversation.provider);
        setModel(conversation.model);
        setEffort(conversation.effort);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [conversationId]);
  useEffect(() => {
    if (!pickerOpen || !provider) return;
    setPick({ provider, model: model ?? '', effort: effort ?? '' });
    setModelError(null);
    if (choices !== null) return;
    let stop = false;
    let stopLoading = () => {};
    void api.modelPrefs().then((r) => r.prefs).catch(() => null).then((prefs) => {
      if (stop) return;
      defaultEffortRef.current = prefs?.defaultEffort ?? null;
      stopLoading = loadModelCatalogsProgressively(
        (target) => api.models(target).then((result) => result.models),
        (catalogs) => {
          if (stop) return;
          setOptions(catalogs[provider]);
          setChoices(buildExistingChatModelChoices(catalogs, prefs?.hiddenModels ?? [], prefs?.modelOrder ?? {}));
        },
      );
    });
    return () => {
      stop = true;
      stopLoading();
    };
    // Reopening re-syncs the pick; the catalog loads once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen, provider]);
  const applyModel = async () => {
    if (modelSaving) return;
    setModelSaving(true);
    setModelError(null);
    try {
      const { conversation } = await api.switchConversationModel(conversationId, pick);
      if (isProvider(conversation.provider)) setProvider(conversation.provider);
      setModel(conversation.model);
      setEffort(conversation.effort);
      setPickerOpen(false);
    } catch (e) {
      setModelError(e instanceof Error ? e.message : 'Could not switch models.');
    } finally {
      setModelSaving(false);
    }
  };
  const chipLabel = botModelChipLabel(
    provider,
    model,
    effort,
    options.find((m) => m.id === model)?.label ?? null,
  );

  const uploading = attachments.some((a) => a.status === 'uploading');
  const readyPaths = attachments.filter((a) => a.status === 'done' && a.path).map((a) => a.path!);
  const canSend = !busy && !uploading && !transcribing && (draft.trim().length > 0 || readyPaths.length > 0);
  const send = async () => {
    if (!canSend) return;
    if (uploading) {
      setError('Still uploading — one moment…');
      return;
    }
    if (recording) micDictation.stop();
    const text = withAttachmentFooter(draft, readyPaths);
    setError(null);
    try {
      await onSend(text);
      setDraft('');
      dictationBaseRef.current = '';
      for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      setAttachments([]);
      if (IS_TOUCH) textareaRef.current?.blur();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    }
  };

  return (
    <div className="space-y-2">
      <div className="rounded-3xl border border-transparent bg-card p-0.5 shadow-sm ring-1 ring-foreground/10">
        <div className="composer-fill flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-[calc(var(--radius-3xl)-2px)] px-2 py-2">
          {attachments.length ? (
            <div className="flex flex-wrap gap-1.5 px-1 pb-1">
              {attachments.map((a) => (
                <span
                  key={a.id}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1.5 rounded-lg bg-background/70 py-1 pr-1 pl-1.5 text-xs ring-1 ring-foreground/10',
                    a.status === 'error' && 'ring-destructive/50',
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                    {a.previewUrl ? <img src={a.previewUrl} alt="" className="size-full object-cover" /> : <FileText className="size-3.5" />}
                  </span>
                  <span className="min-w-0 truncate">{a.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {a.status === 'uploading' ? 'Uploading…' : a.status === 'error' ? (a.error ?? 'Failed') : formatBytes(a.size)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    onPointerUp={() => removeAttachment(a.id)}
                    className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            aria-label={`Message ${botName}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              handleComposerImagePaste(e, addFiles);
            }}
            onKeyDown={(e) => {
              // Enter sends on hardware keyboards only; the iOS return key
              // must insert a newline.
              if (isComposerSubmitKey(e) && !IS_TOUCH) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={`Message ${botName}…`}
            rows={1}
            className="max-h-[min(35dvh,16rem)] min-h-[2.5rem] w-full resize-none bg-transparent px-2.5 py-1.5 text-[16px] outline-none"
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex min-w-0 items-center justify-between gap-1.5">
            {chipLabel ? (
              <button
                type="button"
                onPointerUp={() => {
                  textareaRef.current?.blur();
                  setPickerOpen(true);
                }}
                aria-label="Bot model and thinking"
                className="flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {provider ? <ProviderIcon provider={provider} className="size-3.5 shrink-0" /> : null}
                <span className="min-w-0 truncate">{chipLabel}</span>
                <ChevronDown className="size-3.5 shrink-0" />
              </button>
            ) : (
              <span />
            )}
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onPointerUp={() => fileInputRef.current?.click()}
                aria-label="Attach files"
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              >
                <Paperclip className="h-5 w-5" />
              </button>
              <button
                type="button"
                onPointerUp={toggleDictation}
                aria-label={transcribing ? 'Finishing dictation' : recording ? 'Stop dictation' : 'Dictate message'}
                aria-pressed={recording}
                disabled={transcribing}
                className={cn(
                  'relative flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
                  recording ? 'text-destructive' : 'text-muted-foreground hover:text-foreground',
                  transcribing && 'animate-pulse opacity-60',
                )}
              >
                {recording ? <span className="absolute inset-1.5 animate-ping rounded-full bg-destructive/40" /> : null}
                <Mic className="relative size-5" />
              </button>
              <Button
                size="icon-lg"
                className="size-10 shrink-0 select-none rounded-full text-xl disabled:opacity-30"
                onPointerUp={() => void send()}
                disabled={!canSend}
                aria-label={`Send to ${botName}`}
              >
                ↑
              </Button>
            </div>
          </div>
        </div>
      </div>
      {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
      {provider ? (
        <ModelThinkingPicker
          open={pickerOpen}
          onOpenChange={(open) => {
            if (!modelSaving) setPickerOpen(open);
          }}
          title={`${botName}’s model`}
          choices={choices}
          value={pick}
          defaultEffort={defaultEffortRef.current}
          onChange={setPick}
          onApply={() => void applyModel()}
          busy={modelSaving}
          error={modelError}
          description={
            pick.provider !== provider
              ? 'Keeps the bot’s history. Its next reply starts a fresh provider session with recorded context.'
              : 'Applies to the bot’s next reply.'
          }
        />
      ) : null}
    </div>
  );
}
