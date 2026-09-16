import { describe, expect, it, vi } from 'vitest';
import {
  chatActionLabels,
  chatDeleteConfirmation,
  chatHeaderMenuLabels,
  chatShareUrl,
  copyChatShareUrl,
} from './chatDeletion';

describe('chatActionLabels', () => {
  it('contains pin, archive, and delete for an active unpinned chat', () => {
    expect(chatActionLabels(false, false)).toEqual({
      pin: 'Pin chat',
      archive: 'Archive chat',
      delete: 'Delete chat…',
    });
  });

  it('adapts pin and archive actions to current state', () => {
    expect(chatActionLabels(true, true)).toEqual({
      pin: 'Unpin chat',
      archive: 'Move to Chats',
      delete: 'Delete chat…',
    });
  });
});

describe('chatHeaderMenuLabels', () => {
  it('includes Chat info and management actions for chat managers', () => {
    expect(chatHeaderMenuLabels(true, false)).toEqual({
      info: 'Chat info',
      copyLink: 'Copy link',
      manage: {
        pin: 'Pin chat',
        delete: 'Delete chat…',
      },
    });
  });

  it('keeps Unpin in the menu without duplicating the dedicated archive action', () => {
    expect(chatHeaderMenuLabels(true, true)).toEqual({
      info: 'Chat info',
      copyLink: 'Copy link',
      manage: {
        pin: 'Unpin chat',
        delete: 'Delete chat…',
      },
    });
  });

  it('keeps Chat info while hiding management actions from viewers without management permission', () => {
    expect(chatHeaderMenuLabels(false, false)).toEqual({
      info: 'Chat info',
      copyLink: 'Copy link',
      manage: null,
    });
  });
});

describe('chatShareUrl', () => {
  const location = { origin: 'https://lps.veneer.app', pathname: '/' };

  it('builds a chat URL without a project', () => {
    expect(chatShareUrl(location, 'chat-1')).toBe('https://lps.veneer.app/#/chat/chat-1');
  });

  it('keeps the project query and drops transient params', () => {
    expect(chatShareUrl(location, 'chat-1', 'project-1')).toBe(
      'https://lps.veneer.app/#/chat/chat-1?project=project-1',
    );
    expect(chatShareUrl(location, 'chat-1', 'project-1')).not.toMatch(
      /artifact|files|browser|panel|from/,
    );
  });
});

describe('copyChatShareUrl', () => {
  it('writes the canonical project chat URL to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await copyChatShareUrl(
      { writeText },
      { origin: 'https://lps.veneer.app', pathname: '/' },
      'chat-1',
      'project-1',
    );

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(
      'https://lps.veneer.app/#/chat/chat-1?project=project-1',
    );
  });

  it('rejects cleanly when the browser clipboard API is unavailable', async () => {
    await expect(
      copyChatShareUrl(
        undefined,
        { origin: 'https://lps.veneer.app', pathname: '/' },
        'chat-1',
      ),
    ).rejects.toThrow('Clipboard API unavailable');
  });
});

describe('chatDeleteConfirmation', () => {
  it('warns that Team chat deletion affects everyone', () => {
    expect(chatDeleteConfirmation({ visibility: 'team', status: 'idle' })).toEqual({
      title: 'Delete for everyone?',
      description: 'Everyone on your team will permanently lose access to this chat. This can’t be undone.',
      actionLabel: 'Delete for everyone',
    });
  });

  it('keeps Private chat confirmation personal', () => {
    expect(chatDeleteConfirmation({ visibility: 'private', status: 'idle' })).toEqual({
      title: 'Delete this chat?',
      description: 'This chat will be permanently deleted. This can’t be undone.',
      actionLabel: 'Delete chat',
    });
  });

  it('warns that deleting a working chat stops its agent', () => {
    expect(chatDeleteConfirmation({ visibility: 'team', status: 'working' }).description).toContain(
      'The agent is still working and will be stopped.',
    );
  });
});
