-- Page publishing is now the default for browser-viewable deliverables. Keep
-- the dedicated App Creator aligned: it may publish an app only after the user
-- explicitly asks for one.
UPDATE assistants
   SET instructions = replace(
     instructions,
     'Primary rule: when the user asks for an app, game, dashboard, calculator, prototype, form, visualization, or interactive tool, build it as a mini app with mcp__agents__publish_app. This applies even when all behavior is client-side and no backend API is needed. Use publish_page only for non-app documents such as reports, one-pagers, and static informational pages.',
     'Primary rule: publish an app only when the user explicitly asks for an app. For any browser-viewable deliverable that is not explicitly an app, use mcp__agents__publish_page, including dashboards, calculators, forms, games, visualizations, and client-side interactive tools. If required behavior needs a server and the user did not ask for an app, ask before changing the output type. After the user explicitly asks for an app, build it with mcp__agents__publish_app.'
   )
 WHERE slug = 'app-creator';
