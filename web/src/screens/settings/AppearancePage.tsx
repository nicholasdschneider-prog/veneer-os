import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { CheckCircle2, ImageIcon, LoaderCircle, Trash2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { BrandCard } from './BrandCard';
import { CLIENT_LOGO_CHANGED_EVENT, normalizeClientLogo } from '../../lib/clientLogo';
import {
  DICTATION_WAVEFORM_OPTIONS,
  setDictationWaveformStyle,
  useDictationWaveformStyle,
  type DictationWaveformStyle,
} from '../../lib/dictationWaveform';
import {
  applyColorMode,
  applyTheme,
  getColorMode,
  getTheme,
  THEMES,
  type ColorMode,
  type ThemeId,
} from '../../lib/theme';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SettingsSection } from './SettingsPrimitives';
import { ProviderIcon } from '@/components/ProviderIcon';
import { CreatorAvatar } from '@/components/CreatorAvatar';
import { updateChatListIcon, useChatAppearance, type ChatListIconMode } from '../../lib/chatAppearance';

const VOICE_MEMOS_PREVIEW_HEIGHTS = [3, 8, 5, 10, 4, 7, 11, 6, 3, 9, 5, 8];
const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/**
 * Visual preferences. Chat icons, brand, and client logo are shared by the
 * whole Veneer instance; theme stays per-device and applies instantly.
 */
