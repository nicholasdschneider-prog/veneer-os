import { Plug } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Real brand logos for connectors — full-color official SVGs mirrored under
 * web/public/icons/connectors/<slug>.svg — shared by the Connectors screen and
 * the composer's @-mention popup. A catalog slug without an asset falls back
 * to a generic plug tinted with the brand accent color.
 */
const LOGO_SLUGS = new Set([
  'gmail',
  'google_analytics',
  'googleads',
  'googledocs',
  'googledrive',
  'googlesheets',
  'hubspot',
  'netsuite',
  'omnisend',
  'outlook',
  'paper',
  'quickbooks',
  'ringcentral',
  'shopify',
]);

/** Marks whose official color is near-black; invert them on dark backgrounds
 * so they don't vanish (the others carry a brand hue that survives both themes). */
const DARK_MONO_SLUGS = new Set(['omnisend']);

export function ConnectorGlyph({
  slug,
  name,
  className,
}: {
  slug: string;
  name?: string;
  className?: string;
}) {
  if (LOGO_SLUGS.has(slug)) {
    return (
      <img
        src={`/icons/connectors/${slug}.svg`}
        alt={name ?? slug}
        draggable={false}
        className={cn(
          'inline-block shrink-0 object-contain',
          DARK_MONO_SLUGS.has(slug) && 'dark:invert',
          className,
        )}
      />
    );
  }
  return <Plug className={cn('shrink-0 text-brand', className)} />;
}
