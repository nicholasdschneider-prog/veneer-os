import { describe, expect, it } from 'vitest';
import { chatViewportStyle, isChatKeyboardActive, shouldDismissChatKeyboard } from './chatViewport';

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
