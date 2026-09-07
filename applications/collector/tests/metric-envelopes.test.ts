import assert from 'node:assert/strict';
import test from 'node:test';
import { toMetricEnvelopes } from '../dist/lib/to-metric-envelopes.js';

const AT = '2026-09-06T12:34:00.000Z';

/**
 * Deliberately loaded with the things that must NOT come out the other side:
 * a client IP, a user agent and a request path, all in places a careless
 * mapper might pick up (a container name, a request hostname).
 */
function fixture(overrides = {}) {
  return {
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
    ...overrides,
  };
}

test('toMetricEnvelopes: a null network rate emits no point at all, never a 0', () => {
  const withRate = toMetricEnvelopes(fixture());
  const rateNames = (envelopes) =>
    envelopes
      .flatMap((envelope) => envelope.metrics)
      .map((point) => point.name)
      .filter((name) => name.startsWith('network.'));

  assert.deepEqual(rateNames(withRate).sort(), ['network.rx', 'network.tx']);

  // First run after a reboot: nothing to subtract from. A 0 here would draw a
  // real-looking trough on the chart for a minute nobody measured.
  const noRate = toMetricEnvelopes(
    fixture({ network: { rxBytesPerSec: null, txBytesPerSec: null } }),
  );
  assert.deepEqual(rateNames(noRate), []);

  // A one-sided rate keeps the side that is real.
  const rxOnly = toMetricEnvelopes(fixture({ network: { rxBytesPerSec: 0, txBytesPerSec: null } }));
  assert.deepEqual(rateNames(rxOnly), ['network.rx']);
  // ...and 0 is still emitted when it is a MEASURED zero, not a missing one.
  const rx = rxOnly.flatMap((e) => e.metrics).find((p) => p.name === 'network.rx');
  assert.equal(rx.value, 0);
});

test('toMetricEnvelopes: every point carries the full MetricPoint shape', () => {
  const envelopes = toMetricEnvelopes(fixture());
  const points = envelopes.flatMap((envelope) => envelope.metrics);
  assert.ok(points.length > 0);

  for (const point of points) {
    assert.equal(typeof point.name, 'string');
    assert.equal(typeof point.value, 'number');
    assert.ok(Number.isFinite(point.value), `${point.name} must be a finite number`);
    assert.equal(typeof point.unit, 'string');
    assert.equal(point.intervalSeconds, 60);
    assert.equal(point.timestamp, AT);
  }
});

test('toMetricEnvelopes: resource/subResource keys are the host, container and hostname only', () => {
  const envelopes = toMetricEnvelopes(fixture());
  assert.deepEqual(
    envelopes.map((envelope) => envelope.subResource),
    [undefined, 'container:portfolio-caddy-1', 'requests:woofi-developments.at', 'collector'],
  );
  for (const envelope of envelopes) {
    assert.equal(envelope.resource, 'vps-contabo-01');
  }
});

test('toMetricEnvelopes: no IP-shaped or path-shaped string reaches an envelope', () => {
  // The privacy exclusions are the reason `requestsByHost` is an aggregate
  // keyed by hostname; assert the mapper cannot reintroduce what the
  // collectors deliberately never captured.
  const leaky = fixture({
    requestsByHost: {
      'woofi-developments.at': {
        count: 3,
        statusCounts: { '200': 3 },
        avgLatencyMs: 5,
      },
    },
    containers: [
      {
        name: 'portfolio-caddy-1',
        image: 'caddy:2-alpine',
        status: 'running',
        cpuPercent: 1,
        memUsedMiB: 10,
        memLimitMiB: 128,
        restartCount: 0,
        oomKilled: true,
      },
    ],
  });

  const serialized = JSON.stringify(toMetricEnvelopes(leaky));

  // An IPv4 literal anywhere - the `image: caddy:2-alpine` tag is the closest
  // thing to a dotted number in the fixture and must not be carried through.
  assert.equal(/\b\d{1,3}(\.\d{1,3}){3}\b/.test(serialized), false, serialized);
  // A request path or query string.
  assert.equal(/["/]\/[a-z]/i.test(serialized), false, serialized);
  assert.equal(serialized.includes('?'), false, serialized);
  // A user agent (nothing Mozilla-shaped), and no raw image/status strings.
  assert.equal(/Mozilla|Chrome|curl\//.test(serialized), false, serialized);
  assert.equal(serialized.includes('caddy:2-alpine'), false, serialized);
  assert.equal(serialized.includes('"running"'), false, serialized);
});
