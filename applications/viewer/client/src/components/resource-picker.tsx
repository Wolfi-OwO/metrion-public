import type { ResourceSummary } from '../api/client.ts';

/**
 * Resource and sub-resource in one native `<select>`.
 *
 * A native select over a custom menu because the browser already gives this
 * one keyboard support, type-ahead, a scrollable popup that escapes the
 * header, and correct behaviour on a phone - and `<optgroup>` expresses
 * exactly the shape of the data, a resource holding its sub-resources.
 *
 * The value is an index pair rather than a joined string: sub-resources are
 * free-form (`container:preussen-mongo`, `requests:example.org`), so any
 * delimiter chosen here would eventually appear inside a name.
 */

export interface Selection {
  readonly resource: string;
  readonly subResource?: string | undefined;
}

function encode(resourceIndex: number, subIndex: number): string {
  return `${resourceIndex}:${subIndex}`;
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
  const resourceIndex = resources.findIndex((entry) => entry.resource === value.resource);
  const subIndex =
    value.subResource === undefined
      ? -1
      : (resources[resourceIndex]?.subResources.indexOf(value.subResource) ?? -1);

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="resource-picker" className="text-[12px] text-ink-dim">
        Watching
      </label>
      <select
        id="resource-picker"
        value={encode(resourceIndex, subIndex)}
        onChange={(event) => {
          const [nextResource, nextSub] = event.target.value.split(':').map(Number);
          const resource = resources[nextResource ?? 0];
          if (!resource) return;
          onChange({
            resource: resource.resource,
            subResource: nextSub === -1 ? undefined : resource.subResources[nextSub ?? 0],
          });
        }}
        className="max-w-[18rem] truncate rounded-sm border border-line-strong bg-bg-800 px-2 py-1 font-mono text-[12px] text-ink transition-colors duration-150 hover:border-ink-muted"
      >
        {resources.map((entry, entryIndex) => (
          <optgroup key={entry.resource} label={entry.resource}>
            {/* The resource name is repeated inside each option on purpose.
                A closed select shows the option's text and NOT its optgroup
                label, so an option reading just "overall" would leave the
                header unable to say which machine is on screen. */}
            <option value={encode(entryIndex, -1)}>{entry.resource}</option>
            {entry.subResources.map((subResource, index) => (
              <option key={subResource} value={encode(entryIndex, index)}>
                {entry.resource} / {subResource}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
