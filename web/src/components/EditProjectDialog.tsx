import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown, Palette, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { AssistantType } from '../lib/api';
import type { Project, ProjectAppearance } from '../lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const EMPTY_APPEARANCE: ProjectAppearance = {
  primaryColor: '',
  accentColor: '',
  backgroundColor: '',
  font: '',
  notes: '',
};

const HOUSE_APPEARANCE: ProjectAppearance = {
  primaryColor: '#26221c',
  accentColor: '#8a6d47',
  backgroundColor: '#faf7f2',
  font: 'Inter',
  notes: '',
};

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isValidHex = (value: string) => value === '' || HEX_RE.test(value.trim());
const hasAppearance = (appearance: ProjectAppearance) =>
  Object.values(appearance).some((value) => value.trim() !== '');

/**
 * Edit project context and appearance. Empty appearance fields inherit the
 * site-wide published-content brand; existing pages/apps are not rewritten.
 */
export function EditProjectDialog({
  open,
  project,
  canDelete,
  onOpenChange,
  onSaved,
  onDeleted,
  onToast,
}: {
  open: boolean;
  project: Project;
  canDelete: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (project: Project) => void;
  onDeleted: () => void;
  onToast?: (message: string) => void;
}) {
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.instructions);
  const [defaultAgent, setDefaultAgent] = useState(project.defaultAgent ?? '');
  const [appearance, setAppearance] = useState<ProjectAppearance>(project.appearance);
  const [siteAppearance, setSiteAppearance] = useState<ProjectAppearance>(EMPTY_APPEARANCE);
  const [agents, setAgents] = useState<AssistantType[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(project.name);
      setInstructions(project.instructions);
      setDefaultAgent(project.defaultAgent ?? '');
      setAppearance({ ...EMPTY_APPEARANCE, ...project.appearance });
      setConfirmDelete(false);
      setError(null);
      setBusy(false);
      void Promise.all([
        api.assistants().then((result) => setAgents(result.assistants)).catch(() => setAgents([])),
        api
          .pageBrand()
          .then((result) => setSiteAppearance(result.brand))
          .catch(() => setSiteAppearance(EMPTY_APPEARANCE)),
      ]);
    }
  }, [open, project]);

  const colorsValid =
    isValidHex(appearance.primaryColor) &&
    isValidHex(appearance.accentColor) &&
    isValidHex(appearance.backgroundColor);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy || !colorsValid) return;
    setBusy(true);
    setError(null);
    try {
      const { project: updated } = await api.updateProject(project.id, {
        name: trimmed,
        instructions,
        appearance: {
          primaryColor: appearance.primaryColor.trim(),
          accentColor: appearance.accentColor.trim(),
          backgroundColor: appearance.backgroundColor.trim(),
          font: appearance.font.trim(),
          notes: appearance.notes.trim(),
        },
        ...(defaultAgent !== (project.defaultAgent ?? '') ? { defaultAgent: defaultAgent || null } : {}),
      });
      onToast?.('Project updated');
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        showCloseButton={!confirmDelete}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      >
        {confirmDelete ? (
          <>
            <DialogHeader>
              <DialogTitle>Delete this project?</DialogTitle>
              <DialogDescription>
                This permanently deletes “{project.name}” and its {project.chatCount}{' '}
                {project.chatCount === 1 ? 'chat' : 'chats'}, including archived ones. This can't be undone.
              </DialogDescription>
            </DialogHeader>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => setConfirmDelete(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => void doDelete()}
                disabled={busy}
              >
                Delete project
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Project settings</DialogTitle>
              <DialogDescription>Shared context and design for every chat in this project.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {project.rootDir ? (
                <p className="break-all rounded-xl border bg-card px-3 py-2 font-mono text-xs text-muted-foreground">
                  {project.rootDir}
                </p>
              ) : null}
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Default agent</span>
                <select
                  name="defaultAgent"
                  value={defaultAgent}
                  onChange={(e) => setDefaultAgent(e.target.value)}
                  className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                >
                  <option value="">Use site default</option>
                  {defaultAgent && !agents.some((agent) => agent.slug === defaultAgent) ? (
                    <option value={defaultAgent} disabled>
                      Current agent (unavailable)
                    </option>
                  ) : null}
                  {agents.map((agent) => (
                    <option key={agent.slug} value={agent.slug}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">New chats in this project open with this agent.</span>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Name</span>
                <input
                  name="projectName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  Context <span className="font-normal text-muted-foreground">(saved by new chats)</span>
                </span>
                <textarea
                  name="projectContext"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="What this project is about, goals, useful background…"
                  rows={5}
                  className="resize-none rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                />
                <span className="text-xs text-muted-foreground">Existing chats keep their fixed context snapshot.</span>
              </label>

              <details className="group/appearance border-t pt-4">
                <summary className="flex cursor-pointer list-none items-start gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <Palette className="size-4 shrink-0 text-brand" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">Appearance</span>
                    <p className="text-xs text-muted-foreground">
                      New pages and apps inherit these choices. Blank fields use site defaults.
                    </p>
                  </div>
                  <ChevronDown
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-open/appearance:rotate-180"
                    aria-hidden="true"
                  />
                </summary>

                <div className="mt-3 flex flex-col gap-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-end rounded-lg"
                    onPointerUp={() => setAppearance({ ...EMPTY_APPEARANCE })}
                    disabled={!hasAppearance(appearance) || busy}
                  >
                    Reset
                  </Button>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <AppearanceColorField
                      label="Primary"
                      name="primaryColor"
                      fallback={siteAppearance.primaryColor || HOUSE_APPEARANCE.primaryColor}
                      value={appearance.primaryColor}
                      onChange={(value) => setAppearance((current) => ({ ...current, primaryColor: value }))}
                    />
                    <AppearanceColorField
                      label="Accent"
                      name="accentColor"
                      fallback={siteAppearance.accentColor || HOUSE_APPEARANCE.accentColor}
                      value={appearance.accentColor}
                      onChange={(value) => setAppearance((current) => ({ ...current, accentColor: value }))}
                    />
                    <AppearanceColorField
                      label="Background"
                      name="backgroundColor"
                      fallback={siteAppearance.backgroundColor || HOUSE_APPEARANCE.backgroundColor}
                      value={appearance.backgroundColor}
                      onChange={(value) => setAppearance((current) => ({ ...current, backgroundColor: value }))}
                    />
                  </div>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Font</span>
                    <input
                      name="appearanceFont"
                      value={appearance.font}
                      onChange={(event) =>
                        setAppearance((current) => ({ ...current, font: event.target.value }))
                      }
                      placeholder={siteAppearance.font || HOUSE_APPEARANCE.font}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      autoComplete="off"
                      className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                    />
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Style notes</span>
                    <textarea
                      name="appearanceNotes"
                      value={appearance.notes}
                      onChange={(event) =>
                        setAppearance((current) => ({ ...current, notes: event.target.value }))
                      }
                      maxLength={600}
                      rows={3}
                      placeholder={siteAppearance.notes || 'e.g. Editorial, spacious, square buttons, subtle borders…'}
                      className="resize-none rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                    />
                    <p className="text-xs text-muted-foreground">
                      {600 - appearance.notes.length} characters left
                    </p>
                  </label>

                  <AppearancePreview appearance={appearance} siteAppearance={siteAppearance} />
                </div>
              </details>

              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button
                type="button"
                className="h-11 rounded-xl"
                onPointerUp={() => void save()}
                disabled={busy || !name.trim() || !colorsValid}
              >
                Save
              </Button>
              {canDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 justify-start gap-2 rounded-xl text-destructive"
                  onPointerUp={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  <Trash2 className="size-4" />
                  Delete project
                </Button>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AppearanceColorField({
  label,
  name,
  fallback,
  value,
  onChange,
}: {
  label: string;
  name: string;
  fallback: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const valid = isValidHex(value);
  const swatch = valid && value.trim() ? value.trim() : fallback;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="color"
          name={`${name}Picker`}
          value={swatch}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${label} color picker`}
          className="size-10 shrink-0 cursor-pointer rounded-lg border bg-card p-1"
        />
        <input
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={fallback}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          aria-label={`${label} color hex value`}
          aria-invalid={!valid}
          className={`min-w-0 flex-1 rounded-lg border bg-card px-2 py-2 font-mono text-[16px] outline-none focus:border-ring ${
            valid ? '' : 'border-destructive focus:border-destructive'
          }`}
        />
      </div>
      {!valid ? <p className="text-xs text-destructive">Use a hex color like #8a6d47.</p> : null}
    </div>
  );
}

function AppearancePreview({
  appearance,
  siteAppearance,
}: {
  appearance: ProjectAppearance;
  siteAppearance: ProjectAppearance;
}) {
  const effective = {
    primaryColor:
      appearance.primaryColor || siteAppearance.primaryColor || HOUSE_APPEARANCE.primaryColor,
    accentColor: appearance.accentColor || siteAppearance.accentColor || HOUSE_APPEARANCE.accentColor,
    backgroundColor:
      appearance.backgroundColor || siteAppearance.backgroundColor || HOUSE_APPEARANCE.backgroundColor,
    font: appearance.font || siteAppearance.font || HOUSE_APPEARANCE.font,
  };

  useEffect(() => {
    const family = effective.font.trim();
    if (!family || family.toLowerCase() === 'inter') return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;600;700&display=swap`;
    document.head.appendChild(link);
    return () => link.remove();
  }, [effective.font]);

  const previewStyle = useMemo(
    () =>
      ({
        '--project-preview-bg': effective.backgroundColor,
        '--project-preview-primary': effective.primaryColor,
        '--project-preview-accent': effective.accentColor,
        fontFamily: `'${effective.font.replace(/'/g, '')}', ui-sans-serif, system-ui, sans-serif`,
      }) as CSSProperties,
    [effective.accentColor, effective.backgroundColor, effective.font, effective.primaryColor],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">Preview</p>
      <div
        className="overflow-hidden rounded-xl border bg-[var(--project-preview-bg)] text-[var(--project-preview-primary)]"
        style={previewStyle}
      >
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <p className="truncate font-semibold">Project launch</p>
            <p className="truncate text-xs opacity-70">A consistent page or app experience</p>
          </div>
          <div
            className="shrink-0 rounded-full bg-[var(--project-preview-accent)] px-3 py-1.5 text-xs font-semibold text-white"
          >
            Explore
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {hasAppearance(appearance) ? 'Project overrides applied.' : 'Using site defaults.'}
      </p>
    </div>
  );
}
