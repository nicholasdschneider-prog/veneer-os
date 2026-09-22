import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { requestJson } from '@/lib/api';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
const base = '/api/bot-workflows';
const field =
  'min-w-0 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm';
const json = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
interface Routine {
  id: string;
  name: string;
  instructions: string;
  kind: string;
  source: string;
  schedule_json: string | null;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
}
interface Teaching {
  id: string;
  name: string;
  state: string;
  steps_json: string;
  draft: string;
  expires_at: string;
  skill_name: string | null;
  test_requested_at: string | null;
}
interface Preference {
  input: boolean;
  blocked: boolean;
  completed: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
}
interface Settings {
  preference: Preference | null;
  routines: Routine[];
  deliveries: {
    id: string;
    event_id: string;
    status: string;
    created_at: string;
  }[];
  teaching: Teaching | null;
  sources: {
    id: string;
    name: string;
    enabled: number;
    last_event_at: string | null;
  }[];
  canManage: boolean;
  canTeach: boolean;
}
interface Config {
  description: string;
  provider: string;
  model: string | null;
  effort: string | null;
  project_id: string | null;
  skills: string[];
  routines: Routine[];
}
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export function openBotWorkflows(id: string, name: string, tab?: string) {
  window.dispatchEvent(
    new CustomEvent('veneer:bot-workflows', { detail: { id, name, tab } }),
  );
}
export function BotWorkflowDialogs() {
  const [bot, setBot] = useState<{
    id: string;
    name: string;
    tab?: string;
  } | null>(null);
  useEffect(() => {
    const open = (e: Event) => setBot((e as CustomEvent).detail);
    window.addEventListener('veneer:bot-workflows', open);
    return () => window.removeEventListener('veneer:bot-workflows', open);
  }, []);
  return (
    <Dialog
      open={!!bot}
      onOpenChange={(open) => {
        if (!open) setBot(null);
      }}
    >
      <DialogContent className="max-h-[95dvh] overflow-y-auto sm:max-w-4xl">
        <DialogTitle>{bot?.name} · Settings</DialogTitle>
        <DialogDescription>
          Routines, notifications, teaching, and reusable bot templates.
        </DialogDescription>
        {bot && <BotSettings key={bot.id} bot={bot} />}
      </DialogContent>
    </Dialog>
  );
}
function BotSettings({
  bot,
}: {
  bot: { id: string; name: string; tab?: string };
}) {
  const [data, setData] = useState<Settings | null>(null),
    [tab, setTab] = useState(bot.tab ?? 'notifications'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [pref, setPref] = useState<Preference>({
    input: true,
    blocked: true,
    completed: false,
    quiet_start: null,
    quiet_end: null,
    timezone: localZone(),
  });
  const load = useCallback(async () => {
    const d = await requestJson<Settings>(`${base}/bots/${bot.id}`);
    setData(d);
  }, [bot.id]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (data?.preference)
      setPref({
        ...data.preference,
        input: !!data.preference.input,
        blocked: !!data.preference.blocked,
        completed: !!data.preference.completed,
      });
  }, [data?.preference]);
  const act = async (fn: () => Promise<unknown>, message = 'Saved') => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await load();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const enableDevice = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window))
      throw new Error(
        'This browser does not support push. On iPhone or iPad, add Veneer to your Home Screen and open it there.',
      );
    if ((await Notification.requestPermission()) !== 'granted')
      throw new Error(
        'Allow notifications in your device settings to continue.',
      );
    const { publicKey } = await requestJson<{ publicKey: string }>(
      `${base}/push`,
    );
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const bytes = Uint8Array.from(
      atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    );
    const sub =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      }));
    const raw = sub.toJSON();
    const device = await requestJson<{ id: string }>(
      `${base}/push`,
      json('POST', { endpoint: raw.endpoint, keys: raw.keys }),
    );
    localStorage.setItem('veneer:push-device', device.id);
    await requestJson(
      `${base}/bots/${bot.id}/notifications`,
      json('PUT', pref),
    );
  };
  const disableDevice = async () => {
    const id = localStorage.getItem('veneer:push-device');
    if (id) await requestJson(`${base}/push/${id}`, json('DELETE'));
    const reg = await navigator.serviceWorker.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    localStorage.removeItem('veneer:push-device');
  };
  return (
    <div className="min-w-0 space-y-4">
      <nav
        aria-label="Bot settings"
        className="flex gap-1 overflow-x-auto border-b pb-2"
      >
        {['notifications', 'routines', 'teach', 'templates'].map((t) => (
          <Button
            key={t}
            variant={tab === t ? 'secondary' : 'ghost'}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
          >
            {t === 'teach' ? 'Teach a task' : t[0]!.toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {!data ? (
        <p role="status">Loading bot settings…</p>
      ) : (
        <>
          {tab === 'notifications' && (
            <div className="min-w-0 space-y-4">
              <p className="text-sm text-muted-foreground">
                Receive a notification when this bot needs you, even when Veneer
                is closed. Lock-screen notifications keep customer details
                private.
              </p>
              {(['input', 'blocked', 'completed'] as const).map((k) => (
                <label key={k} className="flex min-h-10 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={pref[k]}
                    onChange={(e) =>
                      setPref({ ...pref, [k]: e.target.checked })
                    }
                  />
                  {k === 'input'
                    ? 'Questions and approvals'
                    : k === 'blocked'
                      ? 'Blocked or failed work'
                      : 'Completed work'}
                </label>
              ))}
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 text-sm">
                  Quiet hours start
                  <input
                    aria-label="Quiet hours start"
                    className={field}
                    type="time"
                    value={pref.quiet_start ?? ''}
                    onChange={(e) =>
                      setPref({ ...pref, quiet_start: e.target.value || null })
                    }
                  />
                </label>
                <label className="space-y-1 text-sm">
                  Quiet hours end
                  <input
                    aria-label="Quiet hours end"
                    className={field}
                    type="time"
                    value={pref.quiet_end ?? ''}
                    onChange={(e) =>
                      setPref({ ...pref, quiet_end: e.target.value || null })
                    }
                  />
                </label>
              </div>
              <label className="block space-y-1 text-sm">
                Timezone
                <input
                  className={field}
                  value={pref.timezone}
                  onChange={(e) =>
                    setPref({ ...pref, timezone: e.target.value })
                  }
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      enableDevice,
                      'Notifications enabled for this device and bot',
                    )
                  }
                >
                  Enable on this device
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      requestJson(
                        `${base}/bots/${bot.id}/notifications`,
                        json('PUT', pref),
                      ),
                    )
                  }
                >
                  Save preferences
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      disableDevice,
                      'Notifications disabled on this device',
                    )
                  }
                >
                  Disable this device
                </Button>
              </div>
            </div>
          )}
          {tab === 'routines' && (
            <Routines bot={bot} data={data} busy={busy} act={act} />
          )}
          {tab === 'teach' &&
            (data.canTeach ? (
              <Teach
                bot={bot}
                session={data.teaching}
                busy={busy}
                act={act}
                reload={load}
              />
            ) : (
              <p>
                Bot management access is required to record and save training.
              </p>
            ))}
          {tab === 'templates' &&
            (data.canManage ? (
              <Templates bot={bot} busy={busy} act={act} />
            ) : (
              <p>Bot management access is required to create a template.</p>
            ))}
        </>
      )}
    </div>
  );
}
type Act = (fn: () => Promise<unknown>, message?: string) => Promise<void>;
function Routines({
  bot,
  data,
  busy,
  act,
}: {
  bot: { id: string; name: string };
  data: Settings;
  busy: boolean;
  act: Act;
}) {
  const [name, setName] = useState(''),
    [instructions, setInstructions] = useState(''),
    [kind, setKind] = useState('schedule'),
    [time, setTime] = useState('08:00'),
    [zone, setZone] = useState(localZone()),
    [source, setSource] = useState(''),
    [frequency, setFrequency] = useState('weekdays');
  const toggle = (r: Routine) =>
    act(
      () =>
        requestJson(
          `${base}/bots/${bot.id}/routines/${r.id}`,
          json('PUT', {
            name: r.name,
            instructions: r.instructions,
            kind: r.kind,
            source: r.source,
            schedule: r.schedule_json ? JSON.parse(r.schedule_json) : undefined,
            timezone: r.timezone,
            enabled: !r.enabled,
          }),
        ),
      r.enabled ? 'Routine paused' : 'Routine enabled',
    );
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {bot.name} owns these routines. Work goes to this conversation and waits
        in the queue when the bot is busy.
      </p>
      {data.routines.length === 0 && (
        <p className="text-sm">No routines yet.</p>
      )}
      {data.routines.map((r) => (
        <div key={r.id} className="rounded-xl border p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{r.name}</p>
              <p className="text-xs text-muted-foreground">
                {r.enabled ? 'Enabled' : 'Paused'} ·{' '}
                {r.kind === 'schedule'
                  ? `${r.timezone}${r.next_run_at ? ' · Next ' + new Date(r.next_run_at).toLocaleString() : ''}`
                  : r.kind}
              </p>
            </div>
            {data.canManage && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void toggle(r)}
              >
                {r.enabled ? 'Pause' : 'Enable'}
              </Button>
            )}
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm">{r.instructions}</p>
        </div>
      ))}
      {data.canManage && (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Event connections
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            OrderOps must be configured to sign and deliver ticket events.
            Creating a source alone does not connect the application.
          </p>
          {data.sources.map((s) => (
            <div key={s.id} className="mt-2 flex items-center gap-2 text-sm">
              <span className="flex-1">
                {s.name} ·{' '}
                {!s.enabled
                  ? 'Disabled'
                  : s.last_event_at
                    ? 'Last event ' + new Date(s.last_event_at).toLocaleString()
                    : 'Awaiting first signed event'}
              </span>
              {!!s.enabled && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () =>
                        requestJson(
                          `${base}/bots/${bot.id}/sources/${s.id}`,
                          json('DELETE'),
                        ),
                      'Source disabled',
                    )
                  }
                >
                  Disconnect
                </Button>
              )}
            </div>
          ))}
          <Button
            variant="outline"
            className="mt-3"
            disabled={busy}
            onClick={() =>
              void act(
                () =>
                  requestJson(
                    `${base}/bots/${bot.id}/sources`,
                    json('POST', { name: 'OrderOps' }),
                  ),
                'Event source created. Configure the OrderOps sender to complete the connection.',
              )
            }
          >
            Create OrderOps connection
          </Button>
        </details>
      )}
      {data.canManage && (
        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () =>
                requestJson(
                  `${base}/bots/${bot.id}/routines`,
                  json('POST', {
                    name,
                    instructions,
                    kind,
                    source,
                    schedule:
                      kind === 'schedule'
                        ? { type: frequency, time }
                        : undefined,
                    timezone: zone,
                    enabled: false,
                  }),
                ),
              'Routine created paused. Review it, then enable when ready.',
            );
          }}
        >
          <h3 className="font-medium">Create a routine</h3>
          <label className="block text-sm">
            Name
            <input
              required
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Instructions
            <textarea
              required
              className={field}
              rows={3}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Outcome, source systems, validation, and approval boundaries"
            />
          </label>
          <label className="block text-sm">
            Run when
            <select
              className={field}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="schedule">On a schedule</option>
              <option value="ticket.created">
                An OrderOps ticket is created
              </option>
              <option value="customer.replied">
                A customer replies in OrderOps
              </option>
            </select>
          </label>
          {kind === 'schedule' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                Frequency
                <select
                  className={field}
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value)}
                >
                  <option value="weekdays">Weekdays</option>
                  <option value="daily">Every day</option>
                </select>
              </label>
              <label className="text-sm">
                Time
                <input
                  required
                  type="time"
                  className={field}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              <label className="col-span-2 text-sm">
                Timezone
                <input
                  className={field}
                  value={zone}
                  onChange={(e) => setZone(e.target.value)}
                />
              </label>
            </div>
          ) : (
            <label className="block text-sm">
              Event source
              <select
                required
                className={field}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">Choose a connected source</option>
                {data.sources
                  .filter((s) => s.enabled)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              {!data.sources.length && (
                <span className="text-muted-foreground">
                  Connect an authenticated OrderOps event source before enabling
                  event routines.
                </span>
              )}
            </label>
          )}
          <Button type="submit" disabled={busy}>
            Create paused routine
          </Button>
        </form>
      )}
      {data.deliveries.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Recent deliveries
          </summary>
          <ul className="mt-2 space-y-2">
            {data.deliveries.map((d) => (
              <li key={d.id} className="break-words text-xs">
                {d.event_id} · {d.status} · {d.created_at}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
function Teach({
  bot,
  session,
  busy,
  act,
  reload,
}: {
  bot: { id: string; name: string };
  session: Teaching | null;
  busy: boolean;
  act: Act;
  reload: () => Promise<void>;
}) {
  const [name, setName] = useState(''),
    [outcome, setOutcome] = useState(''),
    [draft, setDraft] = useState(''),
    [skill, setSkill] = useState(''),
    [example, setExample] = useState(''),
    [clock, setClock] = useState(Date.now());
  useEffect(() => {
    setDraft(session?.draft ?? '');
    setSkill(
      session?.skill_name ??
        session?.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') ??
        '',
    );
  }, [session?.id, session?.draft, session?.skill_name]);
  const active = !!session && ['recording', 'paused'].includes(session.state);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setClock(Date.now());
      void reload();
    }, 2000);
    return () => clearInterval(timer);
  }, [active, reload]);
  const action = (a: string, body?: unknown) =>
    act(
      () =>
        requestJson(`${base}/teaching/${session!.id}/${a}`, json('POST', body)),
      a === 'save'
        ? 'Skill saved. Test it on a second example before scheduling.'
        : 'Updated',
    );
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm text-muted-foreground">
        Demonstrate one workflow in the browser below. Recording lasts up to 10
        minutes. Typed values, passwords, and microphone audio are excluded.
        Pause before signing in.
      </p>
      {!session || session.state === 'saved' ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () =>
                requestJson(
                  `${base}/bots/${bot.id}/teach`,
                  json('POST', { name, outcome }),
                ),
              'Recording started',
            );
          }}
        >
          <label className="block text-sm">
            Task name
            <input
              required
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Expected outcome
            <textarea
              required
              rows={2}
              className={field}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            />
          </label>
          <Button disabled={busy}>Start demonstration</Button>
        </form>
      ) : null}
      {active && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className="text-sm font-medium">
              {clock >= Date.parse(session.expires_at)
                ? 'Time limit reached'
                : session.state === 'recording'
                  ? 'Recording'
                  : 'Paused'}{' '}
              ·{' '}
              {Math.max(
                0,
                Math.ceil((Date.parse(session.expires_at) - clock) / 1000),
              )}
              s remaining · {JSON.parse(session.steps_json).length} actions
            </span>
            <Button
              variant="outline"
              disabled={busy || clock >= Date.parse(session.expires_at)}
              onClick={() =>
                void action(session.state === 'paused' ? 'resume' : 'pause')
              }
            >
              {session.state === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button disabled={busy} onClick={() => void action('stop')}>
              Stop and review
            </Button>
          </div>
          <iframe
            title={`${bot.name} teaching browser`}
            src={`/veneer-browser?conversation=${bot.id}&chrome=off`}
            className="h-[55dvh] w-full rounded-lg border"
          />
        </>
      )}
      {session?.state === 'draft' && (
        <>
          <label className="block text-sm">
            Skill name
            <input
              className={field}
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Review the skill
            <textarea
              className={`${field} font-mono`}
              rows={15}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || !draft || !skill}
            onClick={() => void action('save', { skillName: skill, draft })}
          >
            Save reviewed skill
          </Button>
        </>
      )}
      {session?.state === 'saved' && (
        <div className="space-y-2 rounded-xl border p-3">
          <p className="font-medium">Saved: {session.skill_name}</p>
          <label className="block text-sm">
            Second example and expected result
            <textarea
              className={field}
              value={example}
              onChange={(e) => setExample(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || !example.trim()}
            onClick={() => void action('test', { example })}
          >
            Ask {bot.name} to test
          </Button>
          {session.test_requested_at && (
            <a className="block text-sm underline" href={`#/chat/${bot.id}`}>
              Review the test in the bot conversation
            </a>
          )}
        </div>
      )}
      {session && session.state !== 'saved' && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void action('discard')}
        >
          Discard demonstration
        </Button>
      )}
    </div>
  );
}
function Templates({
  bot,
  busy,
  act,
}: {
  bot: { id: string; name: string };
  busy: boolean;
  act: Act;
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [name, setName] = useState(bot.name),
    [scope, setScope] = useState(''),
    [templates, setTemplates] = useState<
      { id: string; name: string; config: Config }[]
    >([]),
    [chosen, setChosen] = useState(''),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    const [d, t] = await Promise.all([
      requestJson<{ config: Config }>(`${base}/bots/${bot.id}/template`),
      requestJson<{ templates: typeof templates }>(`${base}/templates`),
    ]);
    setConfig(d.config);
    setTemplates(t.templates);
  }, [bot.id]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  return (
    <div className="min-w-0 space-y-4">
      {error && <p role="alert">{error}</p>}
      <p className="text-sm text-muted-foreground">
        Create a fresh bot from a reviewed role. Copies start with paused
        routines and their own conversation. Account access must be set up
        separately.
      </p>
      <label className="block text-sm">
        Template or new bot name
        <input
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {config && (
        <>
          <label className="block text-sm">
            Role and instructions
            <textarea
              className={field}
              rows={8}
              value={config.description}
              onChange={(e) =>
                setConfig({ ...config, description: e.target.value })
              }
            />
          </label>
          <label className="block text-sm">
            Skills (comma separated)
            <input
              className={field}
              value={config.skills.join(', ')}
              onChange={(e) =>
                setConfig({
                  ...config,
                  skills: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {config.routines.length} routines will be copied paused. No history,
            browser sessions, credentials, or action grants transfer.
          </p>
          <Button
            disabled={busy || !name.trim()}
            variant="outline"
            onClick={() =>
              void act(async () => {
                await requestJson(
                  `${base}/bots/${bot.id}/templates`,
                  json('POST', { name, config }),
                );
                await load();
              }, 'Private template saved')
            }
          >
            Save private template
          </Button>
        </>
      )}
      <label className="block text-sm">
        New bot scope
        <textarea
          className={field}
          rows={2}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          placeholder="Which work this new bot will own"
        />
      </label>
      <Button
        disabled={busy || !config || !name.trim() || !scope.trim()}
        onClick={() =>
          void act(async () => {
            const t = await requestJson<{ id: string }>(
              `${base}/bots/${bot.id}/templates`,
              json('POST', { name, config }),
            );
            const c = await requestJson<{ conversationId: string }>(
              `${base}/templates/${t.id}/instantiate`,
              json('POST', { name, scope }),
            );
            window.location.hash = `#/chat/${c.conversationId}`;
          }, 'Bot duplicated. Review access before assigning work.')
        }
      >
        Duplicate this bot
      </Button>
      {templates.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <label className="block text-sm">
            Or use a team template
            <select
              className={field}
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
            >
              <option value="">Choose a template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {chosen && (
            <div className="rounded-lg bg-muted p-3 text-sm">
              <p className="font-medium">Template preview</p>
              <p className="whitespace-pre-wrap">
                {templates.find((t) => t.id === chosen)?.config.description}
              </p>
              <p className="mt-2">
                {templates.find((t) => t.id === chosen)?.config.routines.length}{' '}
                routines, all paused on creation.
              </p>
            </div>
          )}
          <Button
            variant="outline"
            disabled={busy || !chosen || !name.trim() || !scope.trim()}
            onClick={() =>
              void act(async () => {
                const c = await requestJson<{ conversationId: string }>(
                  `${base}/templates/${chosen}/instantiate`,
                  json('POST', { name, scope }),
                );
                window.location.hash = `#/chat/${c.conversationId}`;
              }, 'Bot created with routines paused')
            }
          >
            Create from template
          </Button>
        </div>
      )}
    </div>
  );
}
interface SearchResult {
  id: string;
  kind: string;
  excerpt: string;
  at: string;
  href: string;
  title: string;
}
export function WorkspaceSearch() {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [results, setResults] = useState<SearchResult[]>([]),
    [error, setError] = useState(''),
    [indexing, setIndexing] = useState(0),
    [loading, setLoading] = useState(false),
    [more, setMore] = useState(false),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    const show = () => setOpen(true);
    window.addEventListener('keydown', key);
    window.addEventListener('veneer:search', show);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('veneer:search', show);
    };
  }, []);
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void requestJson<{
        results: SearchResult[];
        hasMore: boolean;
        indexing: number;
      }>(`${base}/search?q=${encodeURIComponent(query)}&offset=${offset}`)
        .then((r) => {
          if (alive) {
            setResults(r.results);
            setMore(r.hasMore);
            setIndexing(r.indexing);
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, query, offset]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>Search your workspace</DialogTitle>
        <DialogDescription>
          Find messages, decisions, and huddles across the work you can access.
        </DialogDescription>
        <input
          autoFocus
          aria-label="Search workspace"
          className={field}
          placeholder="Order number, customer, or phrase…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
        {error && <p role="alert">{error}</p>}
        {loading && <p role="status">Searching…</p>}
        {indexing > 0 && (
          <p className="text-xs text-muted-foreground">
            Indexing {indexing} conversations. More results will become
            available.
          </p>
        )}
        <ul className="space-y-2">
          {results.map((r) => (
            <li key={r.id}>
              <a
                href={r.href}
                onClick={() => setOpen(false)}
                className="block rounded-xl border p-3 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <p className="text-sm font-medium">
                  {r.title || 'Untitled chat'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.kind} ·{' '}
                  {new Date(
                    r.at.includes('T') ? r.at : r.at.replace(' ', 'T') + 'Z',
                  ).toLocaleString()}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {r.excerpt}
                </p>
              </a>
            </li>
          ))}
        </ul>
        {!loading && !error && query.trim().length >= 2 && !results.length && (
          <p>No matches in indexed work.</p>
        )}
        <div className="flex justify-between">
          {offset > 0 ? (
            <Button
              variant="ghost"
              onClick={() => setOffset(Math.max(0, offset - 30))}
            >
              Previous
            </Button>
          ) : (
            <span />
          )}
          {more && (
            <Button variant="ghost" onClick={() => setOffset(offset + 30)}>
              Next
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function WorkspaceSearchButton() {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Search workspace (Command or Control K)"
      onClick={() => window.dispatchEvent(new Event('veneer:search'))}
    >
      <Search className="size-4" />
    </Button>
  );
}
