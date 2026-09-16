export type FileDownloadStrategy = 'native' | 'share' | 'external';

export interface FileDownloadEnvironment {
  ios: boolean;
  standalone: boolean;
  fileShare: boolean;
}

interface ShareNavigator extends Pick<Navigator, 'share' | 'canShare'> {
  userActivation?: Pick<UserActivation, 'isActive'>;
}

export function isIosNavigator(navigatorValue: Navigator): boolean {
  if (/iPad|iPhone|iPod/i.test(navigatorValue.userAgent)) return true;

  // iPadOS can request desktop sites and report itself as macOS.
  return navigatorValue.platform === 'MacIntel' && navigatorValue.maxTouchPoints > 1;
}

export function isStandaloneWindow(windowValue: Window, navigatorValue: Navigator): boolean {
  const iosStandalone = (navigatorValue as Navigator & { standalone?: boolean }).standalone === true;
  return windowValue.matchMedia?.('(display-mode: standalone)').matches === true || iosStandalone;
}

export function supportsFileShare(navigatorValue: Navigator): boolean {
  if (typeof navigatorValue.share !== 'function' || typeof navigatorValue.canShare !== 'function') return false;
  if (typeof File !== 'function') return false;

  try {
    return navigatorValue.canShare({ files: [new File([], 'veneer-download.txt', { type: 'text/plain' })] });
  } catch {
    return false;
  }
}

export function currentFileDownloadEnvironment(): FileDownloadEnvironment {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { ios: false, standalone: false, fileShare: false };
  }

  return {
    ios: isIosNavigator(navigator),
    standalone: isStandaloneWindow(window, navigator),
    fileShare: supportsFileShare(navigator),
  };
}

export function selectFileDownloadStrategy(environment: FileDownloadEnvironment): FileDownloadStrategy {
  if (!environment.ios && !environment.standalone) return 'native';
  return environment.fileShare ? 'share' : 'external';
}

function responseMimeType(response: Response, blob: Blob): string {
  if (blob.type) return blob.type;
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
}

export interface ShareDownloadedFileOptions {
  href: string;
  name: string;
  fetchImpl?: typeof fetch;
  navigatorValue?: ShareNavigator;
  FileConstructor?: typeof File;
}

/** Fetches through the authenticated origin, then hands the original file to the OS share sheet. */
export async function shareDownloadedFile({
  href,
  name,
  fetchImpl = fetch,
  navigatorValue = navigator,
  FileConstructor = File,
}: ShareDownloadedFileOptions): Promise<void> {
  const response = await fetchImpl(href, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);

  const blob = await response.blob();
  const file = new FileConstructor([blob], name, { type: responseMimeType(response, blob) });
  if (!navigatorValue.canShare?.({ files: [file] })) throw new Error('File sharing is unavailable');
  // Safari gives transient activation a short timer. A slow fetch can exhaust it,
  // in which case the caller changes into a synchronous separate-window link.
  if (navigatorValue.userActivation && !navigatorValue.userActivation.isActive) {
    throw new Error('File sharing requires a fresh tap');
  }
  await navigatorValue.share({ files: [file], title: name });
}

export function isShareCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
