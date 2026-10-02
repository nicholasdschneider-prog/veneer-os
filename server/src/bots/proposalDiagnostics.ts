import { z } from 'zod';
import { autoshipProposalSchema, proposalSchema } from './service.js';

// Only schema-owned field names are exposed. Unrecognized keys and input values
// (including Zod messages that interpolate them) never enter the response.
const fields = new Set(['proposal']);
function collect(schema: z.ZodTypeAny): void {
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape)) { fields.add(key); collect(child as z.ZodTypeAny); }
  } else if (schema instanceof z.ZodArray) collect(schema.element);
  else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) schema.options.forEach(collect);
  else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) collect(schema.unwrap());
  else if (schema instanceof z.ZodDefault) collect(schema.removeDefault());
  else if (schema instanceof z.ZodEffects) collect(schema.innerType());
}
collect(autoshipProposalSchema);

/** Diagnostics only: never changes which input the route accepts. */
export function proposalDiagnostics(input: unknown): string {
  const kind = input && typeof input === 'object' ? (input as { kind?: unknown }).kind : undefined;
  const result = (kind === 'autoship_package' ? autoshipProposalSchema : proposalSchema).safeParse(input);
  if (result.success) return 'proposal: Invalid input';
  const messages = new Set<string>();
  let visited = 0;
  let omitted = false;
  function visit(issues: z.ZodIssue[], depth: number): void {
    for (const issue of issues) {
      if (++visited > 80 || messages.size >= 12 || depth > 6) { omitted = true; return; }
      if (issue.code === 'invalid_union') { for (const branch of issue.unionErrors) visit(branch.issues, depth + 1); continue; }
      const path = ['proposal', ...issue.path].slice(0, 16).map(part => typeof part === 'number' ? part : fields.has(part) ? part : '[field]').join('.');
      const detail = issue.code === 'unrecognized_keys' ? 'Unexpected fields for this variant (remove cross-variant fields)'
        : issue.code === 'invalid_type' ? 'Required field missing or wrong type'
        : issue.code === 'too_small' ? 'Below minimum size or value'
        : issue.code === 'too_big' ? 'Exceeds maximum size or value'
        : issue.code === 'invalid_union_discriminator' ? 'Invalid source or variant discriminator'
        : issue.code === 'invalid_string' ? 'Invalid string format'
        : issue.code === 'invalid_enum_value' || issue.code === 'invalid_literal' ? 'Invalid allowed value'
        : 'Invalid value or constraint';
      messages.add(`${path}: ${detail}`);
    }
  }
  visit(result.error.issues, 0);
  return [...messages, ...(omitted ? ['Additional validation issues omitted; correct these fields and validate again.'] : [])].join('; ');
}
