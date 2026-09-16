import { useRef, useState, type ComponentProps, type MouseEvent } from 'react';
import { Download, ExternalLink, LoaderCircle } from 'lucide-react';
import type { VariantProps } from 'class-variance-authority';
import {
  currentFileDownloadEnvironment,
  isShareCancellation,
  selectFileDownloadStrategy,
  shareDownloadedFile,
  type FileDownloadStrategy,
} from '../../lib/fileDownload';
import { cn } from '../../lib/utils';
import { buttonVariants } from './button';

type DownloadState = 'idle' | 'preparing' | 'external';

interface FileDownloadLinkProps extends Omit<ComponentProps<'a'>, 'children' | 'download' | 'href'> {
  href: string;
  name: string;
  label?: string;
  showLabel?: boolean;
  buttonVariant?: VariantProps<typeof buttonVariants>['variant'];
  buttonSize?: VariantProps<typeof buttonVariants>['size'];
  iconClassName?: string;
}

function stateLabel(state: DownloadState, label: string): string {
  if (state === 'preparing') return 'Preparing…';
  if (state === 'external') return 'Open separately';
  return label;
}

/** One download surface for desktop browsers, iOS, and installed PWAs. */
export function FileDownloadLink({
  href,
  name,
  label = 'Download',
  showLabel,
  buttonVariant,
  buttonSize,
  iconClassName,
  className,
  onClick,
  ...anchorProps
}: FileDownloadLinkProps) {
  const [state, setState] = useState<DownloadState>('idle');
  const busyRef = useRef(false);
  const selectedStrategy = selectFileDownloadStrategy(currentFileDownloadEnvironment());
  const strategy: FileDownloadStrategy = state === 'external' ? 'external' : selectedStrategy;
  const styledAsButton = buttonVariant !== undefined || buttonSize !== undefined;
  const visibleLabel = showLabel ?? styledAsButton;
  const currentLabel = stateLabel(state, label);
  const accessibleLabel =
    state === 'preparing'
      ? `Preparing ${name}`
      : state === 'external'
        ? `Open ${name} download separately`
        : `${label} ${name}`;

  const handleClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;

    if (busyRef.current) {
      event.preventDefault();
      return;
    }
    if (strategy !== 'share') return;

    event.preventDefault();
    busyRef.current = true;
    setState('preparing');
    try {
      await shareDownloadedFile({ href, name });
      setState('idle');
    } catch (error) {
      if (isShareCancellation(error)) setState('idle');
      else setState('external');
    } finally {
      busyRef.current = false;
    }
  };

  const Icon = state === 'preparing' ? LoaderCircle : state === 'external' ? ExternalLink : Download;
  const status =
    state === 'preparing'
      ? `Preparing ${name}`
      : state === 'external'
        ? `The save sheet was unavailable. Activate again to open ${name} separately.`
        : '';

  return (
    <a
      {...anchorProps}
      href={href}
      download={strategy === 'native' ? name : undefined}
      target={strategy === 'native' ? undefined : '_blank'}
      rel={strategy === 'native' ? undefined : 'noopener noreferrer'}
      aria-label={anchorProps['aria-label'] ?? accessibleLabel}
      aria-busy={state === 'preparing' || undefined}
      aria-disabled={state === 'preparing' || undefined}
      title={state === 'external' ? 'Save menu unavailable. Open the download separately.' : anchorProps.title}
      data-download-strategy={strategy}
      onClick={handleClick}
      className={cn(
        styledAsButton && buttonVariants({ variant: buttonVariant, size: buttonSize }),
        "relative after:absolute after:top-1/2 after:left-1/2 after:size-12 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] pointer-fine:after:hidden",
        state === 'preparing' && 'cursor-wait opacity-70',
        className,
      )}
    >
      <Icon className={cn(state === 'preparing' && 'animate-spin', iconClassName)} />
      {visibleLabel ? currentLabel : null}
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </a>
  );
}
