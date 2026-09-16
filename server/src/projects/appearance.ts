import { z } from 'zod';

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const colorField = z
  .string()
  .trim()
  .refine((value) => value === '' || HEX_COLOR.test(value), 'Must be a hex color like #8a6d47')
  .optional();

/**
 * A project's optional design overrides. Empty fields inherit the site-wide
 * published-content brand, which in turn falls back to Veneer's house style.
 */
export const ProjectAppearanceSchema = z.object({
  primaryColor: colorField,
  accentColor: colorField,
  backgroundColor: colorField,
  // Body typeface. Named `font` since before headings had their own setting.
  font: z.string().trim().max(120).optional(),
  headingFont: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(600).optional(),
});

export type ProjectAppearance = z.infer<typeof ProjectAppearanceSchema>;

export const EMPTY_PROJECT_APPEARANCE: Required<ProjectAppearance> = {
  primaryColor: '',
  accentColor: '',
  backgroundColor: '',
  font: '',
  headingFont: '',
  notes: '',
};

export const VENEER_HOUSE_APPEARANCE: Required<ProjectAppearance> = {
  primaryColor: '#26221c',
  accentColor: '#8a6d47',
  backgroundColor: '#faf7f2',
  font: 'Inter',
  // Blank: the house style names its heading options in the notes instead.
  headingFont: '',
  notes:
    'Use soft cream panels #f0e7d8 and muted gray-brown #6f675c. Headings may use Iowan Old Style, Palatino, or Georgia. Keep the design clean and minimal with generous whitespace.',
};

export function normalizeProjectAppearance(value: ProjectAppearance | undefined): Required<ProjectAppearance> {
  return { ...EMPTY_PROJECT_APPEARANCE, ...value };
}

export function withAppearanceFallback(
  preferred: ProjectAppearance | null,
  fallback: Required<ProjectAppearance>,
): Required<ProjectAppearance> {
  return {
    primaryColor: preferred?.primaryColor || fallback.primaryColor,
    accentColor: preferred?.accentColor || fallback.accentColor,
    backgroundColor: preferred?.backgroundColor || fallback.backgroundColor,
    font: preferred?.font || fallback.font,
    headingFont: preferred?.headingFont || fallback.headingFont,
    notes: preferred?.notes || fallback.notes,
  };
}

export function effectiveProjectAppearance(
  projectAppearance: ProjectAppearance,
  siteAppearance: ProjectAppearance | null,
): Required<ProjectAppearance> {
  const effectiveSiteAppearance = withAppearanceFallback(siteAppearance, VENEER_HOUSE_APPEARANCE);
  return withAppearanceFallback(projectAppearance, effectiveSiteAppearance);
}

/** Invalid legacy/corrupt JSON safely degrades to an unset appearance. */
export function readProjectAppearance(valueJson: string): Required<ProjectAppearance> {
  try {
    const parsed = ProjectAppearanceSchema.safeParse(JSON.parse(valueJson));
    return parsed.success ? normalizeProjectAppearance(parsed.data) : { ...EMPTY_PROJECT_APPEARANCE };
  } catch {
    return { ...EMPTY_PROJECT_APPEARANCE };
  }
}

export function hasProjectAppearance(appearance: ProjectAppearance): boolean {
  return Object.values(appearance).some((value) => typeof value === 'string' && value.trim() !== '');
}
