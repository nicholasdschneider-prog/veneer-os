-- OpenRouter's rolling Deepseek V4 Flash alias starts with "~". Repair the
-- invalid id introduced by migration 0063 everywhere it can remain selected.
UPDATE settings
SET value_json = replace(
  replace(
    value_json,
    '"deepseek/deepseek-v4-flash-latest"',
    '"~deepseek/deepseek-v4-flash-latest"'
  ),
  '"openrouter:deepseek/deepseek-v4-flash-latest"',
  '"openrouter:~deepseek/deepseek-v4-flash-latest"'
)
WHERE key IN ('model_prefs', 'voice_agent_settings');

UPDATE conversations
SET model = '~deepseek/deepseek-v4-flash-latest'
WHERE provider = 'openrouter'
  AND model = 'deepseek/deepseek-v4-flash-latest';

UPDATE scheduled_tasks
SET model = '~deepseek/deepseek-v4-flash-latest'
WHERE provider = 'openrouter'
  AND model = 'deepseek/deepseek-v4-flash-latest';
