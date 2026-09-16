import { describe, expect, it } from 'vitest';
import { canUserAccessModel, isUserScopedModel, modelsVisibleToUser } from '../src/routes/modelAccess.js';

const catalog = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { id: 'gpt-daybreak-blue-latest', label: 'Daybreak Blue' },
];

describe('user-scoped model access', () => {
  it('leaves every model shared on a stock install', () => {
    expect(modelsVisibleToUser('owner@example.com', 'codex', catalog)).toEqual(catalog);
    for (const model of catalog) {
      expect(canUserAccessModel('member@example.com', 'codex', model.id)).toBe(true);
      expect(isUserScopedModel('codex', model.id)).toBe(false);
    }
  });

  it('treats a missing model as unrestricted', () => {
    expect(canUserAccessModel('member@example.com', 'codex', null)).toBe(true);
  });
});
