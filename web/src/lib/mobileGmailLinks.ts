import { isIosNavigator } from './fileDownload';

const ANDROID_USER_AGENT = /Android/i;
const GMAIL_THREAD_ID = /^(?:[a-f\d]{12,}|FMfcgz[A-Za-z\d_-]{6,})$/i;
const IOS_FALLBACK_DELAY_MS = 900;

export type MobileGmailLink = {
  appUrl: string;
  fallbackUrl: string;
  platform: 'ios' | 'android';
};

export type MobileGmailNavigationRuntime = {
  assign: (url: string) => void;
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  setTimer: (listener: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
};

function gmailThreadTarget(href: string): { url: URL; accountId: number; threadId: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com') return null;

  const account = /^\/mail\/u\/(\d+)\//.exec(url.pathname);
  if (!account) return null;

  const hashParts = url.hash.slice(1).split('/').filter(Boolean);
  if (hashParts.length < 2 || hashParts[0] === 'drafts') return null;

  let threadId: string;
  try {
    threadId = decodeURIComponent(hashParts.at(-1) ?? '');
  } catch {
    return null;
  }
  if (!GMAIL_THREAD_ID.test(threadId)) return null;

  // Gmail web numbers accounts from zero; the iOS app scheme numbers them from one.
  return { url, accountId: Number(account[1]) + 1, threadId };
}

/** Returns an app-first target only for exact Gmail message/thread URLs on supported phones. */
export function mobileGmailLinkFor(href: string, navigatorValue: Navigator): MobileGmailLink | null {
  const target = gmailThreadTarget(href);
  if (!target) return null;

  const fallbackUrl = target.url.toString();
  if (isIosNavigator(navigatorValue)) {
    return {
      appUrl: `googlegmail:///cv=${encodeURIComponent(target.threadId)}/accountId=${target.accountId}`,
      fallbackUrl,
      platform: 'ios',
    };
  }
  if (ANDROID_USER_AGENT.test(navigatorValue.userAgent)) {
    const appTarget = `${target.url.host}${target.url.pathname}${target.url.hash}`;
    return {
      appUrl: `intent://${appTarget}#Intent;scheme=https;package=com.google.android.gm;S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`,
      fallbackUrl,
      platform: 'android',
    };
  }
  return null;
}

function browserRuntime(): MobileGmailNavigationRuntime {
  return {
    assign: (url) => window.location.assign(url),
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    setTimer: (listener, delayMs) => window.setTimeout(listener, delayMs),
    clearTimer: (timerId) => window.clearTimeout(timerId),
  };
}

/** Opens Gmail first. iOS needs a timed HTTPS fallback; Android intents carry their own fallback. */
export function openMobileGmailLink(
  target: MobileGmailLink,
  runtime: MobileGmailNavigationRuntime = browserRuntime(),
): void {
  if (target.platform === 'android') {
    try {
      runtime.assign(target.appUrl);
    } catch {
      runtime.assign(target.fallbackUrl);
    }
    return;
  }

  let timerId: number | null = null;
  let unsubscribe = () => {};
  const cleanup = () => {
    if (timerId !== null) runtime.clearTimer(timerId);
    timerId = null;
    unsubscribe();
  };
  const onVisibilityChange = () => {
    if (!runtime.isVisible()) cleanup();
  };

  unsubscribe = runtime.onVisibilityChange(onVisibilityChange);
  timerId = runtime.setTimer(() => {
    const shouldFallback = runtime.isVisible();
    cleanup();
    if (shouldFallback) runtime.assign(target.fallbackUrl);
  }, IOS_FALLBACK_DELAY_MS);

  try {
    runtime.assign(target.appUrl);
  } catch {
    cleanup();
    runtime.assign(target.fallbackUrl);
  }
}
