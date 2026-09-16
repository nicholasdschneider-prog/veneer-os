import { describe, expect, it, vi } from 'vitest';
import {
  mobileGmailLinkFor,
  openMobileGmailLink,
  type MobileGmailLink,
  type MobileGmailNavigationRuntime,
} from './mobileGmailLinks';

const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox/19ff75e40fe8a237';

function navigatorWith(userAgent: string, overrides: Partial<Navigator> = {}): Navigator {
  return { userAgent, platform: '', maxTouchPoints: 0, ...overrides } as Navigator;
}

function runtime() {
  const assigned: string[] = [];
  const timers = new Map<number, () => void>();
  let visible = true;
  let visibilityListener = () => {};
  const value: MobileGmailNavigationRuntime = {
    assign: vi.fn((url: string) => assigned.push(url)),
    isVisible: () => visible,
    onVisibilityChange: vi.fn((listener: () => void) => {
      visibilityListener = listener;
      return vi.fn();
    }),
    setTimer: vi.fn((listener: () => void) => {
      timers.set(1, listener);
      return 1;
    }),
    clearTimer: vi.fn((timerId: number) => timers.delete(timerId)),
  };
  return {
    assigned,
    value,
    hide: () => {
      visible = false;
      visibilityListener();
    },
    fireTimer: () => timers.get(1)?.(),
  };
}

describe('mobile Gmail links', () => {
  it('builds an exact-thread Gmail app link for iPhone and desktop-mode iPadOS', () => {
    const expected = 'googlegmail:///cv=19ff75e40fe8a237/accountId=1';
    expect(mobileGmailLinkFor(GMAIL_URL, navigatorWith('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'))?.appUrl).toBe(expected);
    expect(
      mobileGmailLinkFor(
        GMAIL_URL.replace('/u/0/', '/u/2/'),
        navigatorWith('Mozilla/5.0 (Macintosh)', { platform: 'MacIntel', maxTouchPoints: 5 }),
      )?.appUrl,
    ).toBe('googlegmail:///cv=19ff75e40fe8a237/accountId=3');
  });

  it('builds an Android Gmail intent with the original HTTPS URL as its browser fallback', () => {
    const target = mobileGmailLinkFor(GMAIL_URL, navigatorWith('Mozilla/5.0 (Linux; Android 15; Pixel 9)'));
    expect(target?.platform).toBe('android');
    expect(target?.appUrl).toContain('package=com.google.android.gm');
    expect(target?.appUrl).toContain(`S.browser_fallback_url=${encodeURIComponent(GMAIL_URL)}`);
  });

  it('preserves desktop behavior and rejects drafts or non-Gmail lookalikes', () => {
    expect(mobileGmailLinkFor(GMAIL_URL, navigatorWith('Mozilla/5.0 (Macintosh; Intel Mac OS X)'))).toBeNull();
    expect(
      mobileGmailLinkFor('https://mail.google.com/mail/u/0/#drafts/r-4614899335637257196', navigatorWith('Mozilla/5.0 (iPhone)')),
    ).toBeNull();
    expect(
      mobileGmailLinkFor('https://mail.google.com.example/mail/u/0/#inbox/19ff75e40fe8a237', navigatorWith('Mozilla/5.0 (iPhone)')),
    ).toBeNull();
  });

  it('falls back to the exact HTTPS thread when iOS stays visible', () => {
    const target = mobileGmailLinkFor(GMAIL_URL, navigatorWith('Mozilla/5.0 (iPhone)'))!;
    const state = runtime();
    openMobileGmailLink(target, state.value);
    state.fireTimer();
    expect(state.assigned).toEqual([target.appUrl, GMAIL_URL]);
  });

  it('cancels the iOS browser fallback after Gmail takes the page to the background', () => {
    const target = mobileGmailLinkFor(GMAIL_URL, navigatorWith('Mozilla/5.0 (iPhone)'))!;
    const state = runtime();
    openMobileGmailLink(target, state.value);
    state.hide();
    state.fireTimer();
    expect(state.assigned).toEqual([target.appUrl]);
  });

  it('uses the Android intent directly because it contains its own fallback', () => {
    const target: MobileGmailLink = { appUrl: 'intent://gmail', fallbackUrl: GMAIL_URL, platform: 'android' };
    const state = runtime();
    openMobileGmailLink(target, state.value);
    expect(state.assigned).toEqual(['intent://gmail']);
    expect(state.value.setTimer).not.toHaveBeenCalled();
  });

  it('falls back immediately when a browser rejects app-scheme navigation', () => {
    const target: MobileGmailLink = { appUrl: 'intent://gmail', fallbackUrl: GMAIL_URL, platform: 'android' };
    const assigned: string[] = [];
    const state = runtime();
    state.value.assign = vi.fn((url: string) => {
      assigned.push(url);
      if (url === target.appUrl) throw new DOMException('Blocked', 'SecurityError');
    });
    openMobileGmailLink(target, state.value);
    expect(assigned).toEqual([target.appUrl, GMAIL_URL]);
  });
});
