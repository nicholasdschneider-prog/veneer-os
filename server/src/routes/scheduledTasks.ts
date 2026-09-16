import crypto from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import {
  publicTriggerRecipes,
  triggerRecipe,
  validateAutomationFilters,
} from '../automations/recipes.js';
import {
  createComposioTrigger,
  deleteComposioTrigger,
  listSlackDirectMessages,
  setComposioTriggerEnabled,
} from '../connectors/composio.js';
import { connectorDef, type ComposioInstallConfig } from '../connectors/catalog.js';
import type { AppContext } from '../context.js';
import type {
  AssistantRow,
  ConversationRow,
  ScheduledTaskRow,
  ScheduledTaskRunRow,
  UserConnectorRow,
} from '../db/db.js';
import { canUserAccessModel, modelsVisibleToUser } from './modelAccess.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';
import {
  DEFAULT_SCHEDULE_TIME_ZONE,
  describeSchedule,
  isValidTimeZone,
  nextOccurrence,
  nextOccurrences,
  parseScheduleSpec,
  type ScheduleSpec,
} from '../scheduled/schedule.js';

const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const ProviderSchema = z.enum(['claude', 'openrouter', 'codex', 'grok']);
const ScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), runAt: z.string().datetime({ offset: true }) }),
  z.object({ type: z.literal('daily'), time: TimeSchema }),
  z.object({ type: z.literal('weekdays'), time: TimeSchema }),
  z.object({ type: z.literal('weekly'), time: TimeSchema, weekday: z.number().int().min(0).max(6) }),
  z.object({ type: z.literal('cron'), expression: z.string().trim().min(1).max(200) }),
]);
const CreateBaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
  sourceConversationId: z.string().trim().min(1).max(100).optional(),
  assistantSlug: z.string().trim().min(1).max(100).optional(),
  provider: ProviderSchema.optional(),
  model: z.string().trim().min(1).max(100).nullable().optional(),
  effort: z.string().trim().min(1).max(40).nullable().optional(),
  projectId: z.string().trim().min(1).max(64).nullable().optional(),
});
const CreateSchema = z.union([
  CreateBaseSchema.extend({
    triggerKind: z.literal('schedule').optional().default('schedule'),
    schedule: ScheduleSchema,
    timezone: z.string().trim().min(1).max(100).default(DEFAULT_SCHEDULE_TIME_ZONE),
  }),
  CreateBaseSchema.extend({
    triggerKind: z.literal('event'),
    recipe: z.string().trim().min(1).max(100),
    connectorId: z.number().int().positive(),
    triggerConfig: z.record(z.unknown()),
    filters: z.array(z.record(z.unknown())).max(10).default([]),
  }),
]);
const PatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).max(100_000).optional(),
    schedule: ScheduleSchema.optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    pinned: z.boolean().optional(),
    projectId: z.string().trim().min(1).max(64).nullable().optional(),
    filters: z.array(z.record(z.unknown())).max(10).optional(),
    assistantSlug: z.string().trim().min(1).max(100).optional(),
    provider: ProviderSchema.optional(),
    model: z.string().trim().min(1).max(100).nullable().optional(),
    effort: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'no fields');

type RunWithTitle = ScheduledTaskRunRow & { conversation_title: string | null };

export interface ScheduledTaskRouteDependencies {
  createComposioTrigger?: typeof createComposioTrigger;
  setComposioTriggerEnabled?: typeof setComposioTriggerEnabled;
  deleteComposioTrigger?: typeof deleteComposioTrigger;
  listSlackDirectMessages?: typeof listSlackDirectMessages;
}

