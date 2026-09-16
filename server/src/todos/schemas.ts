import { z } from 'zod';

export const TodoLinkSchema = z.object({
  kind: z.enum(['link', 'file']),
  href: z.string().trim().min(1).max(2000),
  label: z.string().max(500).nullable().optional(),
});

export const TodoProjectIdSchema = z.string().trim().min(1).max(64);

export const TodoCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    notes: z.string().max(20_000).optional(),
    categoryId: z.string().nullable().optional(),
    projectId: TodoProjectIdSchema.nullable().optional(),
    links: z.array(TodoLinkSchema).max(50).optional(),
  })
  .strict();

export const TodoAgentPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    notes: z.string().max(20_000).optional(),
    categoryId: z.string().nullable().optional(),
    projectId: TodoProjectIdSchema.nullable().optional(),
    action: z.enum(['complete', 'reopen']).optional(),
    linksAdd: z.array(TodoLinkSchema).max(50).optional(),
    linkIdsRemove: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'no fields to update');

export const TodoListQuerySchema = z.object({
  state: z.enum(['pending', 'active', 'done']).optional(),
  query: z.string().max(500).optional(),
  categoryId: z.string().max(200).optional(),
  projectId: z.string().max(200).optional(),
});

export const HubTodoIdempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(200)
  .regex(/^[a-zA-Z0-9:_-]+$/);
