import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, HelpCircle, MapPin, Trash2, Users, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  calendarApi,
  calendarPanel,
  formatRange,
  LEAD_CHOICES,
  localZone,
  type CalEvent,
  type CalendarAccount,
  type Response,
} from '@/lib/masterCalendar';

const pad = (n: number) => String(n).padStart(2, '0');
const dateInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeInput = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Local wall time to an RFC 3339 instant with this device's offset. */
export function localInstant(date: string, time: string) {
  const d = new Date(`${date}T${time}:00`);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date}T${time}:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
const nextDay = (date: string) => dateInput(new Date(`${date}T12:00:00`).getTime() + 86_400_000);
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
/** Descriptions can carry HTML from Google; show it as plain text. */
export function plainText(html: string) {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n'), 'text/html');
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
const calendarLabel = (e: Pick<CalEvent, 'account' | 'calendarName'>) => (e.calendarName.toLowerCase() === e.account ? e.account : `${e.account} · ${e.calendarName}`);
const RESPONSE_LABEL: Record<Response, string> = { accepted: 'Going', declined: 'Not going', tentative: 'Maybe', needsAction: 'No reply' };

export function ResponseIcon({ response }: { response: Response }) {
  if (response === 'accepted') return <Check className="size-3.5 text-emerald-600" aria-label="Accepted" />;
  if (response === 'declined') return <X className="size-3.5 text-red-600" aria-label="Declined" />;
  if (response === 'tentative') return <HelpCircle className="size-3.5 text-amber-600" aria-label="Maybe" />;
  return <span className="inline-block size-3.5 rounded-full border border-muted-foreground/50" aria-label="No reply" />;
}

export interface Draft {
  connectorId: number;
  calendarId: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
}

/** Create or edit. Guests are emailed only from the explicit "send" button. */
export function EventEditor({
  open,
  event,
  draft,
  accounts,
  onClose,
  onSaved,
}: {
  open: boolean;
  event: CalEvent | null;
  draft: Draft | null;
  accounts: CalendarAccount[];
  onClose: () => void;
  onSaved: (event: CalEvent) => void;
}) {
  const writable = useMemo(
    () => accounts.flatMap((a) => a.calendars.filter((c) => c.writable).map((c) => ({ connectorId: a.connectorId, calendarId: c.id, label: `${a.account} · ${c.name}`, color: a.color }))),
    [accounts],
  );
  const [title, setTitle] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [date, setDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [target, setTarget] = useState('');
  const [location, setLocation] = useState('');
  const [guests, setGuests] = useState('');
  const [description, setDescription] = useState('');
  const [addMeet, setAddMeet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const src = event ?? draft;
    if (!src) return;
    setTitle(event?.title === '(No title)' ? '' : (event?.title ?? ''));
    setAllDay(src.allDay);
    setDate(dateInput(src.startMs));
    setEndDate(dateInput(src.allDay ? src.endMs - 1 : src.endMs));
    setStart(timeInput(src.startMs));
    setEnd(timeInput(src.endMs));
    setTarget(`${src.connectorId}|${'calendarId' in src ? src.calendarId : ''}`);
    setLocation(event?.location ?? '');
    setGuests(event ? event.attendees.filter((a) => !a.self).map((a) => a.email).join(', ') : '');
    setDescription(event?.description ? plainText(event.description) : '');
    setAddMeet(false);
    setError(null);
  }, [open, event, draft]);

  const attendees = guests
    .split(/[\s,;]+/)
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  const selfEmails = event ? event.attendees.filter((a) => a.self).map((a) => a.email) : [];
  const hasGuests = attendees.length > 0 || Boolean(event?.attendees.some((a) => !a.self));

  const save = async (notifyGuests: boolean) => {
    setError(null);
    if (!title.trim()) return setError('Add a title.');
    const bad = attendees.find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
    if (bad) return setError(`"${bad}" is not an email address.`);
    const timing = allDay
      ? { allDay: true, start: date, end: nextDay(endDate < date ? date : endDate) }
      : { allDay: false, start: localInstant(date, start), end: localInstant(end <= start ? nextDay(date) : date, end) };
    if (!allDay && Date.parse(timing.end) <= Date.parse(timing.start)) return setError('The end time must be after the start time.');
    setBusy(true);
    try {
      let saved: CalEvent;
      if (event) {
        // Send only what changed: rewriting guests or a formatted description would lose Google's details.
        const before = event.attendees.filter((a) => !a.self).map((a) => a.email).sort().join(',');
        const guestsChanged = before !== [...attendees].sort().join(',');
        const descriptionChanged = description !== (event.description ? plainText(event.description) : '');
        saved = (
          await calendarApi.update(event, {
            ...timing,
            title: title.trim(),
            location: location.trim(),
            ...(descriptionChanged ? { description } : {}),
            ...(guestsChanged ? { attendees: [...selfEmails, ...attendees.filter((a) => !selfEmails.includes(a))] } : {}),
            timeZone: localZone(),
            notifyGuests,
          })
        ).event;
      } else {
        const [connectorId, calendarId] = target.split('|');
        saved = (
          await calendarApi.create({
            ...timing,
            title: title.trim(),
            ...(location.trim() ? { location: location.trim() } : {}),
            ...(description.trim() ? { description } : {}),
            attendees,
            timeZone: localZone(),
            notifyGuests,
            connectorId: Number(connectorId),
            calendarId: calendarId!,
            addMeet,
          })
        ).event;
      }
      calendarPanel.refresh();
      onSaved(saved);
    } catch (e) {
      setError(errorText(e));
      calendarPanel.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{event ? 'Edit event' : 'New event'}</DialogTitle>
          <DialogDescription className="sr-only">Event details</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <Input autoFocus placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          {!event ? (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Calendar</span>
              <select className="h-9 w-full rounded-lg border bg-background px-2" value={target} onChange={(e) => setTarget(e.target.value)}>
                {writable.map((c) => (
                  <option key={`${c.connectorId}|${c.calendarId}`} value={`${c.connectorId}|${c.calendarId}`}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">{calendarLabel(event)}</p>
          )}
          <div className="flex items-center justify-between">
            <span>All day</span>
            <Switch checked={allDay} onCheckedChange={() => setAllDay(!allDay)} aria-label="All day" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className={allDay ? 'space-y-1' : 'col-span-2 space-y-1'}>
              <span className="text-xs text-muted-foreground">{allDay ? 'From' : 'Date'}</span>
              <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} />
            </label>
            {allDay ? (
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">To</span>
                <Input type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} />
              </label>
            ) : (
              <>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Start</span>
                  <Input type="time" step={300} value={start} onChange={(e) => setStart(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">End</span>
                  <Input type="time" step={300} value={end} onChange={(e) => setEnd(e.target.value)} />
                </label>
              </>
            )}
          </div>
          <Input placeholder="Location or link" value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Location" />
          <Input placeholder="Guests (emails, comma separated)" value={guests} onChange={(e) => setGuests(e.target.value)} aria-label="Guests" />
          <Textarea placeholder="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
          {!event ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={addMeet} onChange={(e) => setAddMeet(e.target.checked)} />
              Add a Google Meet link
            </label>
          ) : null}
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {hasGuests ? (
            <>
              <Button variant="outline" onClick={() => void save(false)} disabled={busy}>
                Save, don’t email
              </Button>
              <Button onClick={() => void save(true)} disabled={busy}>
                {event ? 'Save and email guests' : 'Save and send invites'}
              </Button>
            </>
          ) : (
            <Button onClick={() => void save(false)} disabled={busy}>
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EventDetails({
  event,
  defaultLead,
  leadOverride,
  onClose,
  onEdit,
  onChanged,
}: {
  event: CalEvent | null;
  defaultLead: number | null;
  leadOverride: number | null | undefined;
  onClose: () => void;
  onEdit: (e: CalEvent) => void;
  onChanged: (e: CalEvent | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lead, setLead] = useState<string>('default');
  useEffect(() => {
    setError(null);
    setConfirmDelete(false);
    setLead(leadOverride === undefined ? 'default' : String(leadOverride));
  }, [event?.key, leadOverride]);
  if (!event) return null;
  const guests = event.attendees.filter((a) => !a.self);
  const act = async (work: () => Promise<CalEvent | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      calendarPanel.refresh();
      onChanged(next);
    } catch (e) {
      setError(errorText(e));
      calendarPanel.refresh();
    } finally {
      setBusy(false);
    }
  };
  const defaultLabel = LEAD_CHOICES.find((c) => c.value === defaultLead)?.label ?? 'No reminder';
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 pr-6">
            <span className="mt-1.5 size-3 shrink-0 rounded-sm" style={{ background: event.color }} />
            <span className={event.selfResponse === 'declined' ? 'line-through opacity-70' : undefined}>{event.title}</span>
          </DialogTitle>
          <DialogDescription>{formatRange(event)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {calendarLabel(event)}
            {event.alsoOn.length ? ` (also on ${event.alsoOn.join(', ')})` : ''}
            {event.recurring ? ' · Repeats' : ''}
          </p>
          {event.joinUrl ? (
            <Button asChild className="w-full">
              <a href={event.joinUrl} target="_blank" rel="noreferrer">
                <Video /> Join meeting
              </a>
            </Button>
          ) : null}
          {event.location ? (
            <p className="flex gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="break-words">{event.location}</span>
            </p>
          ) : null}
          {event.organizer && !event.organizerSelf ? <p className="text-muted-foreground">Organized by {event.organizer}</p> : null}
          {guests.length ? (
            <div>
              <p className="mb-1 flex items-center gap-2 text-muted-foreground">
                <Users className="size-4" /> {guests.length} guest{guests.length === 1 ? '' : 's'}
              </p>
              <ul className="max-h-36 space-y-1 overflow-y-auto pl-6">
                {guests.map((a) => (
                  <li key={a.email} className="flex items-center gap-2">
                    <ResponseIcon response={a.response} />
                    <span className="truncate">{a.name ?? a.email}</span>
                    {a.organizer ? <span className="text-xs text-muted-foreground">organizer</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {event.description ? <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-2">{plainText(event.description)}</p> : null}
          {event.canRespond ? (
            <div>
              <p className="mb-1 text-muted-foreground">
                Going? <span className="text-xs">({RESPONSE_LABEL[event.selfResponse ?? 'needsAction']})</span>
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(['accepted', 'tentative', 'declined'] as const).map((r) => (
                  <Button key={r} variant={event.selfResponse === r ? 'default' : 'outline'} disabled={busy} onClick={() => void act(async () => (await calendarApi.respond(event, r)).event)}>
                    {r === 'accepted' ? 'Yes' : r === 'tentative' ? 'Maybe' : 'No'}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          {!event.allDay ? (
            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Reminder</span>
              <select
                className="h-8 rounded-lg border bg-background px-2"
                value={lead}
                disabled={busy}
                onChange={(e) => {
                  const value = e.target.value;
                  setLead(value);
                  void act(async () => {
                    await calendarApi.setEventLead(event.occurrenceKey, value === 'default' ? 'default' : value === 'null' ? null : Number(value));
                    return event;
                  });
                }}
              >
                <option value="default">Default ({defaultLabel.toLowerCase()})</option>
                {LEAD_CHOICES.map((c) => (
                  <option key={String(c.value)} value={String(c.value)}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}
          {confirmDelete ? (
            <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
              <p>Delete {event.recurring ? 'this occurrence of ' : ''}“{event.title}”?</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  Keep it
                </Button>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => void act(async () => (await calendarApi.remove(event, false), null))}>
                  Delete{guests.length ? ', don’t email' : ''}
                </Button>
                {guests.length && event.organizerSelf ? (
                  <Button variant="destructive" size="sm" disabled={busy} onClick={() => void act(async () => (await calendarApi.remove(event, true), null))}>
                    Delete and tell guests
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter className="flex-row flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            {event.htmlLink ? (
              <Button variant="ghost" size="sm" asChild>
                <a href={event.htmlLink} target="_blank" rel="noreferrer" aria-label="Open in Google Calendar">
                  <ExternalLink /> Google
                </a>
              </Button>
            ) : null}
            {event.canEdit ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)} aria-label="Delete event">
                <Trash2 /> Delete
              </Button>
            ) : null}
          </div>
          {event.canEdit ? (
            <Button size="sm" disabled={busy} onClick={() => onEdit(event)}>
              Edit
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
