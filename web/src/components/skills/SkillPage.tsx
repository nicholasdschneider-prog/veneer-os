import { useEffect, useState } from 'react';
import { ChevronLeft, Link2, Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  skillsApi,
  groupByName,
  type SkillDetail,
  type SkillMeta,
  type SkillScopeGroup,
} from '@/lib/skills';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, Segmented } from '../toolbox/controls';
import { ProviderBadges, IssueBadge } from './badges';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function scopeLabel(groups: SkillScopeGroup[], scope: string): string {
  const g = groups.find((x) => x.scope === scope);
  if (!g) return scope;
  if (g.kind === 'global') return 'Global';
  if (g.kind === 'source') return 'Platform source';
  return g.label;
}

/** Top-level frontmatter keys other than name/description, for the "kept" hint. */
function unknownFrontmatterKeys(content: string): string[] {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m || !m[1]) return [];
  const keys: string[] = [];
  for (const line of m[1].split('\n')) {
    const km = line.match(/^([A-Za-z0-9_-]+):/);
    if (km && km[1] && km[1] !== 'name' && km[1] !== 'description' && !keys.includes(km[1])) keys.push(km[1]);
  }
  return keys;
}

/** Plain-language explanation of a skill's issues for the fix-it banner. */
function issueSummary(issues: string[]): string {
  const parts: string[] = [];
  if (issues.includes('no-frontmatter'))
    parts.push('This skill has no name/description header, which Codex needs to use it.');
  if (issues.includes('missing-description'))
    parts.push('This skill has no description, which both assistants read to decide when to use it.');
  if (issues.includes('name-mismatch')) parts.push('The name inside the file differs from its folder name.');
  if (issues.includes('broken-link:claude')) parts.push('The Claude link is broken.');
  if (issues.includes('broken-link:codex')) parts.push('The Codex link is broken.');
  if (issues.includes('broken-link:grok')) parts.push('The Grok link is broken.');
  if (issues.includes('name-clash:grok')) parts.push('Another Grok skill shares this global name.');
  if (issues.includes('name-clash')) parts.push('Another skill in this scope shares this name.');
  return parts.join(' ');
}

function providerWithSkill(detail: SkillDetail): string {
  if (detail.providers.claude === 'ok') return 'Claude';
  if (detail.providers.codex === 'ok') return 'Codex';
  if (detail.providers.grok === 'ok') return 'Grok';
  return 'No provider';
}

function readOnlyNotice(origin: SkillDetail['origin']): string {
  if (origin === 'platform') return 'Built-in Veneer skill — read-only.';
  if (origin === 'system') return 'Built-in Codex skill — read-only.';
  return 'Read-only.';
}

/**
 * The whole story of one skill (identified by name) on a single page:
 * the content editor on the left, and a rail with availability, every
 * placement, and admin actions on the right (stacked below on phones).
 */
