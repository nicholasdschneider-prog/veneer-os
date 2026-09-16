import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectDialog } from './NewProjectDialog';
import { api } from '../lib/api';

// Drive the form's handlers without a DOM, retaining state between renders.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.values.length) hooks.values.push(initial);
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  },
}));
vi.mock('../lib/api', () => ({ api: { createProject: vi.fn() } }));

function find(node: ReactNode, predicate: (props: Record<string, any>) => boolean): Record<string, any> | null {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result; }
  } else if (isValidElement<Record<string, any>>(node)) {
    if (predicate(node.props)) return node.props;
    return find(node.props.children, predicate);
  }
  return null;
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; vi.clearAllMocks(); });

describe('new project folder selection for every role', () => {
  it.each([true, false])('submits the selected custom folder (clear selection: %s)', async (clear) => {
    const project = {
      id: 'new-project', slug: 'member-project', name: 'Member Project', instructions: '',
      appearance: { primaryColor: '', accentColor: '', backgroundColor: '', font: '', notes: '' },
      rootDir: clear ? null : '/srv/projects/member-chosen', defaultAgent: null, sortOrder: 0,
      createdAt: '2026-09-11T00:00:00Z', chatCount: 0, lastActiveAt: null,
    };
    vi.mocked(api.createProject).mockResolvedValue({ project });
    const onCreated = vi.fn();
    const render = () => {
      hooks.cursor = 0;
      return NewProjectDialog({ open: true, onOpenChange: vi.fn(), onCreated });
    };
    let tree = render();
    find(tree, (props) => props.placeholder === 'e.g. Q3 Marketing')!.onChange({ target: { value: ' Member Project ' } });
    find(tree, (props) => props['aria-label'] === 'Choose project folder')!.onPointerUp();
    tree = render();
    const picker = find(tree, (props) => typeof props.onSelect === 'function')!;
    expect(picker).not.toBeNull();
    picker.onSelect('/srv/projects/member-chosen');
    tree = render();
    expect(find(tree, (props) => props.title === '/srv/projects/member-chosen')).not.toBeNull();
    if (clear) {
      find(tree, (props) => props['aria-label'] === 'Use default folder')!.onPointerUp();
      tree = render();
    }
    find(tree, (props) => props.children === 'Create')!.onPointerUp();
    await Promise.resolve();
    expect(api.createProject).toHaveBeenCalledWith({
      name: 'Member Project', instructions: undefined,
      rootDir: clear ? undefined : '/srv/projects/member-chosen',
    });
    expect(onCreated).toHaveBeenCalledWith(project);
  });
});
