import { describe, expect, it } from 'vitest';
import { composerHasSendableContent, composerTrailingAction } from './composerTrailingAction';

describe('composer sendable content', () => {
  it('ignores an empty or whitespace-only draft', () => {
    expect(composerHasSendableContent({ draft: '', hasReadyAttachment: false, dictationActive: false })).toBe(
      false,
    );
    expect(composerHasSendableContent({ draft: '   ', hasReadyAttachment: false, dictationActive: false })).toBe(
      false,
    );
  });

  it('counts typed text, a ready attachment, or live dictation', () => {
    expect(composerHasSendableContent({ draft: 'hi', hasReadyAttachment: false, dictationActive: false })).toBe(
      true,
    );
    expect(composerHasSendableContent({ draft: '', hasReadyAttachment: true, dictationActive: false })).toBe(true);
    expect(composerHasSendableContent({ draft: '', hasReadyAttachment: false, dictationActive: true })).toBe(true);
  });
});

describe('composer trailing action', () => {
  it('hides send on an empty idle composer', () => {
    expect(
      composerTrailingAction({
        hasSendableContent: false,
        working: false,
        canManage: true,
        turnInFlight: false,
      }),
    ).toBe('hidden');
  });

  it('shows send when there is something to send', () => {
    expect(
      composerTrailingAction({
        hasSendableContent: true,
        working: false,
        canManage: true,
        turnInFlight: false,
      }),
    ).toBe('send');
  });

  it('keeps send visible while typing during a turn so the next message can queue', () => {
    expect(
      composerTrailingAction({
        hasSendableContent: true,
        working: true,
        canManage: true,
        turnInFlight: true,
      }),
    ).toBe('send');
  });

  it('shows stop when the agent is working and the composer is empty', () => {
    expect(
      composerTrailingAction({
        hasSendableContent: false,
        working: true,
        canManage: true,
        turnInFlight: true,
      }),
    ).toBe('stop');
  });

  it('reserves the send slot after submit before working flips', () => {
    expect(
      composerTrailingAction({
        hasSendableContent: false,
        working: false,
        canManage: true,
        turnInFlight: true,
      }),
    ).toBe('send');
  });

  it('hides send for viewers who cannot manage an in-flight empty turn', () => {
    expect(
      composerTrailingAction({
        hasSendableContent: false,
        working: true,
        canManage: false,
        turnInFlight: true,
      }),
    ).toBe('hidden');
  });
});
