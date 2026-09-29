-- Owner-requested retirement of GPT-6 Sol. Preserve histories, effort, and other models.
UPDATE assistants SET default_model = 'gpt-6.1-sol'
WHERE default_provider = 'codex' AND default_model = 'gpt-6-sol';
UPDATE conversations SET model = 'gpt-6.1-sol'
WHERE provider = 'codex' AND model = 'gpt-6-sol';
UPDATE scheduled_tasks SET model = 'gpt-6.1-sol'
WHERE provider = 'codex' AND model = 'gpt-6-sol';

-- Selection settings only, never frozen instructions, messages, or audit payloads.
UPDATE settings SET value_json = replace(value_json, '"gpt-6-sol"', '"gpt-6.1-sol"')
WHERE key IN ('model_prefs', 'voice_agent_settings');

-- A hidden retired model must not cause its replacement to become hidden.
UPDATE settings SET value_json = json_set(value_json, '$.hiddenModels', json((
  SELECT json_group_array(value) FROM json_each(settings.value_json, '$.hiddenModels')
  WHERE value <> 'codex:gpt-6-sol'
)))
WHERE key = 'model_prefs' AND json_type(value_json, '$.hiddenModels') = 'array';

-- Both versions may already occur in the saved picker order.
UPDATE settings SET value_json = json_set(value_json, '$.modelOrder.codex', json((
  SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(settings.value_json, '$.modelOrder.codex')
    GROUP BY value ORDER BY min(CAST(key AS INTEGER))
  )
)))
WHERE key = 'model_prefs' AND json_type(value_json, '$.modelOrder.codex') = 'array';
