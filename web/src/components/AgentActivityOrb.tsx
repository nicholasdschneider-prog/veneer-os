import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { CanvasHTMLAttributes, CSSProperties } from 'react';
import {
  MODE_DRAWS,
  ThinkingOrb,
  resolvePreset,
  type OrbSize,
  type OrbState,
  type OrbTheme,
  type ThinkingOrbProps,
} from 'thinking-orbs';

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
let colorSchemeMedia: MediaQueryList | null = null;

function currentOrbTheme(): OrbTheme {
  if (typeof document === 'undefined') return 'light';
  return getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'light';
}

function notifyThemeListeners() {
  themeListeners.forEach((listener) => listener());
}

function subscribeToOrbTheme(listener: () => void): () => void {
  themeListeners.add(listener);

  if (typeof document !== 'undefined' && themeListeners.size === 1) {
    themeObserver = new MutationObserver(notifyThemeListeners);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-color-mode', 'class'],
    });
    colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    colorSchemeMedia.addEventListener('change', notifyThemeListeners);
  }

  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size > 0) return;
    themeObserver?.disconnect();
    themeObserver = null;
    colorSchemeMedia?.removeEventListener('change', notifyThemeListeners);
    colorSchemeMedia = null;
  };
}

type AgentActivityOrbProps = Omit<ThinkingOrbProps, 'size' | 'state' | 'theme'> & {
  state: OrbState;
  size?: OrbSize;
};

/** The document's current orb theme, live-updating on theme/color-scheme change. */
export function useOrbTheme(): OrbTheme {
  return useSyncExternalStore(subscribeToOrbTheme, currentOrbTheme, (): OrbTheme => 'light');
}

/** Theme-aware Veneer wrapper for the monochrome agent activity animations. */
export function AgentActivityOrb({ state, size = 20, ...props }: AgentActivityOrbProps) {
  const theme = useOrbTheme();
  return <ThinkingOrb state={state} size={size} theme={theme} {...props} />;
}

/**
 * A crisp orb at an arbitrary CSS size. thinking-orbs only ships 64/20 presets
 * and, at 64 scaled up to a larger box, its 128px backing store blurs on a
 * high-DPI screen. This drives the same painters directly at the display size
 * and the device's pixel ratio, so a 110px orb is sharp on a 3x phone.
 */
export function SharpOrb({
  state,
  cssSize,
  className,
  style,
  ...rest
}: {
  state: OrbState;
  cssSize: number;
  className?: string;
  style?: CSSProperties;
} & Omit<CanvasHTMLAttributes<HTMLCanvasElement>, 'style'>) {
  const theme = useOrbTheme();
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2.5, Math.max(1, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1));
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    const preset = resolvePreset(state, 64);
    const dark = theme === 'dark';
    const reduce =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let start = 0;
    const paint = (now: number) => {
      if (!start) start = now;
      const t = reduce ? 0 : ((now - start) / 1000) * preset.speed;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssSize, cssSize);
      MODE_DRAWS[preset.mode](ctx, cssSize, t, dark, preset.opts);
      if (!reduce) raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [state, cssSize, theme]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="Loading"
      className={className}
      style={{ width: cssSize, height: cssSize, display: 'block', ...style }}
      {...rest}
    />
  );
}
