import { describe, expect, it } from 'vitest';
import { chatViewportStyle, deskSheetStyle, isChatKeyboardActive, shouldDismissChatKeyboard } from './chatViewport';

describe('chat viewport sizing', () => {
  it('matches the visual viewport while the iPhone keyboard is open', () => {
    expect(chatViewportStyle(true, { height: 524, offsetTop: 18 })).toEqual({
      height: 'min(524px, 100%)',
      transform: 'translateY(18px)',
    });
  });

  it('restores the full chat height after the composer loses focus', () => {
    expect(chatViewportStyle(false, { height: 524, offsetTop: 18 })).toEqual({
      height: '100%',
      transform: '',
    });
  });

  it('ignores a delayed viewport event after the textarea has blurred', () => {
    const composer = {};
    const activeElement = {};
    const keyboardActive = isChatKeyboardActive(true, composer, activeElement);

    expect(chatViewportStyle(keyboardActive, { height: 524, offsetTop: 18 })).toEqual({
      height: '100%',
      transform: '',
    });
  });

  it('dismisses the keyboard for a touch event', () => {
    expect(shouldDismissChatKeyboard('touch', false)).toBe(true);
  });

  it('dismisses the keyboard on a coarse-pointer device when Safari reports another pointer type', () => {
    expect(shouldDismissChatKeyboard('mouse', true)).toBe(true);
  });

  it('keeps a mouse composer focused on a desktop device', () => {
    expect(shouldDismissChatKeyboard('mouse', false)).toBe(false);
  });
});

describe('desk sheet bounds', () => {
  const vv = { height: 420, width: 390, offsetTop: 24, offsetLeft: 0 };
  it('follows the visual viewport while typing in the sheet', () => {
    expect(deskSheetStyle(true, true, vv)).toEqual({ inset: 'auto', top: '24px', left: '0px', width: '390px', height: '420px' });
  });
  it('leaves the full-screen and docked layouts to CSS otherwise', () => {
    expect(deskSheetStyle(true, false, vv)).toBeUndefined();
    expect(deskSheetStyle(false, true, vv)).toBeUndefined();
    expect(deskSheetStyle(true, true, null)).toBeUndefined();
  });
});
