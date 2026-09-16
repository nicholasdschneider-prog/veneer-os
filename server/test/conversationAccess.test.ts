import { describe, expect, it } from 'vitest';
import {
  canChangeConversationVisibility,
  canManageConversation,
  canSendToConversation,
  canViewConversation,
} from '../src/conversations/access.js';

const privateConversation = { user_id: 2, visibility: 'private' as const };

describe('Private-chat creator access', () => {
  it('does not let another user view a Private chat', () => {
    expect(canViewConversation({ id: 1 }, privateConversation)).toBe(false);
    expect(canViewConversation({ id: 3 }, privateConversation)).toBe(false);
  });

  it('keeps another user from sending or managing', () => {
    const member = { id: 1 };
    expect(canSendToConversation(member, privateConversation)).toBe(false);
    expect(canManageConversation(member, privateConversation)).toBe(false);
  });

  it('keeps creator access unchanged', () => {
    const creator = { id: 2 };
    expect(canViewConversation(creator, privateConversation)).toBe(true);
    expect(canSendToConversation(creator, privateConversation)).toBe(true);
    expect(canManageConversation(creator, privateConversation)).toBe(true);
    expect(canChangeConversationVisibility(creator, privateConversation)).toBe(true);
  });

  it('keeps visibility changes with the creator of a Team chat', () => {
    const teamConversation = { user_id: 2, visibility: 'team' as const };
    expect(canManageConversation({ id: 3 }, teamConversation)).toBe(true);
    expect(canChangeConversationVisibility({ id: 3 }, teamConversation)).toBe(false);
    expect(canChangeConversationVisibility({ id: 2 }, teamConversation)).toBe(true);
  });
});
