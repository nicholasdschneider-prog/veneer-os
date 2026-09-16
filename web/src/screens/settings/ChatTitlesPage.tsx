import { useCallback, useEffect, useState } from 'react';
import { api, type ModelPrefs } from '../../lib/api';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const DEFAULT_TITLE_MODEL = 'z-ai/glm-5.2';

/**
 * Settings → Providers & models → History & titles. When on, a new chat's first message is sent to
 * OpenRouter for a ≤4-word title (replacing the first-line placeholder), and
 * that title is locked so the provider's own rolling title won't overwrite it.
 * Off keeps the previous behaviour (first-line placeholder + provider title).
 * Needs an OpenRouter key (Settings → Credentials); defaults to GLM 5.2.
 */
export function ChatTitlesPage() {
  const [prefs, setPrefs] = useState<ModelPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local draft for the model field so typing doesn't fire a save per keystroke.
  const [modelDraft, setModelDraft] = useState('');

  useEffect(() => {
    let stop = false;
    void api
      .modelPrefs()
      .then((r) => {
        if (stop) return;
        setPrefs(r.prefs);
        setModelDraft(r.prefs.autoTitle.model);
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      stop = true;
    };
  }, []);

  const savePrefs = useCallback((next: ModelPrefs) => {
    setPrefs(next); // optimistic; the server response reconciles
    setError(null);
    void api
      .updateModelPrefs(next)
      .then((r) => {
        setPrefs(r.prefs);
        setModelDraft(r.prefs.autoTitle.model);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!prefs) return;
      savePrefs({ ...prefs, autoTitle: { ...prefs.autoTitle, enabled } });
    },
    [prefs, savePrefs],
  );

  const commitModel = useCallback(() => {
    if (!prefs) return;
    const model = modelDraft.trim() || DEFAULT_TITLE_MODEL;
    if (model === prefs.autoTitle.model) {
      setModelDraft(model);
      return;
    }
    savePrefs({ ...prefs, autoTitle: { ...prefs.autoTitle, model } });
  }, [prefs, modelDraft, savePrefs]);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Chat titles</CardTitle>
          <CardDescription>
            Name new chats automatically from your first message, using an OpenRouter model.
          </CardDescription>
          <CardAction>
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                !prefs ? 'bg-muted text-muted-foreground' : prefs.autoTitle.enabled ? 'bg-accent text-brand' : 'bg-muted text-muted-foreground'
              }`}
            >
              {!prefs ? '…' : prefs.autoTitle.enabled ? 'On' : 'Off'}
            </span>
          </CardAction>
        </CardHeader>
        <CardContent className="text-sm">
          {!prefs ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <label className="flex items-center justify-between gap-3">
                <span className="font-medium">Name chats automatically</span>
                <Switch
                  checked={prefs.autoTitle.enabled}
                  aria-label="Toggle automatic chat titles"
                  onCheckedChange={() => setEnabled(!prefs.autoTitle.enabled)}
                />
              </label>
              <p className="mt-2 text-xs text-muted-foreground">
                When on, your first message is sent to OpenRouter for a four-word title, and that title is kept (the
                provider's own auto-title won't replace it). When off, chats use the first line of your message.
              </p>

              {prefs.autoTitle.enabled ? (
                <>
                  <label className="mt-4 block">
                    <span className="font-medium">Model</span>
                    <Input
                      value={modelDraft}
                      onChange={(e) => setModelDraft(e.target.value)}
                      onBlur={commitModel}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.currentTarget.blur();
                        }
                      }}
                      placeholder={DEFAULT_TITLE_MODEL}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      autoComplete="off"
                      className="mt-1.5 h-12 rounded-xl px-4 text-base md:text-base"
                    />
                  </label>
                  <p className="mt-2 text-xs text-muted-foreground">
                    An OpenRouter model id (e.g. <code>z-ai/glm-5.2</code>). Needs an OpenRouter key in Settings → API
                    Keys; without one, chats fall back to the first-line title.
                  </p>
                </>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
