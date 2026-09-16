-- Mini Apps can now run either as Cloudflare Workers or on the Veneer host.
-- Existing apps stay on Cloudflare; local deployments are supervised by the
-- separate veneer-pro-app-runner service.
ALTER TABLE mini_apps ADD COLUMN runtime TEXT NOT NULL DEFAULT 'cloudflare'
  CHECK (runtime IN ('cloudflare', 'local'));

-- Teach the already-seeded App Creator how to choose the explicit runtime.
UPDATE assistants
   SET instructions = instructions || '

Runtime choice:
- publish_app defaults to runtime "cloudflare". Keep that default for ordinary private apps.
- Use runtime "local" only when the app must execute on this Veneer host or reach local machine resources.
- Preserve the existing runtime when updating an app unless the user explicitly asks to move it.'
 WHERE slug = 'app-creator'
   AND instructions NOT LIKE '%Runtime choice:%';
