import { describe, expect, it, vi } from 'vitest';
import {
  callProjectSettingsTool,
  PROJECT_SETTINGS_TOOL,
} from '../src/mcp/projectSettingsTool.js';

const SETTINGS_RESPONSE = {
  projectSettings: {
    project: { id: 'project-1', slug: 'alpha', name: 'Alpha' },
    instructions: 'Keep answers concise.',
    appearance: {
      primaryColor: '#111111',
      accentColor: '',
      backgroundColor: '',
      font: '',
      headingFont: '',
      notes: '',
    },
    effectiveAppearance: {
      primaryColor: '#111111',
      accentColor: '#8a6d47',
      backgroundColor: '#faf7f2',
      font: 'Inter',
      headingFont: 'Georgia',
      notes: 'Clean and minimal.',
    },
    typographyGuidance: 'Typography for this page or app:\n- Body text: "Inter" — a Google Fonts family.',
  },
};

describe('project_settings agent tool', () => {
  it('is one discoverable read/update tool with no project id input', () => {
    expect(PROJECT_SETTINGS_TOOL.name).toBe('project_settings');
    expect(PROJECT_SETTINGS_TOOL.description).toContain('explicit request');
    expect(PROJECT_SETTINGS_TOOL.description).toContain('appearance is loaded only when relevant');
    expect(PROJECT_SETTINGS_TOOL.description).toContain('complete revised text');
    expect(PROJECT_SETTINGS_TOOL.description).toContain('New project instructions apply to new chats');
    expect(PROJECT_SETTINGS_TOOL.inputSchema).toMatchObject({
      properties: { instructions: { type: 'string', maxLength: 20000 } },
    });
    expect(JSON.stringify(PROJECT_SETTINGS_TOOL.inputSchema)).not.toMatch(/project.?id/i);
  });

  it('reads instructions and appearance when update fields are omitted', async () => {
    const api = vi.fn().mockResolvedValue(SETTINGS_RESPONSE);
    const result = await callProjectSettingsTool({}, api);
    expect(api).toHaveBeenCalledWith('/api/project-settings', undefined);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Current shared project settings for Alpha.');
    expect(result.content[0]?.text).toContain('Project instructions:\nKeep answers concise.');
    expect(result.content[0]?.text).toContain('Effective design:');
    expect(result.content[0]?.text).toContain('headingFont: Georgia');
    expect(result.content[0]?.text).toContain('Typography for this page or app:');
  });

  it('sends only the requested partial appearance update, including empty clears', async () => {
    const api = vi.fn().mockResolvedValue(SETTINGS_RESPONSE);
    const appearance = { accentColor: '', notes: 'Editorial.' };
    const result = await callProjectSettingsTool({ appearance }, api);
    expect(api).toHaveBeenCalledWith('/api/project-settings', {
      method: 'PATCH',
      body: JSON.stringify({ appearance }),
    });
    expect(result.content[0]?.text).toContain('Updated shared project settings for Alpha.');
    expect(result.content[0]?.text).toContain('Existing published pages and apps are unchanged.');
  });

  it('sends complete instructions alone without changing appearance', async () => {
    const api = vi.fn().mockResolvedValue(SETTINGS_RESPONSE);
    const instructions = 'Keep answers concise.\n\nUse metric units.';
    const result = await callProjectSettingsTool({ instructions }, api);
    expect(api).toHaveBeenCalledWith('/api/project-settings', {
      method: 'PATCH',
      body: JSON.stringify({ instructions }),
    });
    expect(result.content[0]?.text).toContain('Updated shared project settings for Alpha.');
    expect(result.content[0]?.text).toContain('New chats will use the revised project instructions.');
    expect(result.content[0]?.text).toContain('Existing chats keep their fixed snapshot.');
  });

  it('allows empty instructions to clear the saved project context', async () => {
    const api = vi.fn().mockResolvedValue({
      projectSettings: { ...SETTINGS_RESPONSE.projectSettings, instructions: '' },
    });
    const result = await callProjectSettingsTool({ instructions: '' }, api);
    expect(api).toHaveBeenCalledWith('/api/project-settings', {
      method: 'PATCH',
      body: JSON.stringify({ instructions: '' }),
    });
    expect(result.content[0]?.text).toContain('Project instructions:\n(none)');
  });

  it('rejects an empty update before calling the API', async () => {
    const api = vi.fn();
    const result = await callProjectSettingsTool({ appearance: {} }, api);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('at least one appearance field');
    expect(api).not.toHaveBeenCalled();
  });
});
