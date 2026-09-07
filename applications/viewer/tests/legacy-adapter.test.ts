import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLine, parseLines } from '../dist/lib/legacy-adapter.js';

const AT = '2026-09-05T12:34:00.000Z';

/** A real-shaped pre-cutover blob line: exactly what the collector wrote before ADR 0003. */
const legacySample = {
  timestamp: AT,
  host: 'vps-contabo-01',
  cpu: { usagePercent: 12.5, loadAvg1: 0.4, loadAvg5: 0.3, loadAvg15: 0.2, vcpus: 4 },
  memory: { totalMiB: 7940, usedMiB: 2080, availableMiB: 5860, cachedMiB: 3120 },
  disk: {
    root: { totalMiB: 194560, usedMiB: 41000, usedPercent: 21.1 },
    docker: { imagesMiB: 2100, containersMiB: 40, volumesMiB: 610, buildCacheMiB: 15 },
  },
  network: { rxBytesPerSec: 1200, txBytesPerSec: 3400 },
  containers: [
    {
      name: 'portfolio-caddy-1',
      image: 'caddy:2-alpine',
      status: 'running',
      cpuPercent: 0.8,
      memUsedMiB: 41,
      memLimitMiB: 128,
      restartCount: 2,
      oomKilled: false,
    },
  ],
  requestsByHost: {
    'woofi-developments.at': {
      count: 41,
      statusCounts: { '200': 39, '404': 2 },
      avgLatencyMs: 12.25,
    },
  },
  collector: { durationMs: 210.5, cpuTimeMs: 31.2, maxRssMiB: 48.5, queuedSamples: 0 },
};

/** name -> unit, for the metrics both shapes must agree on. */
function unitsByName(envelopes, prefix) {
  const units = {};
  for (const envelope of envelopes) {
    for (const point of envelope.metrics) {
      if (point.name.startsWith(prefix)) units[point.name] = point.unit;
    }
  }
  return units;
}

test('parseLine: a legacy line and an envelope line agree on CPU and memory names and units', () => {
  const fromLegacy = parseLine(JSON.stringify(legacySample));
  assert.ok(fromLegacy.length > 0, 'legacy line must yield envelopes');

  // A post-cutover line is a JSON *array* of envelopes (ADR 0003). Round-trip
  // the converted legacy sample through that shape: this is precisely the pair
  // of lines a cutover-day blob holds, and a chart spanning them is only
  // continuous if the names and units match exactly.
  const fromEnvelopes = parseLine(JSON.stringify(fromLegacy));

  assert.deepEqual(unitsByName(fromEnvelopes, 'cpu.'), unitsByName(fromLegacy, 'cpu.'));
  assert.deepEqual(unitsByName(fromEnvelopes, 'memory.'), unitsByName(fromLegacy, 'memory.'));

  // Pinned literally, because the two mappings live in two files that cannot
  // import each other (@mona/shared must stay type-only). If the collector
  // renames one of these, this is what catches it.
  assert.deepEqual(unitsByName(fromLegacy, 'cpu.'), {
    'cpu.usage': 'percent',
    'cpu.load1': 'count',
    'cpu.load5': 'count',
    'cpu.load15': 'count',
    'cpu.vcpus': 'count',
  });
  assert.deepEqual(unitsByName(fromLegacy, 'memory.'), {
    'memory.total': 'MiB',
    'memory.used': 'MiB',
    'memory.available': 'MiB',
    'memory.cached': 'MiB',
  });
});

test('parseLine: sub-resource keys and every point shape carry over from the legacy sample', () => {
  const envelopes = parseLine(JSON.stringify(legacySample));

  assert.deepEqual(
    envelopes.map((envelope) => envelope.subResource),
    [undefined, 'container:portfolio-caddy-1', 'requests:woofi-developments.at', 'collector'],
  );

  for (const envelope of envelopes) {
    assert.equal(envelope.resource, 'vps-contabo-01');
    for (const point of envelope.metrics) {
      assert.equal(typeof point.name, 'string');
      assert.ok(Number.isFinite(point.value));
      assert.equal(typeof point.unit, 'string');
      assert.equal(point.intervalSeconds, 60);
      assert.equal(point.timestamp, AT);
    }
  }
});

test('parseLine: a null network rate synthesises no point, matching the collector', () => {
  const noRate = { ...legacySample, network: { rxBytesPerSec: null, txBytesPerSec: null } };
  const names = parseLine(JSON.stringify(noRate))
    .flatMap((envelope) => envelope.metrics)
    .map((point) => point.name)
    .filter((name) => name.startsWith('network.'));

  assert.deepEqual(names, []);
});

test('parseLines: malformed lines are counted and dropped, never fatal to the rest', () => {
  const lines = [
    JSON.stringify(legacySample),
    'not json at all',
    '',
    '{"unrecognised":"object"}',
    '[{"resource":"x"}]', // an array whose element has no metrics array
    JSON.stringify(parseLine(JSON.stringify(legacySample))),
  ];

  const { envelopes, skipped } = parseLines(lines);

  // The blank line is skipped silently (not corrupt); the other three count.
  assert.equal(skipped, 3);
  assert.ok(envelopes.length > 0, 'the two good lines must survive the three bad ones');
});

test('parseLine: no IP-shaped or path-shaped string reaches an envelope', () => {
  const serialized = JSON.stringify(parseLine(JSON.stringify(legacySample)));

  assert.equal(/\b\d{1,3}(\.\d{1,3}){3}\b/.test(serialized), false, serialized);
  assert.equal(/["/]\/[a-z]/i.test(serialized), false, serialized);
  assert.equal(serialized.includes('?'), false, serialized);
  assert.equal(/Mozilla|Chrome|curl\//.test(serialized), false, serialized);
  // The legacy sample carried `image` and `status`; the envelope shape has no
  // field for a string, so neither may be smuggled through as a metric name.
  assert.equal(serialized.includes('caddy:2-alpine'), false, serialized);
  assert.equal(serialized.includes('"running"'), false, serialized);
});
