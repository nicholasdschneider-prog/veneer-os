import type { ComponentProps } from 'react';

const PREVIEW_SANDBOX = [
  'allow-downloads',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-scripts',
].join(' ');

export const UNTRUSTED_PREVIEW_SANDBOX = PREVIEW_SANDBOX;
export const APP_PREVIEW_SANDBOX = `${PREVIEW_SANDBOX} allow-same-origin`;
export const PREVIEW_PERMISSIONS = 'clipboard-write; fullscreen';

interface EmbeddedPreviewFrameProps
  extends Omit<ComponentProps<'iframe'>, 'allow' | 'allowFullScreen' | 'sandbox'> {
  preserveOrigin?: boolean;
}

/** Shared capability policy for user-facing page, app, and HTML previews. */
export function EmbeddedPreviewFrame({ preserveOrigin = false, ...props }: EmbeddedPreviewFrameProps) {
  return (
    <iframe
      {...props}
      sandbox={preserveOrigin ? APP_PREVIEW_SANDBOX : UNTRUSTED_PREVIEW_SANDBOX}
      allow={PREVIEW_PERMISSIONS}
      allowFullScreen
    />
  );
}
