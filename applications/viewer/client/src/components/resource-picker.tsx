import type { ResourceSummary } from '../api/client.ts';

/**
 * Server first, then what runs on it.
 *
 * Two controls, not one, because they answer two different questions: which
 * machine am I looking at, and which part of it. The single flat list this
 * replaced put `container:preussen-mongo` next to
 * `requests:www.woofi-developments.at` in one alphabetical run, so finding an
 * app meant reading past every request host.
 *
 * Sub-resources carry their kind as a `type:name` prefix (`container:`,
 * `requests:`, and the bare `collector`), which is exactly an `<optgroup>`:
 * the prefix becomes the group heading and the option shows the plain name.
 *
 * Native `<select>` over a custom menu because the browser already gives this
 * keyboard support, type-ahead, a popup that escapes the header, and correct
 * behaviour on a phone.
 */

export interface Selection {
  readonly resource: string;
  readonly subResource?: string | undefined;
}

/** Heading for each prefix, in the order the groups should appear. */
const KIND_LABELS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['container:', 'Apps'],
  ['requests:', 'Request hosts'],
];

const SELECT_CLASS =
  'max-w-[16rem] truncate rounded-sm border border-line-strong bg-bg-800 px-2 py-1 font-mono text-[12px] text-ink transition-colors duration-150 hover:border-ink-muted';

/** `container:preussen-mongo` -> `preussen-mongo`. */
function plainName(subResource: string, prefix: string): string {
  return subResource.slice(prefix.length);
}

export function ResourcePicker({
  resources,
  value,
  onChange,
}: {
  resources: readonly ResourceSummary[];
  value: Selection;
  onChange: (next: Selection) => void;
}) {
  const entry = resources.find((candidate) => candidate.resource === value.resource);
  const subResources = entry?.subResources ?? [];

  const grouped = KIND_LABELS.map(([prefix, label]) => ({
    prefix,
    label,
    items: subResources.filter((sub) => sub.startsWith(prefix)),
  })).filter((group) => group.items.length > 0);

  // Anything with no recognised prefix - `collector` today - still has to be
  // reachable, or a sub-resource would silently disappear from the picker the
  // moment a sender invents a new kind.
  const ungrouped = subResources.filter(
    (sub) => !KIND_LABELS.some(([prefix]) => sub.startsWith(prefix)),
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor="server-picker" className="text-[12px] text-ink-dim">
        Server
      </label>
      <select
        id="server-picker"
        value={value.resource}
        onChange={(event) => onChange({ resource: event.target.value })}
        className={SELECT_CLASS}
      >
        {resources.map((candidate) => (
          <option key={candidate.resource} value={candidate.resource}>
            {candidate.resource}
          </option>
        ))}
      </select>

      <label htmlFor="scope-picker" className="text-[12px] text-ink-dim">
        Showing
      </label>
      <select
        id="scope-picker"
        value={value.subResource ?? ''}
        onChange={(event) =>
          onChange({
            resource: value.resource,
            subResource: event.target.value === '' ? undefined : event.target.value,
          })
        }
        className={SELECT_CLASS}
      >
        {/* The whole machine: the host-level envelope, which is what the
            collector writes with no sub-resource at all. */}
        <option value="">Whole server</option>

        {grouped.map((group) => (
          <optgroup key={group.prefix} label={group.label}>
            {group.items.map((sub) => (
              <option key={sub} value={sub}>
                {plainName(sub, group.prefix)}
              </option>
            ))}
          </optgroup>
        ))}

        {ungrouped.length > 0 && (
          <optgroup label="Other">
            {ungrouped.map((sub) => (
              <option key={sub} value={sub}>
                {sub}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
