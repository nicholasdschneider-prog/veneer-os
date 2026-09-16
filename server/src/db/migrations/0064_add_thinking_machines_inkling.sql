-- Add Inkling to existing OpenRouter allowlists without changing their current
-- models, order, defaults, or other preferences.
UPDATE settings
SET value_json = json_insert(
  value_json,
  '$.openrouterModels[#]',
  'thinkingmachines/inkling'
)
WHERE key = 'model_prefs'
  AND json_type(value_json, '$.openrouterModels') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(value_json, '$.openrouterModels')
    WHERE value = 'thinkingmachines/inkling'
  );
