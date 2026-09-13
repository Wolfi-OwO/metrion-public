/**
 * Wraps `navigator.clipboard.writeText` - native, needs no dependency, and
 * unavailable in exactly the cases (denied permission, insecure context)
 * where a caller should fall back to a manual select-and-copy affordance
 * rather than claim success it cannot back up.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
