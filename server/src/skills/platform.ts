import fs from 'node:fs';
import path from 'node:path';
import {
  currentHomes,
  proClaudeConfigDir,
  proCodexHome,
  proGrokHome,
  type Homes,
} from '../homes.js';

export const PLATFORM_SKILL_NAMES = [
  'veneer-publish-page',
  'veneer-todos',
  'veneer-paper-design',
  // Design/UI family shipped with the product (originally ui.sh + personal skills).
  'design',
  'add-dark-mode',
  'brand-kit',
  'canonicalize-tailwind',
  'componentize',
  'dark-mode-image',
  'hallmark',
  'ideas',
  'make-responsive',
  'markup-from-image',
  'ui',
  'web-design-guidelines',
  'web-perf',
] as const;
export const PLATFORM_SKILL_MARKER = '.veneer-platform-skill.json';

export interface PlatformSkillInstall {
  name: string;
  source: string;
  claudePath: string;
  codexPath: string;
  grokPath: string;
}

/**
 * Tracked, product-owned skills shipped in this checkout. They sit at the root
 * of the repo, so the runner resolves them from `VP_SOURCE_DIR` with no extra
 * path prefix.
 */
export function platformSkillsRoot(sourceDir: string): string {
  return path.join(sourceDir, 'agent-skills');
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function realpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function markerData(name: string): string {
  return `${JSON.stringify({ owner: 'veneer-pro', name }, null, 2)}\n`;
}

/** True only for a provider copy that Veneer Pro owns and may replace. */
export function isInstalledPlatformSkill(directory: string, expectedName?: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, PLATFORM_SKILL_MARKER), 'utf8')) as {
      owner?: unknown;
      name?: unknown;
    };
    return parsed.owner === 'veneer-pro' &&
      typeof parsed.name === 'string' &&
      (!expectedName || parsed.name === expectedName);
  } catch {
    return false;
  }
}

/**
 * Materialize one provider-readable copy of a product skill. Claude ignores a
 * user skill whose top-level folder is a symlink, so both providers get the
 * same managed copy. The marker is the ownership boundary: never replace an
 * unmarked user file or directory with the reserved platform skill name.
 */
function installSkillCopy(target: string, source: string, name: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = lstatOrNull(target);
  const migratableLink = existing?.isSymbolicLink() && realpathOrNull(target) === fs.realpathSync(source);
  if (existing && !isInstalledPlatformSkill(target, name) && !migratableLink) {
    throw new Error(`Cannot install the Veneer platform skill because ${target} already exists and is not owned by Veneer Pro.`);
  }

  const replacement = `${target}.${process.pid}.${Date.now()}.tmp`;
  const previous = `${target}.${process.pid}.${Date.now()}.previous`;
  let movedPrevious = false;
  try {
    fs.cpSync(source, replacement, { recursive: true });
    fs.writeFileSync(path.join(replacement, PLATFORM_SKILL_MARKER), markerData(name), { mode: 0o644 });
    if (existing) {
      fs.renameSync(target, previous);
      movedPrevious = true;
    }
    try {
      fs.renameSync(replacement, target);
    } catch (err) {
      if (movedPrevious) fs.renameSync(previous, target);
      throw err;
    }
    if (movedPrevious) fs.rmSync(previous, { recursive: true, force: true });
  } finally {
    fs.rmSync(replacement, { recursive: true, force: true });
    if (movedPrevious && lstatOrNull(previous)) fs.rmSync(previous, { recursive: true, force: true });
  }
}

/** Install all product skills into the pinned provider profiles. */
export function installPlatformSkills({
  sourceDir,
  homes = currentHomes(),
}: {
  sourceDir: string;
  homes?: Homes;
}): PlatformSkillInstall[] {
  const root = platformSkillsRoot(sourceDir);
  return PLATFORM_SKILL_NAMES.map((name) => {
    const source = path.join(root, name);
    const skillFile = path.join(source, 'SKILL.md');
    if (!lstatOrNull(skillFile)?.isFile()) {
      throw new Error(`Veneer platform skill is missing: ${skillFile}`);
    }

    const codexPath = path.join(proCodexHome(homes), 'skills', name);
    const claudePath = path.join(proClaudeConfigDir(homes), 'skills', name);
    const grokPath = path.join(proGrokHome(homes), 'skills', name);
    installSkillCopy(codexPath, source, name);
    installSkillCopy(claudePath, source, name);
    installSkillCopy(grokPath, source, name);
    return { name, source, claudePath, codexPath, grokPath };
  });
}
