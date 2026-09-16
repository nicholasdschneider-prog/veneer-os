import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { SaveStatus, SettingsSection } from './SettingsPrimitives';

interface BrowserSettings {
  quality: number;
  resolution: ResolutionMode;
}

type ResolutionMode = 'standard' | 'auto' | 'retina';

const DEFAULT_QUALITY = 80;
const DEFAULT_RESOLUTION: ResolutionMode = 'auto';
const QUALITY_SAVE_MS = 300;
const RESOLUTION_OPTIONS: ReadonlyArray<{ id: ResolutionMode; label: string; detail: string }> = [
  { id: 'standard', label: 'Standard', detail: '1×' },
  { id: 'auto', label: 'Auto', detail: '1.5× · Recommended' },
  { id: 'retina', label: 'Retina', detail: '2×' },
];

export function normalizeBrowserSettings(value: unknown): BrowserSettings {
  const settings = value && typeof value === 'object' ? value as Partial<BrowserSettings> : {};
  const resolution = RESOLUTION_OPTIONS.some((option) => option.id === settings.resolution)
    ? settings.resolution as ResolutionMode
    : DEFAULT_RESOLUTION;
  return {
    quality: Number.isInteger(settings.quality) ? settings.quality! : DEFAULT_QUALITY,
    resolution,
  };
}

async function browserSettingsRequest(init?: RequestInit): Promise<BrowserSettings> {
  const response = await fetch('/api/veneer-browser/settings', {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string; settings?: BrowserSettings }
    | null;
  if (!response.ok || !body?.settings) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return normalizeBrowserSettings(body.settings);
}

export function BrowserSettingsPage({ onToast }: { onToast: (message: string) => void }) {
  const [quality, setQuality] = useState(DEFAULT_QUALITY);
  const [resolution, setResolution] = useState<ResolutionMode>(DEFAULT_RESOLUTION);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const qualityRef = useRef(quality);
  const resolutionRef = useRef(resolution);
  const savedRef = useRef<BrowserSettings>({ quality: DEFAULT_QUALITY, resolution: DEFAULT_RESOLUTION });
  const saveGen = useRef(0);
  const qualityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    void browserSettingsRequest()
      .then((settings) => {
        if (!active) return;
        qualityRef.current = settings.quality;
        resolutionRef.current = settings.resolution;
        savedRef.current = settings;
        setQuality(settings.quality);
        setResolution(settings.resolution);
      })
      .catch((error: Error) => {
        if (active) onToast(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (qualityTimer.current != null) clearTimeout(qualityTimer.current);
    };
  }, [onToast]);

  const persist = async (next: BrowserSettings) => {
    if (next.quality === savedRef.current.quality && next.resolution === savedRef.current.resolution) return;
    const gen = ++saveGen.current;
    setSaved(false);
    try {
      const settings = await browserSettingsRequest({ method: 'PUT', body: JSON.stringify(next) });
      if (gen !== saveGen.current) return;
      savedRef.current = settings;
      qualityRef.current = settings.quality;
      resolutionRef.current = settings.resolution;
      setQuality(settings.quality);
      setResolution(settings.resolution);
      setSaved(true);
    } catch (error) {
      if (gen !== saveGen.current) return;
      onToast(error instanceof Error ? error.message : 'Could not update browser settings.');
    }
  };

  const changeResolution = (next: ResolutionMode) => {
    if (next === resolutionRef.current) return;
    if (qualityTimer.current != null) {
      clearTimeout(qualityTimer.current);
      qualityTimer.current = null;
    }
    resolutionRef.current = next;
    setResolution(next);
    void persist({ quality: qualityRef.current, resolution: next });
  };

  const changeQuality = (next: number) => {
    qualityRef.current = next;
    setQuality(next);
    if (qualityTimer.current != null) clearTimeout(qualityTimer.current);
    qualityTimer.current = setTimeout(() => {
      qualityTimer.current = null;
      void persist({ quality: qualityRef.current, resolution: resolutionRef.current });
    }, QUALITY_SAVE_MS);
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection title="Display resolution">
        <fieldset disabled={loading} className="grid gap-2 border-y border-foreground/10 py-4 sm:grid-cols-3">
          <legend className="sr-only">Browser display resolution</legend>
          {RESOLUTION_OPTIONS.map((option) => {
            const selected = resolution === option.id;
            return (
              <label
                key={option.id}
                className={`group flex cursor-pointer flex-col rounded-xl border px-3.5 py-3 transition-colors has-disabled:cursor-default has-disabled:opacity-50 ${
                  selected
                    ? 'border-brand bg-brand/10 shadow-sm ring-1 ring-brand/30'
                    : 'border-foreground/15 hover:bg-accent'
                }`}
              >
                <input
                  type="radio"
                  name="browser-resolution"
                  value={option.id}
                  checked={selected}
                  onChange={() => changeResolution(option.id)}
                  className="sr-only"
                />
                <span className="flex items-center justify-between gap-2">
                  <span className={`font-medium ${selected ? 'text-brand' : ''}`}>{option.label}</span>
                  {selected ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                      <CheckCircle2 className="size-3.5" aria-hidden="true" />
                      Selected
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 text-sm text-muted-foreground">{option.detail}</span>
              </label>
            );
          })}
        </fieldset>
      </SettingsSection>
      <SettingsSection title="Quality" action={saved ? <SaveStatus /> : null}>
        <div className="flex flex-col gap-4 border-y border-foreground/10 py-4">
          <output htmlFor="browser-quality" className="self-end tabular-nums text-xl font-semibold text-brand">
            {quality}
          </output>
          <input
            id="browser-quality"
            name="browser-quality"
            type="range"
            min="40"
            max="95"
            step="5"
            value={quality}
            disabled={loading}
            aria-label="Quality"
            className="h-6 w-full cursor-pointer accent-brand disabled:cursor-default disabled:opacity-50"
            onChange={(event) => changeQuality(Number(event.target.value))}
          />
        </div>
      </SettingsSection>
    </div>
  );
}
