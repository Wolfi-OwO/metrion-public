/**
 * Client-side mirrors of the server's own zod constraints
 * (`applications/viewer/src/schemas/projects.schemas.ts`), for feedback
 * before a round trip. The server re-validates on every request regardless -
 * this exists to fix a mistake before it is submitted, not to replace that
 * check.
 */
export function projectNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Enter a name for the project.';
  if (trimmed.length > 200) return 'Keep the name under 200 characters.';
  return null;
}
