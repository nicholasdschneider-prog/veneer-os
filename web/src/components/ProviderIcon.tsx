import { useId } from 'react';
import { cn } from '@/lib/utils';
import type { Provider } from '@/lib/modelLabel';

/**
 * Brand glyphs for the agent providers (Claude, OpenRouter, Codex, Grok). Two variants:
 *
 *  - `mono` (default): `fill="currentColor"`, so it inherits the surrounding
 *    text color and themes automatically — black-ish on light, white on dark.
 *    This is what makes a single asset work in dark mode; no separate white
 *    file needed in-app. Use it in dense/monochrome UI (chips, list rows,
 *    picker headers) where the glyph should read as text, not a logo.
 *  - `color`: each brand's own colors (Claude's terracotta sunburst, Codex's
 *    blue-gradient glyph, Grok's black app tile). Use it where the brand should
 *    pop — the Settings account cards.
 *
 * The source artwork is mirrored as raw files under
 * web/public/icons/{claude,openrouter,codex,grok}{,-color,-white}.svg for any
 * external use.
 */
/**
 * Official Grok swirl (the black-hole mark), cropped from the lockup.
 * No wordmark. Shared by the mono and color marks.
 *
 * Native bbox is ~0.364,0.5 33.332×32. Mono fills the 24×24 slot with a
 * hair of inset so the arms stay whole. Color sits a bit smaller so the
 * rounded tile does not clip the tips.
 */
const GROK_GLYPH =
  'M13.237 21.04l11.082-8.19c.543-.4 1.32-.244 1.578.38 1.363 3.288.754 7.241-1.957 9.955-2.71 2.714-6.482 3.31-9.93 1.954l-3.765 1.745c5.401 3.697 11.96 2.782 16.059-1.324 3.251-3.255 4.258-7.692 3.317-11.693l.008.009c-1.365-5.878.336-8.227 3.82-13.031.082-.114.165-.228.247-.345l-4.585 4.59v-.014L13.234 21.044M10.95 23.031c-3.877-3.707-3.208-9.446.1-12.755 2.446-2.449 6.454-3.448 9.952-1.979L24.76 6.56c-.677-.49-1.545-1.017-2.54-1.387A12.465 12.465 0 0 0 8.675 7.901c-3.519 3.523-4.625 8.94-2.725 13.561 1.42 3.454-.907 5.898-3.251 8.364-.83.874-1.664 1.748-2.335 2.674l10.583-9.466';
const GROK_MONO_TRANSFORM = 'translate(12 12) scale(0.68) translate(-17.03 -16.5)';
const GROK_COLOR_TRANSFORM = 'translate(12 12) scale(0.58) translate(-17.03 -16.5)';

export function ProviderIcon({
  provider,
  variant = 'mono',
  className,
}: {
  provider: Provider | string;
  variant?: 'mono' | 'color';
  className?: string;
}) {
  const cls = cn('inline-block shrink-0', className);
  if (provider === 'claude') {
    return (
      <svg viewBox="0 0 24 24" role="img" aria-label="Claude" className={cls}>
        <path
          fillRule={variant === 'color' ? 'nonzero' : 'evenodd'}
          fill={variant === 'color' ? '#D97757' : 'currentColor'}
          d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        />
      </svg>
    );
  }
  if (provider === 'openrouter') {
    return (
      <svg viewBox="0 0 401.4 293.7" role="img" aria-label="OpenRouter" className={cls}>
        <path
          fill={variant === 'color' ? '#7624F4' : 'currentColor'}
          d="M303.9475 17.19926c42.79734 0 77.48933 34.69327 77.48933 77.48933s-34.69199 77.48933-77.48933 77.48933l76.86166 76.86244c9.76367 9.76313 2.84903 26.45667-10.95697 26.45667H148.96884c-71.32686 0-129.14889-57.82202-129.14889-129.14889S77.64197 17.19926 148.96884 17.19926H303.9475ZM148.96884 68.85881c-42.79607 0-77.48933 34.69327-77.48933 77.48933s34.69327 77.48933 77.48933 77.48933 77.48933-34.69327 77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z"
        />
      </svg>
    );
  }
  if (provider === 'grok') {
    // Official swirl. Mono is a bare currentColor glyph; the color variant is
    // the Grok app tile — black square, white mark — which, like Codex's white
    // tile, stays legible on both light and dark cards (a bare near-black
    // glyph would vanish in dark mode).
    return (
      <svg viewBox="0 0 24 24" role="img" aria-label="Grok" className={cls}>
        {variant === 'color' ? (
          <path
            d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"
            fill="#000"
          />
        ) : null}
        <path
          d={GROK_GLYPH}
          fill={variant === 'color' ? '#fff' : 'currentColor'}
          transform={variant === 'color' ? GROK_COLOR_TRANSFORM : GROK_MONO_TRANSFORM}
        />
      </svg>
    );
  }
  // Codex
  if (variant === 'color') {
    return <CodexColor className={cls} />;
  }
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Codex" className={cls}>
      <path
        clipRule="evenodd"
        fillRule="evenodd"
        fill="currentColor"
        d={CODEX_GLYPH}
      />
    </svg>
  );
}

// Codex glyph, shared by both variants so the color mark is the same shape as
// the mono one (no app-tile background: at chat-list size a white tile reads
// as a broken image next to the tile-less Claude mark).
const CODEX_GLYPH =
  'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z';

// The gradient id is per-instance (useId) so multiple marks on one page don't
// collide on a shared `url(#…)` reference (same pattern as VeneerMark's mask).
function CodexColor({ className }: { className?: string }) {
  const gid = useId();
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Codex" className={className}>
      <path clipRule="evenodd" fillRule="evenodd" fill={`url(#${gid})`} d={CODEX_GLYPH} />
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={gid} x1="12" x2="12" y1="0" y2="24">
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}