export function AppearancePage({ role }: { role: string }) {
  const [theme, setTheme] = useState<ThemeId>(() => getTheme());
  const [colorMode, setColorMode] = useState<ColorMode>(() => getColorMode());
  const pick = useCallback((id: ThemeId) => {
    setTheme(id);
    applyTheme(id);
  }, []);
  const pickColorMode = useCallback((mode: ColorMode) => {
    setColorMode(mode);
    applyColorMode(mode);
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection title="On this device" description="Only this browser is affected.">
        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Theme</CardTitle>
            <CardDescription>Choose the color treatment used by Veneer Pro.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="mb-5">
              <p className="font-medium">Color mode</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                System follows this device. Light and Dark override it.
              </p>
              <div
                role="radiogroup"
                aria-label="Color mode"
                className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1"
              >
                {COLOR_MODES.map((mode) => {
                  const selected = colorMode === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => pickColorMode(mode.id)}
                      className={`rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors ${
                        selected
                          ? 'bg-card text-card-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {mode.label}
                    </button>
                  );
                })}
              </div>
              {theme === 'terminal' ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  The Terminal theme always uses dark mode.
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 border-t pt-5">
              <p className="mb-1 font-medium">Theme style</p>
              {THEMES.map((t) => {
                const selected = theme === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onPointerUp={() => pick(t.id)}
                    aria-pressed={selected}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left ${
                      selected ? 'border-ring' : 'active:bg-accent'
                    }`}
                  >
                    <span className="flex shrink-0 -space-x-1.5">
                      {t.preview.map((c) => (
                        <span
                          key={c}
                          className="size-4 rounded-full border border-foreground/20"
                          style={{ background: c }}
                        />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{t.label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {t.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded border px-1.5 py-px text-[10px] font-medium text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    </span>
                    {selected ? <CheckCircle2 className="size-4 shrink-0 text-brand" /> : null}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </SettingsSection>

      {role !== 'member' ? (
        <SettingsSection
          title="For this workspace"
          description="Shared appearance is visible to everyone in this Veneer Pro install."
        >
          <ChatListIconsCard />
          <BrandCard />
          <ClientLogoCard />
        </SettingsSection>
      ) : null}
    </div>
  );
}

const CHAT_LIST_ICON_OPTIONS: Array<{
  id: ChatListIconMode;
  label: string;
  description: string;
}> = [
  {
    id: 'provider',
    label: 'Provider logo',
    description: 'Show whether each chat uses Claude, Codex, or OpenRouter.',
  },
  {
    id: 'creator',
    label: 'Creator initial',
    description: 'Show the first letter of the person who started each chat.',
  },
];

function ChatListIconsCard() {
  const appearance = useChatAppearance();
  const disabled = !appearance.loaded || appearance.saving;

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Chat list icons</CardTitle>
        <CardDescription>Choose what appears beside chats in project and chat lists.</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset
          disabled={disabled}
          aria-busy={appearance.loading || appearance.saving}
          className={`flex flex-col gap-2 ${disabled ? 'opacity-60' : ''}`}
        >
          <legend className="sr-only">Chat list icons</legend>
          {CHAT_LIST_ICON_OPTIONS.map((option) => (
            <label
              key={option.id}
              className="group flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-base/6 has-checked:border-ring hover:bg-accent sm:text-sm/5"
            >
              <input
                type="radio"
                name="chat-list-icon"
                value={option.id}
                checked={appearance.listIcon === option.id}
                onChange={() => void updateChatListIcon(option.id)}
                className="sr-only"
              />
              {option.id === 'provider' ? (
                <span aria-hidden="true" className="shrink-0">
                  <ProviderIcon provider="claude" className="size-4 text-muted-foreground" />
                </span>
              ) : (
                <CreatorAvatar name="Alex" className="size-4 text-[9px]" />
              )}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{option.label}</span>
                <span className="mt-0.5 block text-pretty text-muted-foreground">{option.description}</span>
              </span>
              <CheckCircle2 className="size-4 shrink-0 stroke-brand group-not-has-checked:hidden" aria-hidden="true" />
            </label>
          ))}
        </fieldset>
        {appearance.error ? (
          <p role="alert" className="mt-3 text-base/6 text-destructive sm:text-sm/5">
            {appearance.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function VoiceWaveformCard() {
  const waveform = useDictationWaveformStyle();
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Voice waveform</CardTitle>
        <CardDescription>Choose the visualization shown while you speak on this device.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        <div role="group" aria-label="Voice waveform" className="flex flex-col gap-2">
          {DICTATION_WAVEFORM_OPTIONS.map((option) => {
            const selected = waveform === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setDictationWaveformStyle(option.id)}
                aria-pressed={selected}
                className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left ${
                  selected ? 'border-ring' : 'hover:bg-accent active:bg-accent'
                }`}
              >
                <WaveformPreview style={option.id} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
                </span>
                {selected ? <CheckCircle2 className="size-4 shrink-0 text-brand" /> : null}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ClientLogoCard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [logo, setLogo] = useState<Blob | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (!logo) {
      setLogoUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(logo);
    setLogoUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [logo]);

  useEffect(() => {
    let stopped = false;
    void api
      .clientLogo()
      .then((storedLogo) => {
        if (!stopped) setLogo(storedLogo);
      })
      .catch((error: Error) => {
        if (!stopped) setStatus({ kind: 'error', message: error.message });
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, []);

  const upload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy('uploading');
    setStatus(null);
    try {
      const normalized = await normalizeClientLogo(file);
      await api.updateClientLogo(normalized);
      setLogo(normalized);
      window.dispatchEvent(new Event(CLIENT_LOGO_CHANGED_EVENT));
      setStatus({ kind: 'success', message: 'Client logo saved.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Client logo could not be saved.',
      });
    } finally {
      setBusy(null);
      event.target.value = '';
    }
  }, []);

  const remove = useCallback(async () => {
    setBusy('removing');
    setStatus(null);
    try {
      await api.deleteClientLogo();
      setLogo(null);
      window.dispatchEvent(new Event(CLIENT_LOGO_CHANGED_EVENT));
      setStatus({ kind: 'success', message: 'Client logo removed.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Client logo could not be removed.',
      });
    } finally {
      setBusy(null);
    }
  }, []);

  const disabled = loading || busy !== null;

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Client logo</CardTitle>
        <CardDescription>Shared across this client instance.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-[min(2vw,var(--radius-xl))] bg-muted/50 outline-1 -outline-offset-1 outline-foreground/10">
            {loading ? (
              <div className="flex flex-col items-center gap-2 text-center text-base/7 text-muted-foreground sm:text-sm/6">
                <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                <p>Loading logo…</p>
              </div>
            ) : logoUrl ? (
              <img src={logoUrl} alt="Client logo preview" className="size-full shrink-0 object-contain p-2" />
            ) : (
              <div className="flex flex-col items-center gap-2 text-center text-base/7 text-muted-foreground sm:text-sm/6">
                <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
                <p>No logo uploaded.</p>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <p className="text-pretty text-base/7 text-muted-foreground sm:text-sm/6">
              PNG, JPG, WebP, or SVG. Non-square images are fitted inside a transparent square without cropping.
            </p>
            <input
              ref={inputRef}
              type="file"
              name="client-logo"
              accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml"
              aria-label="Choose client logo"
              className="sr-only"
              disabled={disabled}
              onChange={upload}
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button
                type="button"
                variant="secondary"
                className="relative w-full sm:w-auto"
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
              >
                <span
                  className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                  aria-hidden="true"
                />
                {busy === 'uploading' ? (
                  <LoaderCircle data-icon="inline-start" className="size-4 animate-spin" />
                ) : (
                  <Upload data-icon="inline-start" className="size-4" />
                )}
                {busy === 'uploading' ? 'Preparing…' : logo ? 'Replace logo' : 'Choose logo'}
              </Button>
              {logo ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="relative w-full sm:w-auto"
                  disabled={disabled}
                  onClick={remove}
                >
                  <span
                    className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                    aria-hidden="true"
                  />
                  {busy === 'removing' ? (
                    <LoaderCircle data-icon="inline-start" className="size-4 animate-spin" />
                  ) : (
                    <Trash2 data-icon="inline-start" className="size-4" />
                  )}
                  {busy === 'removing' ? 'Removing…' : 'Remove'}
                </Button>
              ) : null}
            </div>
            {status ? (
              <div
                role={status.kind === 'error' ? 'alert' : 'status'}
                className={`flex items-start gap-2 text-base/7 sm:text-sm/6 ${
                  status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {status.kind === 'success' ? (
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                ) : null}
                <p className="text-pretty">{status.message}</p>
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function WaveformPreview({ style }: { style: DictationWaveformStyle }) {
  return (
    <span
      className="flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/60"
      aria-hidden="true"
    >
      <svg viewBox="0 0 56 24" className="h-6 w-14">
        {style === 10 ? (
          <>
            <path
              d="M 0 13 Q 7 3 14 12 T 28 10 T 42 14 T 56 8"
              fill="none"
              stroke="var(--brand)"
              strokeWidth="5"
              opacity="0.15"
            />
            <path
              d="M 0 13 Q 7 3 14 12 T 28 10 T 42 14 T 56 8"
              fill="none"
              stroke="var(--brand)"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </>
        ) : (
          VOICE_MEMOS_PREVIEW_HEIGHTS.map((height, index) => (
            <line
              key={index}
              x1={2 + index * 4.7}
              x2={2 + index * 4.7}
              y1={12 - height / 2}
              y2={12 + height / 2}
              stroke="var(--destructive)"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          ))
        )}
      </svg>
    </span>
  );
}
