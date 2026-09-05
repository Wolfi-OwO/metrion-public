import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads a small JSON state file, returning `undefined` if it doesn't exist
 * yet (first run) or fails to parse (corrupt - treated the same as "no
 * prior state" rather than crashing the whole minute's run over it).
 */
export function readJsonState<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Write-then-rename so a crash mid-write never leaves a half-written state file behind. */
export function writeJsonState(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value));
  fs.renameSync(tmpPath, filePath);
}
