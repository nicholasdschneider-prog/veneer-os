import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Trash2, Upload } from 'lucide-react';
import { api, type CustomFont, type PageBrand } from '../../lib/api';
import { applyBrand } from '../../lib/brandTheme';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// Veneer's house style — what published pages look like when nothing is set.
const DEFAULTS = {
  background: '#faf7f2',
  text: '#26221c',
  accent: '#8a6d47',
  font: 'Inter',
} as const;

const EMPTY_BRAND: PageBrand = {
  primaryColor: '',
  accentColor: '',
  backgroundColor: '',
  font: '',
  headingFont: '',
  notes: '',
  applyToApp: true,
};

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Empty is allowed (= unset); a non-empty value must be #rgb / #rrggbb. */
function isValidHex(v: string): boolean {
  return v === '' || HEX_RE.test(v.trim());
}

/**
 * Settings → Appearance. Owner-set brand defaults (colors, a font, style notes)
 * for published pages/apps and the optional app tint. Every string field may be
 * left blank; blank fields fall back to Veneer's house style. Reading is open;
 * saving is owner/consultant only, so this card is hidden from members.
 */
export function BrandCard({ className }: { className?: string }) {
  const [brand, setBrand] = useState<PageBrand | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The uploaded-font library, shared with the Fonts card and the preview so a
  // just-uploaded family renders immediately.
  const [fonts, setFonts] = useState<CustomFont[]>([]);
  const [fontsConfigured, setFontsConfigured] = useState(true);

  useEffect(() => {
    let stop = false;
    void api
      .pageBrand()
      .then((r) => {
        if (stop) return;
        setBrand({ ...EMPTY_BRAND, ...r.brand });
      })
      .catch((err: Error) => setLoadError(err.message));
    void api
      .customFonts()
      .then((r) => {
        if (stop) return;
        setFonts(r.fonts);
        setFontsConfigured(r.configured);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, []);

  // Make every uploaded family usable inside this screen, so the preview and
  // the font list show the real typeface rather than a fallback.
  useEffect(() => {
    if (fonts.length === 0) return;
    const style = document.createElement('style');
    style.textContent = fonts
      .map(
        (font) =>
          `@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(
            font.publicUrl,
          )});font-weight:${font.weight};font-style:${font.style};font-display:swap;}`,
      )
      .join('\n');
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [fonts]);

  const set = useCallback((patch: Partial<PageBrand>) => {
    setSaved(false);
    setBrand((b) => (b ? { ...b, ...patch } : b));
  }, []);

  const colorsValid =
    !!brand &&
    isValidHex(brand.primaryColor) &&
    isValidHex(brand.accentColor) &&
    isValidHex(brand.backgroundColor);

  const save = useCallback(async () => {
    if (!brand || !colorsValid) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const clean: PageBrand = {
        primaryColor: brand.primaryColor.trim(),
        accentColor: brand.accentColor.trim(),
        backgroundColor: brand.backgroundColor.trim(),
        font: brand.font.trim(),
        headingFont: brand.headingFont.trim(),
        notes: brand.notes,
        applyToApp: brand.applyToApp,
      };
      const r = await api.updatePageBrand(clean);
      setBrand({ ...EMPTY_BRAND, ...r.brand });
      applyBrand(r.brand);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [brand, colorsValid]);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <p className="px-1 text-sm text-muted-foreground">
        These defaults style the pages and apps agents publish and, when app tinting is on, subtly
        recolor Veneer Pro. Set client brand colors, a font, and a few notes, or leave everything
        blank to use Veneer's own look.
      </p>

      {loadError ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{loadError}</div>
      ) : null}

      {brand === null && !loadError ? (
        <p className="px-1 text-sm text-muted-foreground">Loading…</p>
      ) : null}

      {brand ? (
        <>
          <Card className="[--card-spacing:--spacing(5)]">
            <CardHeader>
              <CardTitle className="text-lg font-semibold">Brand defaults</CardTitle>
              <CardDescription>Colors and typography for published pages and apps.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <div className="flex flex-col gap-4">
                <ColorField
                  label="Primary"
                  hint="Headings and key accents."
                  fallback={DEFAULTS.text}
                  value={brand.primaryColor}
                  onChange={(v) => set({ primaryColor: v })}
                />
                <ColorField
                  label="Accent"
                  hint="Buttons and links."
                  fallback={DEFAULTS.accent}
                  value={brand.accentColor}
                  onChange={(v) => set({ accentColor: v })}
                />
                <ColorField
                  label="Background"
                  hint="Page background."
                  fallback={DEFAULTS.background}
                  value={brand.backgroundColor}
                  onChange={(v) => set({ backgroundColor: v })}
                />

                <FontField
                  label="Heading font"
                  placeholder="Same as body text"
                  value={brand.headingFont}
                  fonts={fonts}
                  onChange={(v) => set({ headingFont: v })}
                />

                <FontField
                  label="Body font"
                  placeholder="Inter / Assistant"
                  value={brand.font}
                  fonts={fonts}
                  onChange={(v) => set({ font: v })}
                />

                <label className="block">
                  <span className="font-medium">Style notes</span>
                  <textarea
                    value={brand.notes}
                    onChange={(e) => set({ notes: e.target.value })}
                    maxLength={600}
                    rows={4}
                    placeholder="Logo is a white monogram; prefer dark backgrounds; buttons pill-shaped…"
                    className="mt-1.5 w-full resize-none rounded-xl border bg-card px-4 py-3 text-base outline-none focus:border-ring"
                  />
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    Free-form guidance for agents. {600 - brand.notes.length} characters left.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">Tint the app with these colors</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Subtly recolors the Veneer Pro interface for everyone on this instance. Pages
                      and apps are always styled.
                    </p>
                  </div>
                  <Switch
                    checked={brand.applyToApp}
                    aria-label="Tint the app with these colors"
                    onCheckedChange={() => set({ applyToApp: !brand.applyToApp })}
                  />
                </div>
              </div>

              {saveError ? (
                <div className="mt-4 rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{saveError}</div>
              ) : null}

              {saved ? (
                <div className="mt-4 flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-brand">
                  <CheckCircle2 className="size-4 shrink-0" /> Saved.
                </div>
              ) : null}

              <Button
                className="mt-4 h-12 w-full rounded-xl text-base"
                onPointerUp={() => void save()}
                disabled={saving || !colorsValid}
              >
                {saving ? 'Saving…' : 'Save brand defaults'}
              </Button>
            </CardContent>
          </Card>

          <FontsCard
            fonts={fonts}
            configured={fontsConfigured}
            onChange={setFonts}
          />

          <BrandPreview brand={brand} fonts={fonts} />
        </>
      ) : null}
    </div>
  );
}

/** A font-family name field that also lists the uploaded families as shortcuts. */
function FontField({
  label,
  placeholder,
  value,
  fonts,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  fonts: CustomFont[];
  onChange: (v: string) => void;
}) {
  const families = useMemo(
    () => [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b)),
    [fonts],
  );
  const isCustom = families.some((f) => f.toLowerCase() === value.trim().toLowerCase());
  return (
    <label className="block">
      <span className="font-medium">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        className="mt-1.5 h-12 rounded-xl px-4 text-base md:text-base"
      />
      {families.length > 0 ? (
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {families.map((family) => (
            <Button
              key={family}
              type="button"
              variant="outline"
              className="h-8 rounded-full px-3 text-xs"
              style={{ fontFamily: `'${family.replace(/'/g, '')}', inherit` }}
              onPointerUp={() => onChange(family)}
            >
              {family}
            </Button>
          ))}
        </span>
      ) : null}
      <span className="mt-1.5 block text-xs text-muted-foreground">
        {isCustom
          ? 'An uploaded font — pages load it from your own font library.'
          : 'Any Google Fonts family name works, or upload your own below.'}
      </span>
    </label>
  );
}

const WEIGHTS = ['300', '400', '500', '600', '700', '800'];

/**
 * The uploaded font library. Files land in the same R2 bucket that serves
 * pages, so a published page loads them from its own origin. Naming the family
 * here is what links a file to the Heading/Body font fields above.
 */
function FontsCard({
  fonts,
  configured,
  onChange,
}: {
  fonts: CustomFont[];
  configured: boolean;
  onChange: (fonts: CustomFont[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [family, setFamily] = useState('');
  const [weight, setWeight] = useState('400');
  const [style, setStyle] = useState<'normal' | 'italic'>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const font = await api.uploadCustomFont({ family: family.trim(), weight, style }, file);
        onChange([...fonts, font].sort((a, b) => a.family.localeCompare(b.family)));
        setFamily('');
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [family, weight, style, fonts, onChange],
  );

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await api.deleteCustomFont(id);
        onChange(fonts.filter((f) => f.id !== id));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [fonts, onChange],
  );

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Fonts</CardTitle>
        <CardDescription>
          Upload a licensed typeface that Google Fonts does not carry, then name it above.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {!configured ? (
          <p className="rounded-xl border px-4 py-3 text-muted-foreground">
            Font hosting needs page publishing to be set up on this instance. Everything else on this
            screen still works.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {fonts.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {fonts.map((font) => (
                  <li
                    key={font.id}
                    className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p
                        className="truncate font-medium"
                        style={{ fontFamily: `'${font.family.replace(/'/g, '')}', inherit` }}
                      >
                        {font.family}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {font.weight} {font.style} · {font.fileName} ·{' '}
                        {Math.max(1, Math.round(font.sizeBytes / 1024))} KB
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Delete ${font.family} ${font.weight}`}
                      className="size-9 shrink-0 rounded-xl text-muted-foreground"
                      onPointerUp={() => void remove(font.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No custom fonts yet.</p>
            )}

            <div className="flex flex-col gap-3 rounded-xl border px-4 py-4">
              <label className="block">
                <span className="font-medium">Family name</span>
                <Input
                  value={family}
                  onChange={(e) => setFamily(e.target.value)}
                  placeholder="Harman Sans"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-1.5 h-12 rounded-xl px-4 text-base md:text-base"
                />
                <span className="mt-1.5 block text-xs text-muted-foreground">
                  Exactly what pages will write in CSS. Upload one file per weight, all under the
                  same name.
                </span>
              </label>

              <div className="flex gap-2">
                <label className="flex-1">
                  <span className="font-medium">Weight</span>
                  <select
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    className="mt-1.5 h-12 w-full rounded-xl border bg-card px-4 text-base outline-none focus:border-ring"
                  >
                    {WEIGHTS.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex-1">
                  <span className="font-medium">Style</span>
                  <select
                    value={style}
                    onChange={(e) => setStyle(e.target.value as 'normal' | 'italic')}
                    className="mt-1.5 h-12 w-full rounded-xl border bg-card px-4 text-base outline-none focus:border-ring"
                  >
                    <option value="normal">Normal</option>
                    <option value="italic">Italic</option>
                  </select>
                </label>
              </div>

              <input
                ref={fileInput}
                type="file"
                accept=".woff2,.woff,.ttf,.otf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <Button
                type="button"
                className="h-12 w-full rounded-xl text-base"
                disabled={busy || family.trim().length === 0}
                onPointerUp={() => fileInput.current?.click()}
              >
                <Upload className="size-4" />
                {busy ? 'Uploading…' : 'Choose font file'}
              </Button>
              <p className="text-xs text-muted-foreground">
                .woff2 preferred, up to 2 MB. Only upload fonts you are licensed to use on the web.
              </p>
            </div>

            {error ? (
              <div className="rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{error}</div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** A hex color field: a native swatch synced to a hex text input. Empty = unset
 *  (swatch shows the Veneer fallback); invalid hex flags the input but never
 *  blocks typing. */
function ColorField({
  label,
  hint,
  fallback,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  fallback: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const trimmed = value.trim();
  const valid = isValidHex(value);
  const swatch = valid && trimmed !== '' ? trimmed : fallback;
  return (
    <label className="block">
      <span className="font-medium">{label}</span>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="color"
          value={swatch}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} color swatch`}
          className="size-12 shrink-0 cursor-pointer rounded-xl border bg-card p-1"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fallback}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!valid}
          className={`h-12 flex-1 rounded-xl px-4 font-mono text-base md:text-base ${
            valid ? '' : 'border-destructive focus-visible:border-destructive'
          }`}
        />
      </div>
      <span className="mt-1.5 block text-xs text-muted-foreground">
        {valid ? hint : 'Enter a hex color like #8a6d47 (or clear to use the default).'}
      </span>
    </label>
  );
}

/** A mini mock page rendered with the chosen brand so the owner sees the vibe.
 *  Falls back to Veneer's defaults for any blank field. */
function BrandPreview({ brand, fonts }: { brand: PageBrand; fonts: CustomFont[] }) {
  const bg = isValidHex(brand.backgroundColor) && brand.backgroundColor.trim()
    ? brand.backgroundColor.trim()
    : DEFAULTS.background;
  const primary = isValidHex(brand.primaryColor) && brand.primaryColor.trim()
    ? brand.primaryColor.trim()
    : DEFAULTS.text;
  const accent = isValidHex(brand.accentColor) && brand.accentColor.trim()
    ? brand.accentColor.trim()
    : DEFAULTS.accent;
  const font = brand.font.trim() || DEFAULTS.font;
  const headingFont = brand.headingFont.trim() || font;

  const allEmpty =
    !brand.primaryColor.trim() &&
    !brand.accentColor.trim() &&
    !brand.backgroundColor.trim() &&
    !brand.font.trim() &&
    !brand.headingFont.trim();

  // Pull the chosen Google Fonts in so the preview actually shows them
  // (best-effort; silently falls back if a family doesn't exist). Uploaded
  // families are skipped — BrandCard already injects their @font-face rules.
  const uploaded = useMemo(
    () => new Set(fonts.map((f) => f.family.trim().toLowerCase())),
    [fonts],
  );
  const googleFamilies = useMemo(
    () =>
      [...new Set([headingFont, font])].filter(
        (family) => family && family.toLowerCase() !== 'inter' && !uploaded.has(family.toLowerCase()),
      ),
    [headingFont, font, uploaded],
  );

  useEffect(() => {
    if (googleFamilies.length === 0) return;
    const links = googleFamilies.map((family) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;600;700&display=swap`;
      document.head.appendChild(link);
      return link;
    });
    return () => {
      for (const link of links) link.remove();
    };
  }, [googleFamilies]);

  const stack = (family: string) =>
    `'${family.replace(/'/g, '')}', ui-sans-serif, system-ui, sans-serif`;
  const fontFamily = useMemo(() => stack(font), [font]);
  const headingFamily = useMemo(() => stack(headingFont), [headingFont]);

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Preview</CardTitle>
        <CardDescription>How published pages and apps pick up these defaults.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        <div
          className="overflow-hidden rounded-xl border"
          style={{ background: bg, fontFamily }}
        >
          <div className="px-5 py-6">
            <h3 className="text-xl font-bold" style={{ color: primary, fontFamily: headingFamily }}>
              A page from your agent
            </h3>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: primary, opacity: 0.8 }}>
              This is roughly how a published page will read — the heading, a line of body copy, and a
              call-to-action button, all wearing your brand.
            </p>
            <button
              type="button"
              tabIndex={-1}
              className="mt-4 rounded-full px-4 py-2 text-sm font-semibold text-white"
              style={{ background: accent }}
            >
              Get started
            </button>
          </div>
        </div>
        {allEmpty ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Veneer default look (used when nothing is set).
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
