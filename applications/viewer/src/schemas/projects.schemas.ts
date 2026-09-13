import { z } from 'zod';

/**
 * `POST /api/v1/projects`'s body. `slug` is never accepted from the caller -
 * `handlers/projects.handlers.ts` derives it from `name` and owns making it
 * unique - so this is the one schema, unlike `metrics.schemas.ts`'s pair,
 * this task needs.
 */
export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    defaultResource: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateProjectBody = z.infer<typeof createProjectSchema>;
