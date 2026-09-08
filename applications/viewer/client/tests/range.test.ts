import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGrid,
  chooseStepSeconds,
  clampRange,
  findBlankBands,
  MAX_RANGE_DAYS,
  RANGE_PRESETS,
  rangeFor,
} from '../src/lib/range.ts';
import { groupByUnit } from '../src/lib/groups.ts';

const MINUTE = 60_000;
const at = (minutes: number) => new Date(minutes * MINUTE).toISOString();

test('no preset can build a range the API would reject', () => {
  const now = new Date('2026-09-06T13:58:00.000Z');
  for (const preset of RANGE_PRESETS) {
    const range = rangeFor(preset, now);
    const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
    assert.ok(days > 0, `${preset.id} produced an empty range`);
    assert.ok(days <= MAX_RANGE_DAYS, `${preset.id} spans ${days} days`);
  }
});

test('clampRange caps an over-wide range and un-inverts a backwards one', () => {
  const to = new Date('2026-09-06T00:00:00.000Z');
  const from = new Date(to.getTime() - 60 * 86_400_000);

  const capped = clampRange(from, to);
  assert.equal((capped.to.getTime() - capped.from.getTime()) / 86_400_000, MAX_RANGE_DAYS);

  const flipped = clampRange(to, from);
  assert.ok(flipped.from <= flipped.to);
});

test('the step grows with the range and never drops below the collector interval', () => {
  const now = new Date('2026-09-06T00:00:00.000Z');
  const steps = RANGE_PRESETS.map((preset) => chooseStepSeconds(rangeFor(preset, now)));

  assert.ok(
    steps.every((step) => step >= 60),
    'a step under 60s asks for detail that was never sampled',
  );
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(steps[i]! >= steps[i - 1]!, 'a wider range must not use a finer step');
  }
  // 30 days at the coarsest listed step still has to stay chartable.
  const widest = rangeFor(RANGE_PRESETS[RANGE_PRESETS.length - 1]!, now);
  const points = (widest.to.getTime() - widest.from.getTime()) / 1000 / steps[steps.length - 1]!;
  assert.ok(points <= 900, `a 30-day chart would carry ${points} points`);
});

test('a missing bucket becomes null, not zero and not a straight line', () => {
  // Samples at minute 0, 1 and 5. Minutes 2, 3 and 4 were never collected -
  // exactly what the collector does when a network rate is null.
  const range = { from: new Date(0), to: new Date(5 * MINUTE) };
  const rows = buildGrid(
    [
      {
        name: 'network.rx',
        points: [
          { timestamp: at(0), value: 10 },
          { timestamp: at(1), value: 20 },
          { timestamp: at(5), value: 30 },
        ],
      },
    ],
    range,
    60,
  );

  assert.deepEqual(
    rows.map((row) => row.values['network.rx']),
    [10, 20, null, null, null, 30],
  );
  assert.ok(
    !rows.some((row) => row.values['network.rx'] === 0),
    'a hole must never be filled with a zero',
  );
});

test('buckets are floored against the epoch, the same way the server floors them', () => {
  // 06:07 with a 5-minute step belongs in the 06:05 bucket on both sides.
  const from = new Date('2026-09-06T06:00:00.000Z');
  const to = new Date('2026-09-06T06:20:00.000Z');
  const rows = buildGrid(
    [{ name: 'cpu.usage', points: [{ timestamp: '2026-09-06T06:07:30.000Z', value: 41.58 }] }],
    { from, to },
    300,
  );

  const filled = rows.filter((row) => row.values['cpu.usage'] !== null);
  assert.equal(filled.length, 1);
  assert.equal(new Date(filled[0]!.t).toISOString(), '2026-09-06T06:05:00.000Z');
});

test('only runs of empty buckets long enough to mean an outage become bands', () => {
  const rows = buildGrid(
    [
      {
        name: 'cpu.usage',
        points: [
          { timestamp: at(0), value: 1 },
          // one dropped minute - a break in the line, not a shaded column
          { timestamp: at(2), value: 1 },
          // minutes 3..7 missing: five buckets, a real outage
          { timestamp: at(8), value: 1 },
        ],
      },
    ],
    { from: new Date(0), to: new Date(8 * MINUTE) },
    60,
  );

  const bands = findBlankBands(rows);
  assert.equal(bands.length, 1);
  assert.equal(bands[0]!.from, 3 * MINUTE);
  assert.equal(bands[0]!.to, 7 * MINUTE);
});

test('series are charted by unit, and a series with no points is not charted at all', () => {
  const range = { from: new Date(0), to: new Date(2 * MINUTE) };
  const groups = groupByUnit(
    [
      {
        resource: 'host',
        name: 'cpu.usage',
        unit: 'percent',
        stepSeconds: 60,
        points: [{ timestamp: at(0), value: 41.58, count: 1 }],
      },
      {
        resource: 'host',
        name: 'memory.used',
        unit: 'MiB',
        stepSeconds: 60,
        points: [{ timestamp: at(0), value: 3214, count: 1 }],
      },
      {
        resource: 'host',
        name: 'disk.root.usedPercent',
        unit: 'percent',
        stepSeconds: 60,
        points: [{ timestamp: at(1), value: 12, count: 1 }],
      },
      {
        // What `/resources` reports for a sibling sub-resource: a real metric
        // name that this selection simply never emitted.
        resource: 'host',
        name: 'container.restarts',
        unit: null,
        stepSeconds: 60,
        points: [],
      },
    ],
    range,
    60,
  );

  assert.deepEqual(
    groups.map((group) => group.unit),
    ['percent', 'MiB'],
  );
  assert.deepEqual(
    groups[0]!.series.map((series) => series.name),
    ['cpu.usage', 'disk.root.usedPercent'],
  );
  // Two series in one chart must not share a colour or a stroke pattern.
  assert.notEqual(groups[0]!.series[0]!.color, groups[0]!.series[1]!.color);
  assert.notEqual(groups[0]!.series[0]!.dash, groups[0]!.series[1]!.dash);
  // cpu.usage has a sample in bucket 0 only, so two of three buckets are holes.
  assert.equal(groups[0]!.series[0]!.samples, 1);
  assert.equal(groups[0]!.series[0]!.missing, 2);
});