export function createScheduledTasksRouter(
  ctx: AppContext,
  deps: ScheduledTaskRouteDependencies = {},
): Router {
  const { db, manager } = ctx;
  const router = express.Router();
  const startTrigger = deps.createComposioTrigger ?? createComposioTrigger;
  const changeTrigger = deps.setComposioTriggerEnabled ?? setComposioTriggerEnabled;
  const removeTrigger = deps.deleteComposioTrigger ?? deleteComposioTrigger;
  const loadSlackDms = deps.listSlackDirectMessages ?? listSlackDirectMessages;

  const taskForUser = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?');
  const recentRuns = db.prepare(
    `SELECT r.*, c.title AS conversation_title
     FROM scheduled_task_runs r
     LEFT JOIN conversations c ON c.id = r.conversation_id
     WHERE r.scheduled_task_id = ?
     ORDER BY r.started_at DESC LIMIT 5`,
  );
  const allRuns = db.prepare(
    `SELECT r.*, c.title AS conversation_title
     FROM scheduled_task_runs r
     LEFT JOIN conversations c ON c.id = r.conversation_id
     WHERE r.scheduled_task_id = ?
     ORDER BY r.started_at DESC, r.rowid DESC`,
  );
  const projectName = db.prepare('SELECT name FROM projects WHERE id = ?');
  const assistantInfo = db.prepare('SELECT slug, name FROM assistants WHERE id = ?');

  function runView(run: RunWithTitle): Record<string, unknown> {
    return {
      id: run.id,
      conversationId: run.conversation_id,
      conversationTitle: run.conversation_title,
      scheduledFor: run.scheduled_for,
      trigger: run.trigger,
      status: run.status,
      important: run.important === 1,
      eventId: run.event_id,
      error: run.error,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
    };
  }

  function taskView(task: ScheduledTaskRow): Record<string, unknown> {
    const schedule = task.trigger_kind === 'schedule' ? parseScheduleSpec(task.schedule_json) : null;
    const runs = recentRuns.all(task.id) as RunWithTitle[];
    const recipe = task.trigger_recipe ? triggerRecipe(task.trigger_recipe) : null;
    const assistant = assistantInfo.get(task.assistant_id) as { slug: string; name: string } | undefined;
    const upcomingRuns = schedule && task.enabled === 1 && task.next_run_at
      ? [
          task.next_run_at,
          ...nextOccurrences(schedule, task.timezone, new Date(task.next_run_at), 2).map((date) => date.toISOString()),
        ]
      : [];
    return {
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      assistantSlug: assistant?.slug ?? null,
      assistantName: assistant?.name ?? null,
      provider: task.provider,
      model: task.model,
      effort: task.effort,
      triggerKind: task.trigger_kind,
      schedule,
      scheduleText: schedule ? describeSchedule(schedule, task.timezone) : recipe?.name ?? 'Event trigger',
      timezone: task.timezone,
      recipe: task.trigger_recipe,
      connectorId: task.connector_id,
      triggerConfig: JSON.parse(task.trigger_config_json) as Record<string, unknown>,
      filters: JSON.parse(task.filter_json) as unknown[],
      triggerStatus: task.trigger_status,
      triggerError: task.trigger_error,
      enabled: task.enabled === 1,
      pinned: task.pin_order !== null,
      projectId: task.project_id,
      projectName: task.project_id
        ? ((projectName.get(task.project_id) as { name: string } | undefined)?.name ?? null)
        : null,
      nextRunAt: task.next_run_at,
      upcomingRuns,
      lastRunAt: task.last_run_at,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      recentRuns: runs.map(runView),
    };
  }

  function validProject(projectId: string | null, res: Response): boolean {
    if (projectId === null || db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return true;
    res.status(400).json({ ok: false, error: 'Unknown project' });
    return false;
  }

  function validateTiming(schedule: ScheduleSpec, timezone: string, res: Response): Date | null | undefined {
    if (!isValidTimeZone(timezone)) {
      res.status(400).json({ ok: false, error: 'Unknown timezone' });
      return undefined;
    }
    let next: Date | null;
    try {
      next = nextOccurrence(schedule, timezone, new Date());
    } catch {
      res.status(400).json({ ok: false, error: 'Invalid or impossible schedule' });
      return undefined;
    }
    if (!next) {
      res.status(400).json({ ok: false, error: 'The one-time schedule must be in the future' });
      return undefined;
    }
    return next;
  }

  function composioKey(): string | null {
    return effectiveApiKey('composio', ctx.secrets, ctx.config, ctx.doppler).value;
  }

  function ownedComposioConnector(req: Request, connectorId: number): {
    row: UserConnectorRow;
    install: ComposioInstallConfig;
  } | null {
    const row = db
      .prepare(
        `SELECT * FROM user_connectors
         WHERE id = ? AND user_id = ? AND sharing = 'personal' AND status = 'connected'`,
      )
      .get(connectorId, req.user!.id) as UserConnectorRow | undefined;
    if (!row || connectorDef(row.connector_slug)?.kind !== 'composio') return null;
    try {
      const install = JSON.parse(row.config_json) as ComposioInstallConfig;
      return install.connectedAccountId && install.sessionId ? { row, install } : null;
    } catch {
      return null;
    }
  }

  type Execution = {
    assistantId: number;
    projectId: string | null;
    provider: ConversationRow['provider'];
    model: string | null;
    effort: string | null;
  };

  function readModelPrefs(): Record<string, unknown> {
    try {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = 'model_prefs'").get() as
        | { value_json: string }
        | undefined;
      return row ? (JSON.parse(row.value_json) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  function availableAssistants(req: Request): AssistantRow[] {
    return (
      db.prepare('SELECT * FROM assistants WHERE deleted_at IS NULL ORDER BY id').all() as AssistantRow[]
    ).filter(
      (candidate) => req.user!.role !== 'member' || !['platform-dev', 'skill-smith'].includes(candidate.slug),
    );
  }

  function executionForAssistant(
    req: Request,
    assistant: AssistantRow,
    prefs: Record<string, unknown>,
    requestedEffort?: string | null,
  ): Execution {
    const agents = prefs.agents as Record<string, Record<string, unknown>> | undefined;
    const agent = agents?.[assistant.slug];
    const configuredProvider =
      typeof agent?.provider === 'string'
        ? agent.provider
        : typeof prefs.defaultProvider === 'string'
          ? prefs.defaultProvider
          : assistant.default_provider;
    const provider = ['claude', 'openrouter', 'codex', 'grok'].includes(configuredProvider)
      ? configuredProvider as ConversationRow['provider']
      : assistant.default_provider;
    const providerDefaults = prefs.providerDefaults as Record<string, unknown> | undefined;
    const configuredModel =
      typeof agent?.model === 'string'
        ? agent.model
        : typeof providerDefaults?.[provider] === 'string'
          ? providerDefaults[provider] as string
          : assistant.default_model;
    const model = canUserAccessModel(req.user!.email, provider, configuredModel) ? configuredModel : null;
    const effort =
      requestedEffort !== undefined
        ? requestedEffort
        : typeof agent?.effort === 'string'
          ? agent.effort
          : typeof prefs.defaultEffort === 'string'
            ? prefs.defaultEffort
            : null;
    return { assistantId: assistant.id, projectId: null, provider, model, effort };
  }

  function defaults(
    req: Request,
    sourceConversationId?: string,
  ): Execution | null {
    const prefs = readModelPrefs();
    const allowed = availableAssistants(req);
    const source = sourceConversationId
      ? db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(
          sourceConversationId,
          req.user!.id,
        ) as ConversationRow | undefined
      : undefined;
    if (sourceConversationId && !source) return null;
    if (source) {
      return {
        assistantId: source.assistant_id,
        projectId: source.project_id,
        provider: source.provider,
        model: source.model,
        effort: source.effort,
      };
    }

    const preferredSlug = typeof prefs?.defaultAgent === 'string' ? prefs.defaultAgent : 'assistant';
    const fallback =
      allowed.find((candidate) => candidate.slug === preferredSlug) ??
      allowed.find((candidate) => candidate.slug === 'assistant') ??
      allowed.find((candidate) => !['platform-dev', 'skill-smith'].includes(candidate.slug)) ??
      allowed[0];
    if (!fallback) return null;
    return executionForAssistant(req, fallback, prefs);
  }

  function applyExecutionChoice(
    req: Request,
    execution: Execution,
    choice: { provider?: ConversationRow['provider']; model?: string | null; effort?: string | null },
  ): Execution {
    const provider = choice.provider ?? execution.provider;
    let model = execution.model;
    if (choice.provider !== undefined) {
      const prefs = readModelPrefs();
      const defaults = prefs.providerDefaults as Record<string, unknown> | undefined;
      model = choice.model !== undefined
        ? choice.model
        : typeof defaults?.[provider] === 'string'
          ? defaults[provider] as string
          : null;
      if (choice.model === undefined && !canUserAccessModel(req.user!.email, provider, model)) model = null;
    } else if (choice.model !== undefined) {
      model = choice.model;
    }
    return {
      ...execution,
      provider,
      model,
      effort: choice.effort === undefined ? execution.effort : choice.effort,
    };
  }

  async function executionChoiceError(
    req: Request,
    execution: Execution,
    validateModel: boolean,
    validateEffort: boolean,
  ): Promise<string | null> {
    if (!canUserAccessModel(req.user!.email, execution.provider, execution.model)) {
      return 'This model is not available for the selected provider';
    }
    if (!validateModel && (!validateEffort || !execution.effort)) return null;
    if (typeof ctx.manager.listModels !== 'function') return null;
    try {
      const models = modelsVisibleToUser(
        req.user!.email,
        execution.provider,
        await ctx.manager.listModels(execution.provider),
      );
      if (validateModel && execution.model && models.length > 0 && !models.some((candidate) => candidate.id === execution.model)) {
        return 'This model is not available for the selected provider';
      }
      const selected =
        (execution.model ? models.find((candidate) => candidate.id === execution.model) : undefined) ??
        models.find((candidate) => candidate.isDefault);
      if (validateEffort && execution.effort && selected?.efforts?.length && !selected.efforts.includes(execution.effort)) {
        return 'This thinking level is not supported by the selected model';
      }
      return null;
    } catch {
      // If the live catalog is unavailable, keep the saved value usable. The
      // provider remains the final authority, as it is for normal chats.
      return null;
    }
  }

  router.get('/', (req, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM scheduled_tasks WHERE user_id = ?
         ORDER BY (pin_order IS NULL), pin_order, enabled DESC, created_at DESC`,
      )
      .all(req.user!.id) as ScheduledTaskRow[];
    const summary = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN r.status IN ('queued','running') THEN 1 ELSE 0 END), 0) AS running,
           COALESCE(SUM(CASE WHEN r.status IN ('needs_you','failed') AND r.id = (
             SELECT latest.id FROM scheduled_task_runs latest
             WHERE latest.scheduled_task_id = r.scheduled_task_id
             ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1
           ) THEN 1 ELSE 0 END), 0) AS needsAttention,
           COALESCE(SUM(CASE WHEN r.status = 'completed'
             AND datetime(r.finished_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END), 0) AS recentlyCompleted
         FROM scheduled_task_runs r
         JOIN scheduled_tasks t ON t.id = r.scheduled_task_id
         WHERE t.user_id = ?`,
      )
      .get(req.user!.id) as { running: number; needsAttention: number; recentlyCompleted: number };
    res.json({ ok: true, scheduledTasks: rows.map(taskView), summary });
  });

  router.get('/trigger-recipes', (_req, res) => {
    res.json({
      ok: true,
      recipes: publicTriggerRecipes().filter((recipe) => connectorDef(recipe.toolkit)?.kind === 'composio'),
    });
  });

  router.get('/trigger-options/slack-dms', (req, res) => {
    const connectorId = Number(req.query.connectorId);
    const connector = ownedComposioConnector(req, connectorId);
    const apiKey = composioKey();
    if (!connector || connector.row.connector_slug !== 'slack') {
      res.status(404).json({ ok: false, error: 'Connected Slack account not found' });
      return;
    }
    if (!apiKey) {
      res.status(503).json({ ok: false, error: 'Composio is not configured' });
      return;
    }
    void loadSlackDms(apiKey, connector.install.sessionId)
      .then((options) => res.json({ ok: true, options }))
      .catch(() => res.status(502).json({ ok: false, error: 'Slack DM conversations could not be loaded' }));
  });

  router.post('/', async (req, res) => {
    const body = CreateSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid scheduled task' });
      return;
    }
    const timezone =
      body.data.triggerKind === 'event' ? DEFAULT_SCHEDULE_TIME_ZONE : body.data.timezone;
    const next =
      body.data.triggerKind === 'event'
        ? null
        : validateTiming(body.data.schedule, timezone, res);
    if (next === undefined) return;
    const inheritedExecution = defaults(req, body.data.sourceConversationId);
    if (!inheritedExecution) {
      const sourceMissing = Boolean(
        body.data.sourceConversationId &&
        !db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(
          body.data.sourceConversationId,
          req.user!.id,
        ),
      );
      res.status(sourceMissing ? 404 : 400).json({
        ok: false,
        error: sourceMissing ? 'Source conversation not found' : 'No agent is available',
      });
      return;
    }
    let defaultExecution = inheritedExecution;
    if (body.data.assistantSlug) {
      const assistant = availableAssistants(req).find((candidate) => candidate.slug === body.data.assistantSlug);
      if (!assistant) {
        res.status(400).json({ ok: false, error: 'This agent is not available' });
        return;
      }
      defaultExecution = {
        ...executionForAssistant(req, assistant, readModelPrefs()),
        projectId: inheritedExecution.projectId,
      };
    }
    const execution = applyExecutionChoice(req, defaultExecution, body.data);
    const choiceError = await executionChoiceError(
      req,
      execution,
      body.data.provider !== undefined || body.data.model !== undefined,
      body.data.effort !== undefined,
    );
    if (choiceError) {
      res.status(400).json({ ok: false, error: choiceError });
      return;
    }
    const projectId = body.data.projectId === undefined ? execution.projectId : body.data.projectId;
    if (!validProject(projectId, res)) return;
    const id = crypto.randomUUID();
    if (body.data.triggerKind === 'event') {
      const eventData = body.data;
      const recipe = triggerRecipe(eventData.recipe);
      const connector = ownedComposioConnector(req, eventData.connectorId);
      const apiKey = composioKey();
      if (!recipe || !connector || connector.row.connector_slug !== recipe.toolkit) {
        res.status(400).json({ ok: false, error: 'Invalid event trigger source' });
        return;
      }
      if (!apiKey) {
        res.status(503).json({ ok: false, error: 'Composio is not configured' });
        return;
      }
      let config: Record<string, unknown>;
      let filters: unknown[];
      try {
        config = recipe.configSchema.parse(eventData.triggerConfig);
        filters = validateAutomationFilters(recipe, eventData.filters);
      } catch (err) {
        res.status(400).json({ ok: false, error: (err as Error).message });
        return;
      }
      db.prepare(
        `INSERT INTO scheduled_tasks
         (id, user_id, assistant_id, project_id, name, prompt, schedule_json, timezone,
          provider, model, effort, next_run_at, enabled, trigger_kind, connector_id,
          trigger_recipe, trigger_config_json, filter_json, trigger_status)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, NULL, 0, 'event', ?, ?, ?, ?, 'syncing')`,
      ).run(
        id,
        req.user!.id,
        execution.assistantId,
        projectId,
        eventData.name,
        eventData.prompt,
        timezone,
        execution.provider,
        execution.model,
        execution.effort,
        connector.row.id,
        recipe.id,
        JSON.stringify(config),
        JSON.stringify(filters),
      );
      void startTrigger(
        apiKey,
        connector.install.composioUserId ?? req.user!.email,
        connector.install.connectedAccountId,
        recipe.triggerSlug,
        recipe.providerConfig(config),
      )
        .then((created) => {
          db.prepare(
            `UPDATE scheduled_tasks
             SET external_trigger_id = ?, trigger_status = 'ready', trigger_error = NULL,
                 enabled = 1, updated_at = datetime('now')
             WHERE id = ?`,
          ).run(created.triggerId, id);
          res.status(201).json({
            ok: true,
            scheduledTask: taskView(taskForUser.get(id, req.user!.id) as ScheduledTaskRow),
          });
        })
        .catch((err: Error) => {
          db.prepare(
            `UPDATE scheduled_tasks
             SET trigger_status = 'error', trigger_error = ?, enabled = 0, updated_at = datetime('now')
             WHERE id = ?`,
          ).run(err.message.slice(0, 1_000), id);
          res.status(502).json({
            ok: false,
            error: 'Composio could not create the Slack trigger',
            scheduledTask: taskView(taskForUser.get(id, req.user!.id) as ScheduledTaskRow),
          });
        });
      return;
    }
    db.prepare(
      `INSERT INTO scheduled_tasks
       (id, user_id, assistant_id, project_id, name, prompt, schedule_json, timezone, provider, model, effort, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      req.user!.id,
      execution.assistantId,
      projectId,
      body.data.name,
      body.data.prompt,
      JSON.stringify(body.data.schedule),
      timezone,
      execution.provider,
      execution.model,
      execution.effort,
      next!.toISOString(),
    );
    const task = taskForUser.get(id, req.user!.id) as ScheduledTaskRow;
    res.status(201).json({ ok: true, scheduledTask: taskView(task) });
  });

  router.get('/:id', (req, res) => {
    const task = taskForUser.get(req.params.id, req.user!.id) as ScheduledTaskRow | undefined;
    if (!task) {
      res.status(404).json({ ok: false, error: 'Scheduled task not found' });
      return;
    }
    res.json({ ok: true, scheduledTask: taskView(task) });
  });

  router.patch('/:id', async (req, res) => {
    const body = PatchSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid scheduled task update' });
      return;
    }
    const task = taskForUser.get(req.params.id, req.user!.id) as ScheduledTaskRow | undefined;
    if (!task) {
      res.status(404).json({ ok: false, error: 'Scheduled task not found' });
      return;
    }
    if (task.trigger_kind === 'event' && (body.data.schedule || body.data.timezone)) {
      res.status(400).json({ ok: false, error: 'Event automations do not have schedules' });
      return;
    }
    const requestedAssistant = body.data.assistantSlug
      ? availableAssistants(req).find((candidate) => candidate.slug === body.data.assistantSlug)
      : undefined;
    if (body.data.assistantSlug && !requestedAssistant) {
      res.status(400).json({ ok: false, error: 'This agent is not available' });
      return;
    }
    const execution = applyExecutionChoice(req, {
      assistantId: requestedAssistant?.id ?? task.assistant_id,
      projectId: task.project_id,
      provider: task.provider,
      model: task.model,
      effort: task.effort,
    }, body.data);
    const choiceError = await executionChoiceError(
      req,
      execution,
      body.data.provider !== undefined || body.data.model !== undefined,
      body.data.effort !== undefined,
    );
    if (choiceError) {
      res.status(400).json({ ok: false, error: choiceError });
      return;
    }
    const schedule = task.trigger_kind === 'schedule'
      ? body.data.schedule ?? parseScheduleSpec(task.schedule_json)
      : null;
    const timezone = body.data.timezone ?? task.timezone;
    const projectId = body.data.projectId === undefined ? task.project_id : body.data.projectId;
    if (!validProject(projectId, res)) return;
    let nextRunAt = task.next_run_at;
    const enabling = body.data.enabled === true && task.enabled === 0;
    if (task.trigger_kind === 'schedule' && (body.data.schedule || body.data.timezone || enabling)) {
      const next = validateTiming(schedule!, timezone, res);
      if (next === undefined) return;
      nextRunAt = next!.toISOString();
    }
    let filtersJson = task.filter_json;
    if (body.data.filters) {
      const recipe = task.trigger_recipe ? triggerRecipe(task.trigger_recipe) : null;
      if (!recipe) {
        res.status(400).json({ ok: false, error: 'Unknown event trigger recipe' });
        return;
      }
      try {
        filtersJson = JSON.stringify(validateAutomationFilters(recipe, body.data.filters));
      } catch (err) {
        res.status(400).json({ ok: false, error: (err as Error).message });
        return;
      }
    }
    const requestedEnabled = body.data.enabled;
    const applyLocalUpdate = (enabled: number, triggerStatus = task.trigger_status, triggerError = task.trigger_error) => db.transaction(() => {
      db.prepare(
        `UPDATE scheduled_tasks SET
           name = ?, prompt = ?, schedule_json = ?, timezone = ?, enabled = ?, next_run_at = ?, project_id = ?,
           filter_json = ?, trigger_status = ?, trigger_error = ?, assistant_id = ?, provider = ?, model = ?,
           effort = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        body.data.name ?? task.name,
        body.data.prompt ?? task.prompt,
        schedule ? JSON.stringify(schedule) : task.schedule_json,
        timezone,
        enabled,
        nextRunAt,
        projectId,
        filtersJson,
        triggerStatus,
        triggerError,
        execution.assistantId,
        execution.provider,
        execution.model,
        execution.effort,
        task.id,
      );
      if (body.data.pinned === true && task.pin_order === null) {
        db.prepare(
          `UPDATE scheduled_tasks
           SET pin_order = COALESCE((SELECT MIN(pin_order) FROM scheduled_tasks WHERE user_id = ?), 1) - 1
           WHERE id = ?`,
        ).run(req.user!.id, task.id);
      } else if (body.data.pinned === false) {
        db.prepare('UPDATE scheduled_tasks SET pin_order = NULL WHERE id = ?').run(task.id);
      }
    });
    if (task.trigger_kind === 'event' && requestedEnabled !== undefined && task.external_trigger_id) {
      const apiKey = composioKey();
      if (!apiKey) {
        applyLocalUpdate(0, 'error', 'Composio is not configured')();
        res.status(503).json({ ok: false, error: 'Composio is not configured' });
        return;
      }
      // Disable locally before the remote call. Enabling stays fail-closed
      // until Composio confirms the trigger is active.
      applyLocalUpdate(0, 'syncing', null)();
      void changeTrigger(apiKey, task.external_trigger_id, requestedEnabled)
        .then(() => {
          applyLocalUpdate(requestedEnabled ? 1 : 0, 'ready', null)();
          if (!requestedEnabled) {
            db.prepare(
              `UPDATE automation_events SET status = 'ignored', finished_at = datetime('now')
               WHERE scheduled_task_id = ? AND status = 'pending'`,
            ).run(task.id);
          }
          res.json({ ok: true, scheduledTask: taskView(taskForUser.get(task.id, req.user!.id) as ScheduledTaskRow) });
        })
        .catch((err: Error) => {
          applyLocalUpdate(0, 'error', err.message.slice(0, 1_000))();
          res.status(502).json({
            ok: false,
            error: 'Composio could not update the trigger',
            scheduledTask: taskView(taskForUser.get(task.id, req.user!.id) as ScheduledTaskRow),
          });
        });
      return;
    }
    applyLocalUpdate(
      requestedEnabled === undefined ? task.enabled : requestedEnabled ? 1 : 0,
    )();
    res.json({ ok: true, scheduledTask: taskView(taskForUser.get(task.id, req.user!.id) as ScheduledTaskRow) });
  });

  router.get('/:id/runs', (req, res) => {
    const task = taskForUser.get(req.params.id, req.user!.id) as ScheduledTaskRow | undefined;
    if (!task) {
      res.status(404).json({ ok: false, error: 'Automation not found' });
      return;
    }
    res.json({ ok: true, runs: (allRuns.all(task.id) as RunWithTitle[]).map(runView) });
  });

  router.patch('/:id/runs/:runId', (req, res) => {
    const body = z.object({ important: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid run update' });
      return;
    }
    const task = taskForUser.get(req.params.id, req.user!.id) as ScheduledTaskRow | undefined;
    if (!task) {
      res.status(404).json({ ok: false, error: 'Automation not found' });
      return;
    }
    const result = db
      .prepare('UPDATE scheduled_task_runs SET important = ? WHERE id = ? AND scheduled_task_id = ?')
      .run(body.data.important ? 1 : 0, req.params.runId, task.id);
    if (result.changes === 0) {
      res.status(404).json({ ok: false, error: 'Run not found' });
      return;
    }
    const run = db
      .prepare(
        `SELECT r.*, c.title AS conversation_title FROM scheduled_task_runs r
         LEFT JOIN conversations c ON c.id = r.conversation_id WHERE r.id = ?`,
      )
      .get(req.params.runId) as RunWithTitle;
    res.json({ ok: true, run: runView(run) });
  });

  router.delete('/:id/runs/:runId', (req, res) => {
    const task = taskForUser.get(req.params.id, req.user!.id) as ScheduledTaskRow | undefined;
    if (!task) {
      res.status(404).json({ ok: false, error: 'Automation not found' });
      return;
    }
    const run = db
      .prepare('SELECT * FROM scheduled_task_runs WHERE id = ? AND scheduled_task_id = ?')
      .get(req.params.runId, task.id) as ScheduledTaskRunRow | undefined;
    if (!run) {
      res.status(404).json({ ok: false, error: 'Run not found' });
      return;
    }
    if (['queued', 'running', 'needs_you'].includes(run.status)) {
      res.status(409).json({ ok: false, error: 'An active run cannot be deleted' });
      return;
    }
    db.transaction(() => {
      db.prepare('DELETE FROM scheduled_task_runs WHERE id = ? AND scheduled_task_id = ?').run(run.id, task.id);
      if (run.conversation_id) {
        db.prepare('UPDATE conversations SET archived = 1, pin_order = NULL WHERE id = ?').run(run.conversation_id);
      }
    })();
    res.json({ ok: true, archivedConversationId: run.conversation_id });
  });

  router.post('/:id/run-now', (req, res) => {
    const task = taskForUser.get(req.params.id, req.user!.id) as ScheduledTaskRow | undefined;
    if (!task) {
      res.status(404).json({ ok: false, error: 'Scheduled task not found' });
      return;
    }
    void manager
      .runScheduledTask(task.id)
      .then((result) => {
        if (!result.ok) {
          res.status(result.error === 'already_running' ? 409 : 404).json({ ok: false, error: result.error });
          return;
        }
        res.status(202).json({ ok: true, conversationId: result.conversationId, runId: result.runId });
      })
      .catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  router.delete('/:id', (req, res) => {
    const task = taskForUser.get(req.params.id, req.user!.id) as ScheduledTaskRow | undefined;
    if (!task) {
      res.status(404).json({ ok: false, error: 'Scheduled task not found' });
      return;
    }
    const activeConversations = db
      .prepare(
        `SELECT conversation_id FROM scheduled_task_runs
         WHERE scheduled_task_id = ? AND status IN ('queued','running','needs_you') AND conversation_id IS NOT NULL`,
      )
      .all(task.id) as { conversation_id: string }[];
    const externalTriggerId = task.external_trigger_id;
    const result = db.transaction(() => {
      db.prepare(
        `UPDATE conversations SET archived = 1, pin_order = NULL
         WHERE id IN (SELECT conversation_id FROM scheduled_task_runs WHERE scheduled_task_id = ?)`,
      ).run(task.id);
      return db.prepare('DELETE FROM scheduled_tasks WHERE id = ? AND user_id = ?').run(task.id, req.user!.id);
    })();
    for (const run of activeConversations) void manager.interrupt(run.conversation_id);
    if (result.changes === 0) {
      res.status(404).json({ ok: false, error: 'Scheduled task not found' });
      return;
    }
    const apiKey = composioKey();
    if (externalTriggerId && apiKey) {
      void removeTrigger(apiKey, externalTriggerId).catch(() => undefined);
    }
    res.json({ ok: true });
  });

  return router;
}