export function SkillPage({
  name,
  groups,
  initialPlacements,
  role,
  onClose,
  onToast,
}: {
  name: string;
  groups: SkillScopeGroup[];
  initialPlacements: SkillMeta[];
  role: string;
  onClose: (changed: boolean) => void;
  onToast: (message: string) => void;
}) {
  const isAdmin = role !== 'member';

  const [placements, setPlacements] = useState<SkillMeta[]>(initialPlacements);
  const [scope, setScope] = useState<string>(
    () => (initialPlacements.find((p) => p.scope === 'global') ?? initialPlacements[0])?.scope ?? 'global',
  );

  // Editor state for the selected placement.
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [tab, setTab] = useState<'form' | 'raw'>('form');
  const [fName, setFName] = useState('');
  const [fDescription, setFDescription] = useState('');
  const [fBody, setFBody] = useState('');
  const [raw, setRaw] = useState('');

  const [busy, setBusy] = useState<null | 'save' | 'sync' | 'toggle' | 'action'>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<SkillMeta | null>(null);
  const [picker, setPicker] = useState<null | 'make-global' | 'add-project'>(null);
  const [conflict, setConflict] = useState<{ raw: string; mtime: number } | null>(null);

  // Load the selected placement's content.
  useEffect(() => {
    let live = true;
    setDetail(null);
    setTab('form');
    skillsApi
      .read(scope, name)
      .then((r) => {
        if (!live) return;
        setDetail(r.skill);
        setFName(r.skill.name);
        setFDescription(r.skill.description ?? '');
        setFBody(r.skill.body);
        setRaw(r.skill.content);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [scope, name]);

  const selected = placements.find((p) => p.scope === scope) ?? null;
  const canEdit = isAdmin && detail !== null && !detail.readOnly;
  const edited =
    detail !== null &&
    (fName !== detail.name ||
      fDescription !== (detail.description ?? '') ||
      fBody !== detail.body ||
      raw !== detail.content);

  const hasGlobal = placements.some((p) => p.scope === 'global');
  const projectPlacements = placements.filter((p) => p.scope.startsWith('project:'));
  const hasLinkedPlacements = placements.some((p) => p.entryKind === 'link');
  const projectTargets = groups.filter(
    (g) => g.kind === 'project' && !placements.some((p) => p.scope === g.scope),
  );

  /** Confirm before an action that would drop unsaved editor changes. */
  const confirmDiscard = () =>
    !edited || window.confirm('Discard unsaved changes to this skill?');

  const switchScope = (next: string) => {
    if (next === scope) return;
    if (!confirmDiscard()) return;
    setError(null);
    setScope(next);
  };

  // Refresh the placement set after a mutation; fix the selection if the
  // selected copy moved or vanished, and close when the skill is gone.
  const reload = async () => {
    try {
      const list = await skillsApi.list();
      const agg = groupByName(list).find((a) => a.name === name);
      if (!agg || agg.placements.length === 0) {
        onClose(true);
        return;
      }
      setPlacements(agg.placements);
      if (!agg.placements.some((p) => p.scope === scope)) {
        const next = agg.placements.find((p) => p.scope === 'global') ?? agg.placements[0]!;
        setScope(next.scope);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ---------- editor actions ----------

  const doSave = async (overwrite = false) => {
    if (!detail) return;
    setBusy('save');
    setError(null);
    let expectedMtime = overwrite ? undefined : detail.mtime;
    try {
      let scopeNow = detail.scope;
      let nameNow = detail.name;
      // Rename first if the name changed (form mode only).
      if (tab === 'form' && fName.trim() !== detail.name) {
        const nm = fName.trim();
        if (!NAME_RE.test(nm)) {
          setError('Name must be lowercase letters, numbers, and hyphens.');
          setBusy(null);
          return;
        }
        const r = await skillsApi.patch(scopeNow, nameNow, { newName: nm });
        scopeNow = r.skill.scope;
        nameNow = r.skill.name;
        // The rename rewrote SKILL.md's name line on disk (fresh mtime) —
        // carry the new identity + mtime into the PUT and into local state,
        // or the save would 409 as a phantom conflict and a retry would
        // re-rename from the now-gone old name.
        if (expectedMtime !== undefined) expectedMtime = r.skill.mtime;
        setDetail(r.skill);
        setDirty(true);
      }
      // An empty description can't be saved (the server requires min 1 char);
      // omit it so body-only edits to description-less skills still save.
      const desc = fDescription.trim();
      const body =
        tab === 'raw'
          ? { raw, expectedMtime }
          : { ...(desc ? { description: desc } : {}), body: fBody, expectedMtime };
      await skillsApi.save(scopeNow, nameNow, body);
      onToast(`Saved '${nameNow}'.`);
      onClose(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body?.code === 'conflict') {
        setConflict({ raw: String(e.body.raw ?? raw), mtime: Number(e.body.mtime ?? detail.mtime) });
        setBusy(null);
        return;
      }
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const doSync = async () => {
    if (!detail) return;
    setBusy('sync');
    setError(null);
    try {
      const r = await skillsApi.sync(detail.scope, detail.name);
      setDetail(r.skill);
      setDirty(true);
      setFName(r.skill.name);
      setFDescription(r.skill.description ?? '');
      setFBody(r.skill.body);
      setRaw(r.skill.content);
      onToast('Fixed for both providers.');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // ---------- rail actions ----------

  const toggle = async (p: SkillMeta) => {
    const next = !p.enabled;
    setPlacements((ps) => ps.map((x) => (x.scope === p.scope ? { ...x, enabled: next } : x)));
    setDirty(true);
    setError(null);
    try {
      const r = await skillsApi.patch(p.scope, name, { enabled: next });
      // Keep the editor baseline current (fresh mtime) when it's the open copy.
      if (p.scope === scope) setDetail((d) => (d ? { ...d, enabled: r.skill.enabled, mtime: r.skill.mtime } : d));
    } catch (e) {
      // Revert on failure.
      setPlacements((ps) => ps.map((x) => (x.scope === p.scope ? { ...x, enabled: !next } : x)));
      setError((e as Error).message);
    }
  };

  const doRemove = async (p: SkillMeta) => {
    setBusy('action');
    setError(null);
    try {
      await skillsApi.remove(p.scope, name);
      onToast(
        p.entryKind === 'link'
          ? `Removed the ${scopeLabel(groups, p.scope)} link. The original is safe.`
          : `Removed '${name}' from ${scopeLabel(groups, p.scope)}.`,
      );
      setConfirmRemove(null);
      setDirty(true);
      if (placements.length <= 1) {
        onClose(true);
        return;
      }
      await reload();
    } catch (e) {
      setError((e as Error).message);
      setConfirmRemove(null);
    } finally {
      setBusy(null);
    }
  };

  const keepGlobalOnly = async (original: SkillMeta) => {
    setBusy('action');
    setError(null);
    try {
      // A copy to a linked destination replaces that link with a real,
      // independent folder. Only then is it safe to remove the old original.
      await skillsApi.copy(original.scope, original.name, 'global');
      await skillsApi.remove(original.scope, original.name);
      onToast(`'${name}' is now Global only. The project original was removed safely.`);
      setConfirmRemove(null);
      setDirty(true);
      await reload();
    } catch (e) {
      setError((e as Error).message);
      setConfirmRemove(null);
    } finally {
      setBusy(null);
    }
  };

  const makeGlobal = async (from: SkillMeta) => {
    if (from.scope === scope && !confirmDiscard()) return;
    setBusy('action');
    setError(null);
    setPicker(null);
    try {
      await skillsApi.move(from.scope, name, 'global');
      onToast(`'${name}' is now global — every chat can use it.`);
      setDirty(true);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addToProject = async (toScope: string) => {
    // Fork from the global copy if there is one, else the first placement.
    const from = placements.find((p) => p.scope === 'global') ?? placements[0];
    if (!from) return;
    setBusy('action');
    setError(null);
    setPicker(null);
    try {
      await skillsApi.copy(from.scope, name, toScope);
      onToast(`Copied '${name}' to ${scopeLabel(groups, toScope)}.`);
      setDirty(true);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // ---------- render ----------

  const scopePills = placements.map((p) => ({ value: p.scope, label: scopeLabel(groups, p.scope) }));
  const selectedSourceLabel = detail?.source ? scopeLabel(groups, detail.source.scope) : 'an external folder';
  const selectedDependentLabels = detail?.dependents.map((p) => scopeLabel(groups, p.scope)) ?? [];
  const protectedOriginal = confirmRemove?.entryKind === 'original' && confirmRemove.dependents.length > 0;
  const globalOnlyOption =
    protectedOriginal &&
    confirmRemove.dependents.length === 1 &&
    confirmRemove.dependents[0]?.scope === 'global' &&
    confirmRemove.dependents[0]?.name === confirmRemove.name;

  const editorColumn =
    detail === null ? (
      error ? null : <p className="px-1 py-6 text-center text-sm text-muted-foreground">Loading…</p>
    ) : (
      <>
        {detail.entryKind === 'link' ? (
          <div className="flex items-start gap-2 rounded-xl bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            <Link2 className="size-4 h-lh shrink-0" />
            <p className="min-w-0 text-pretty">
              This is a link to the original in {selectedSourceLabel}. Changes here also change that original.
            </p>
          </div>
        ) : detail.dependents.length ? (
          <div className="rounded-xl bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            <p className="text-pretty">
              This is the original. {selectedDependentLabels.join(', ')} {selectedDependentLabels.length === 1 ? 'links' : 'link'} to it, so changes here apply there too.
            </p>
          </div>
        ) : null}

        {/* Not-shared banner */}
        {canEdit && !detail.shared && detail.enabled && detail.origin === 'user' ? (
          <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            <p>Only {providerWithSkill(detail)} can use this skill.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 rounded-lg"
              onPointerUp={() => void doSync()}
              disabled={busy !== null}
            >
              {busy === 'sync' ? 'Fixing…' : 'Enable for both providers'}
            </Button>
          </div>
        ) : null}

        {/* Issues banner */}
        {canEdit && detail.issues.length ? (
          <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            <p>{issueSummary(detail.issues)}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 rounded-lg"
              onPointerUp={() => void doSync()}
              disabled={busy !== null}
            >
              {busy === 'sync' ? 'Fixing…' : 'Fix for both providers'}
            </Button>
          </div>
        ) : null}

        {!canEdit ? (
          <div className="rounded-xl bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
            {readOnlyNotice(detail.origin)}
          </div>
        ) : (
          <Segmented
            value={tab}
            options={[
              { value: 'form', label: 'Form' },
              { value: 'raw', label: 'Raw' },
            ]}
            onChange={setTab}
          />
        )}

        {tab === 'form' || !canEdit ? (
          <>
            <Field label="Name">
              <Input
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={!canEdit}
                className="h-11 rounded-xl font-mono text-sm"
              />
            </Field>
            <Field label="What it's for" hint="The assistant reads this to decide when to use it.">
              <textarea
                value={fDescription}
                onChange={(e) => setFDescription(e.target.value)}
                rows={2}
                disabled={!canEdit}
                className="min-h-[44px] resize-y rounded-xl border bg-transparent px-3 py-2.5 text-sm outline-none focus:border-ring disabled:opacity-70"
              />
            </Field>
            <Field label="Instructions">
              <textarea
                value={fBody}
                onChange={(e) => setFBody(e.target.value)}
                disabled={!canEdit}
                className="min-h-[45vh] resize-y rounded-xl border bg-transparent px-3 py-2.5 font-mono text-sm outline-none focus:border-ring disabled:opacity-70"
              />
            </Field>
            {(() => {
              const kept = unknownFrontmatterKeys(detail.content);
              return kept.length ? (
                <p className="-mt-2 text-xs text-muted-foreground">Advanced fields kept: {kept.join(', ')}</p>
              ) : null;
            })()}
          </>
        ) : (
          <Field label="SKILL.md" hint="The whole file — fixes anything the form can't.">
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-h-[45vh] resize-y rounded-xl border bg-transparent px-3 py-2.5 font-mono text-sm outline-none focus:border-ring"
            />
          </Field>
        )}
      </>
    );

  const rail = (
    <>
      {/* Availability */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Availability</h2>
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground">Off hides it from both providers.</p>
            </div>
            {selected && isAdmin && !selected.readOnly ? (
              <Switch
                checked={selected.enabled}
                aria-label="Toggle enabled"
                onCheckedChange={() => selected && void toggle(selected)}
              />
            ) : (
              <span className="text-sm text-muted-foreground">{selected?.enabled ? 'On' : 'Off'}</span>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
            <span className="text-sm text-muted-foreground">Available to</span>
            <ProviderBadges providers={(detail ?? selected)?.providers ?? { claude: 'missing', codex: 'missing', grok: 'missing' }} />
          </div>
        </div>
      </section>

      {/* Where it's active */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Where it’s active</h2>
        <div className="rounded-xl border bg-card">
          {placements.map((p, i) => (
            <div key={p.scope} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t' : ''}`}>
              <button
                type="button"
                onPointerUp={() => switchScope(p.scope)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label={`Edit ${name} in ${scopeLabel(groups, p.scope)}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{scopeLabel(groups, p.scope)}</p>
                  {p.entryKind === 'link' ? (
                    <div className="flex min-w-0 items-start gap-1 text-sm text-muted-foreground">
                      <Link2 className="size-4 h-lh shrink-0" />
                      <p className="min-w-0 truncate">
                        Linked to {p.source ? scopeLabel(groups, p.source.scope) : 'an external folder'}
                        {p.enabled ? '' : ' · Off'}
                        {p.scope === scope ? ' · Editing' : ''}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Original · {p.enabled ? 'Active' : 'Off'}
                      {p.scope === scope ? ' · Editing' : ''}
                    </p>
                  )}
                </div>
                <IssueBadge count={p.issues.length} />
              </button>
              {isAdmin && !p.readOnly ? (
                <Switch
                  checked={p.enabled}
                  aria-label={`Toggle ${scopeLabel(groups, p.scope)}`}
                  onCheckedChange={() => void toggle(p)}
                />
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* Actions */}
      {isAdmin ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Actions</h2>
          <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
            {!hasGlobal ? (
              <Button
                variant="outline"
                className="h-11 justify-start rounded-xl"
                onPointerUp={() =>
                  placements.length > 1 ? setPicker('make-global') : makeGlobal(placements[0]!)
                }
                disabled={busy !== null || placements.length === 0}
              >
                Make global
              </Button>
            ) : hasLinkedPlacements ? (
              <p className="px-1 text-sm text-pretty text-muted-foreground">
                Linked placements use the same original file. Changes apply everywhere the skill is linked.
              </p>
            ) : projectPlacements.length ? (
              <p className="px-1 text-xs text-muted-foreground">
                Copies in {projectPlacements.map((p) => scopeLabel(groups, p.scope)).join(', ')} shadow
                the global one for chats in those projects.
              </p>
            ) : null}

            {projectTargets.length ? (
              <Button
                variant="outline"
                className="h-11 justify-start rounded-xl"
                onPointerUp={() => setPicker('add-project')}
                disabled={busy !== null}
              >
                <Plus />
                Add to a project…
              </Button>
            ) : null}

            {selected && !selected.readOnly ? (
              <Button
                variant="ghost"
                className="h-11 justify-start rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
                onPointerUp={() => setConfirmRemove(selected)}
                disabled={busy !== null}
              >
                {selected.entryKind === 'link'
                  ? `Remove ${scopeLabel(groups, selected.scope)} link…`
                  : `Remove from ${scopeLabel(groups, selected.scope)}…`}
              </Button>
            ) : null}
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            “Make global” moves the one folder so every chat can use it. “Add to a project” copies it
            into that project as an independent fork.
          </p>
        </section>
      ) : null}
    </>
  );

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Button
          variant="ghost"
          size="icon-lg"
          className="rounded-full"
          onPointerUp={() => onClose(dirty)}
          aria-label="Back"
        >
          <ChevronLeft className="size-5" />
        </Button>
        <p className="min-w-0 flex-1 truncate font-medium">{detail?.name ?? name}</p>
        {canEdit ? (
          <Button className="rounded-xl" onPointerUp={() => void doSave()} disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
        ) : null}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+3rem)]">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-5">
            {scopePills.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm text-muted-foreground">Editing the placement in</p>
                <Segmented value={scope} options={scopePills} onChange={switchScope} />
              </div>
            ) : null}
            {editorColumn}
            {error ? (
              <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
            ) : null}
          </div>
          <div className="flex flex-col gap-5">{rail}</div>
        </div>
      </div>

      {/* Remove confirmation */}
      <Dialog open={confirmRemove !== null} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {confirmRemove?.entryKind === 'link'
                ? `Remove the ${scopeLabel(groups, confirmRemove.scope)} link?`
                : protectedOriginal
                  ? 'This is the original skill.'
                  : `Delete the ${confirmRemove ? scopeLabel(groups, confirmRemove.scope) : ''} original?`}
            </DialogTitle>
            <DialogDescription>
              {confirmRemove?.entryKind === 'link'
                ? `This removes only the link. The original in ${confirmRemove.source ? scopeLabel(groups, confirmRemove.source.scope) : 'its source folder'} and all of its files stay safe.`
                : protectedOriginal
                  ? `${confirmRemove.dependents.map((p) => scopeLabel(groups, p.scope)).join(', ')} ${confirmRemove.dependents.length === 1 ? 'uses a link' : 'use links'} to this file. Veneer will not delete the original while those links depend on it.${globalOnlyOption ? ' You can keep the Global skill and safely remove this project original.' : ' Remove the linked placements first.'}`
                  : `This permanently deletes the original folder and its files${confirmRemove && confirmRemove.hasExtraFiles ? detail && confirmRemove.scope === scope && detail.extraFiles.length ? ` (${detail.extraFiles.join(', ')})` : ' (including its extra files)' : ''}${confirmRemove?.scope === 'source' ? ' from the app’s source checkout.' : '.'}`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11 flex-1 rounded-xl" onPointerUp={() => setConfirmRemove(null)}>
              {protectedOriginal ? 'Cancel' : 'Keep'}
            </Button>
            {globalOnlyOption ? (
              <Button
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => confirmRemove && void keepGlobalOnly(confirmRemove)}
                disabled={busy !== null}
              >
                {busy === 'action' ? 'Working…' : 'Keep Global only'}
              </Button>
            ) : protectedOriginal ? null : (
              <Button
                className="h-11 flex-1 rounded-xl bg-destructive/10 text-destructive hover:bg-destructive/20"
                onPointerUp={() => confirmRemove && void doRemove(confirmRemove)}
                disabled={busy !== null}
              >
                {busy === 'action'
                  ? 'Removing…'
                  : confirmRemove?.entryKind === 'link'
                    ? 'Remove link'
                    : 'Delete original'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Make-global source picker (>1 placement) */}
      <Dialog open={picker === 'make-global'} onOpenChange={(o) => !o && setPicker(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Make ‘{name}’ global</DialogTitle>
            <DialogDescription>Which copy should become the single global one?</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {placements.map((p) => (
              <Button
                key={p.scope}
                variant="outline"
                className="h-11 justify-start rounded-xl"
                onPointerUp={() => void makeGlobal(p)}
                disabled={busy !== null}
              >
                {scopeLabel(groups, p.scope)}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add-to-project picker */}
      <Dialog open={picker === 'add-project'} onOpenChange={(o) => !o && setPicker(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Add ‘{name}’ to a project</DialogTitle>
            <DialogDescription>Copies the skill into that project as an independent fork.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {projectTargets.map((g) => (
              <Button
                key={g.scope}
                variant="outline"
                className="h-11 justify-start rounded-xl"
                onPointerUp={() => void addToProject(g.scope)}
                disabled={busy !== null}
              >
                {g.label}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Concurrent-edit conflict */}
      <Dialog open={conflict !== null} onOpenChange={(o) => !o && setConflict(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Changed elsewhere</DialogTitle>
            <DialogDescription>
              This skill was edited somewhere else since you opened it. Reload their version, or overwrite it with your
              changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => {
                if (conflict && detail) {
                  setRaw(conflict.raw);
                  setDetail({ ...detail, content: conflict.raw, mtime: conflict.mtime });
                  setTab('raw');
                }
                setConflict(null);
              }}
            >
              Reload their version
            </Button>
            <Button
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => {
                setConflict(null);
                void doSave(true);
              }}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
