import { describe, expect, it, vi } from 'vitest';

import {
  openRestoredConversation,
  projectActionVisibilityClasses,
  projectRowExpanded,
  projectSecondaryActionClasses,
} from './ChatList';
import { archiveGroupKey, archiveGroupLabel } from '../components/ArchivedConversationGroups';

describe('project action visibility', () => {
  it('keeps actions visible when the project is open', () => {
    const classes = projectActionVisibilityClasses(true);

    expect(classes).toContain('opacity-100');
    expect(classes).not.toContain('opacity-0');
    expect(classes).not.toContain('hidden');
  });

  it('keeps inactive project actions hidden until desktop hover or focus', () => {
    const classes = projectActionVisibilityClasses(false);

    expect(classes).toContain('hidden md:inline-flex');
    expect(classes).toContain('md:opacity-0');
    expect(classes).toContain('md:group-hover/project:opacity-100');
    expect(classes).toContain('md:group-focus-within/project:opacity-100');
  });

  it('hides inactive project actions on mobile until the project is tapped open', () => {
    const classes = projectActionVisibilityClasses(false);

    expect(classes.split(' ')).toContain('hidden');
    expect(classes).not.toMatch(/(^|\s)opacity-100/);
  });

  it('uses the requested desktop display class for non-flex elements', () => {
    expect(projectActionVisibilityClasses(false, 'inline-block')).toContain('md:inline-block');
  });

  it('dims secondary actions only while the project is active', () => {
    expect(projectSecondaryActionClasses(true)).toContain('md:opacity-45');
    expect(projectSecondaryActionClasses(false)).toContain('hidden');
    expect(projectSecondaryActionClasses(false)).not.toContain('md:opacity-45');
  });
});

describe('project expansion in the Unread view', () => {
  it('renders a matching project open without persisting that state', () => {
    const persisted = new Set<string>();

    expect(projectRowExpanded('unread', persisted, 'project-1')).toBe(true);
    expect(persisted.has('project-1')).toBe(false);
  });

  it('honours the persisted expanded set in the All view', () => {
    expect(projectRowExpanded('all', new Set(['project-1']), 'project-1')).toBe(true);
    expect(projectRowExpanded('all', new Set(), 'project-1')).toBe(false);
  });
});

describe('restored conversation navigation', () => {
  it('returns to active Chats and opens the restored unfiled conversation', () => {
    const showActiveChats = vi.fn();
    const onOpen = vi.fn();

    openRestoredConversation({ id: 'restored', projectId: null }, showActiveChats, onOpen);

    expect(showActiveChats).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith('restored', undefined);
    expect(showActiveChats.mock.invocationCallOrder[0]).toBeLessThan(onOpen.mock.invocationCallOrder[0]!);
  });

  it('preserves project context when opening a restored project conversation', () => {
    const onOpen = vi.fn();

    openRestoredConversation({ id: 'restored', projectId: 'project-1' }, vi.fn(), onOpen);

    expect(onOpen).toHaveBeenCalledWith('restored', 'project-1');
  });
});

describe('archived project groups', () => {
  it('uses a stable key and friendly label for chats without a project', () => {
    expect(archiveGroupKey(null)).toBe('__unfiled__');
    expect(archiveGroupLabel({ projectId: null, projectName: 'Unfiled' })).toBe('No project');
  });

  it('preserves project identity and names', () => {
    expect(archiveGroupKey('project-1')).toBe('project-1');
    expect(archiveGroupLabel({ projectId: 'project-1', projectName: 'Platform' })).toBe('Platform');
  });
});
