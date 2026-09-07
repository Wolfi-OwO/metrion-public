import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCpuPercent, computeMemUsedMiB } from '../dist/collectors/docker-containers.js';
import { aggregateByHost, parseCaddyAccessLogLines } from '../dist/collectors/caddy-requests.js';
import { parseProcStatCpuLine, usagePercentBetween } from '../dist/lib/cpu-usage.js';
import { demuxDockerLogStream } from '../dist/lib/docker-socket.js';
import { parseMemInfo, toMemInfo } from '../dist/lib/mem-info.js';
import { computeNetRate, readInterfaceCounters } from '../dist/lib/net-rate.js';
import { findDefaultRouteInterface } from '../dist/lib/default-net-iface.js';

test('parseMemInfo + toMemInfo: used is MemTotal - MemAvailable, not MemTotal - MemFree', () => {
  // Real-shaped fixture: plenty of free page cache that is NOT "used" memory.
  const fixture = [
    'MemTotal:        8130584 kB',
    'MemFree:          512000 kB',
    'MemAvailable:    6000000 kB',
    'Cached:          3000000 kB',
    'SReclaimable:     200000 kB',
    '',
  ].join('\n');

  const fields = parseMemInfo(fixture);
  assert.equal(fields.MemTotal, 8130584);

  const info = toMemInfo(fields);
  // Naive (wrong) calc would give (8130584-512000)/1024 =~ 7440 MiB used.
  assert.ok(
    info.usedMiB < 3000,
    `expected honest "used" well under the naive MemTotal-MemFree figure, got ${info.usedMiB}`,
  );
  assert.equal(Math.round(info.usedMiB), Math.round((8130584 - 6000000) / 1024));
});

test('parseProcStatCpuLine + usagePercentBetween: idle-only delta is 0%, all-busy delta is 100%', () => {
  const idleLine = 'cpu  100 0 100 9800 0 0 0 0 0 0\n';
  const before = parseProcStatCpuLine(idleLine);
  const afterIdle = parseProcStatCpuLine('cpu  100 0 100 19800 0 0 0 0 0 0\n');
  assert.equal(usagePercentBetween(before, afterIdle), 0);

  const afterBusy = parseProcStatCpuLine('cpu  10100 0 100 9800 0 0 0 0 0 0\n');
  assert.equal(usagePercentBetween(before, afterBusy), 100);
});

test('readInterfaceCounters reads only the named interface, not docker0/br-*/veth* noise', () => {
  const fixture = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 999999999    1    0    0    0     0          0         0   999999999    1    0    0    0     0       0          0',
    '  eth0:  1000      10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0',
    'docker0: 555555      5    0    0    0     0          0         0   555555      5    0    0    0     0       0          0',
    'veth2c078c5: 777777   7    0    0    0     0          0         0   777777      7    0    0    0     0       0          0',
    '',
  ].join('\n');
  const counters = readInterfaceCounters(fixture, 'eth0');
  assert.equal(counters.rxBytes, 1000);
  assert.equal(counters.txBytes, 2000);
});

test('findDefaultRouteInterface picks the line whose Destination is all-zero, ignoring docker bridges', () => {
  const fixture = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t017356A7\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t007356A7\t017356A7\t0003\t0\t0\t0\t00FFFFFF\t0\t0\t0',
    'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    '',
  ].join('\n');
  assert.equal(findDefaultRouteInterface(fixture), 'eth0');
});

test('computeNetRate: null on first run and on a counter rollback, a real rate otherwise', () => {
  const current = { rxBytes: 2000, txBytes: 4000 };
  assert.deepEqual(computeNetRate(current, undefined, Date.now()), {
    rxBytesPerSec: null,
    txBytesPerSec: null,
  });

  const tenSecondsAgo = Date.now() - 10_000;
  const rate = computeNetRate(
    current,
    { rxBytes: 1000, txBytes: 3000, atMs: tenSecondsAgo },
    Date.now(),
  );
  assert.ok(
    rate.rxBytesPerSec !== null && Math.abs(rate.rxBytesPerSec - 100) < 5,
    `expected ~100 B/s, got ${rate.rxBytesPerSec}`,
  );

  // Rollback: counters went down since last sample (interface/host restart).
  const rollback = computeNetRate(
    { rxBytes: 10, txBytes: 10 },
    { rxBytes: 1000, txBytes: 3000, atMs: tenSecondsAgo },
    Date.now(),
  );
  assert.deepEqual(rollback, { rxBytesPerSec: null, txBytesPerSec: null });
});

test('computeCpuPercent / computeMemUsedMiB subtract cache before reporting "used"', () => {
  const stats = {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000 },
      system_cpu_usage: 8_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 4_000_000_000 },
    memory_stats: {
      usage: 200 * 1024 * 1024,
      limit: 1024 * 1024 * 1024,
      stats: { total_inactive_file: 150 * 1024 * 1024 },
    },
  };
  // cpuDelta=1e9, systemDelta=4e9 -> (1e9/4e9)*4*100 = 100%
  assert.equal(computeCpuPercent(stats), 100);
  // 200MiB usage - 150MiB cache = 50MiB actually used, not 200MiB.
  assert.equal(computeMemUsedMiB(stats), 50);
});

test('computeMemUsedMiB falls back to cgroup v2\'s "inactive_file" when "total_inactive_file" is absent', () => {
  // Real shape measured on a cgroup v2 host: memory_stats.stats has
  // neither total_inactive_file nor cache, only inactive_file.
  const stats = {
    cpu_stats: { cpu_usage: { total_usage: 0 }, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 0 } },
    memory_stats: {
      usage: 200 * 1024 * 1024,
      limit: 1024 * 1024 * 1024,
      stats: { inactive_file: 150 * 1024 * 1024 },
    },
  };
  assert.equal(computeMemUsedMiB(stats), 50);
});

test('parseCaddyAccessLogLines only picks up lines with status + request.host, ignores TLS/startup noise', () => {
  const text = [
    JSON.stringify({ level: 'info', logger: 'tls', msg: 'obtaining certificate' }),
    JSON.stringify({
      status: 200,
      duration: 0.012,
      request: {
        host: 'www.woofi-developments.at',
        remote_ip: '203.0.113.7',
        uri: '/secret?token=abc',
      },
    }),
    JSON.stringify({
      status: 404,
      duration: 0.003,
      request: { host: 'www.woofi-developments.at' },
    }),
    '', // trailing newline artifact
  ].join('\n');

  const lines = parseCaddyAccessLogLines(text);
  assert.equal(lines.length, 2);

  const byHost = aggregateByHost(lines);
  assert.equal(byHost['www.woofi-developments.at']?.count, 2);
  assert.deepEqual(byHost['www.woofi-developments.at']?.statusCounts, { '200': 1, '404': 1 });

  // The privacy contract: nothing about remote_ip/uri ever made it into the aggregate.
  assert.equal(JSON.stringify(byHost).includes('203.0.113.7'), false);
  assert.equal(JSON.stringify(byHost).includes('/secret'), false);
});

test('demuxDockerLogStream strips the 8-byte frame header from each chunk', () => {
  const payload = Buffer.from('hello\n');
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0); // stdout
  header.writeUInt32BE(payload.length, 4);
  const framed = Buffer.concat([header, payload]);
  assert.equal(demuxDockerLogStream(framed), 'hello\n');
});

test('aggregateByHost: a prototype-named Host header neither throws nor pollutes', () => {
  // `Host:` is attacker-controlled. On a plain object literal
  // `perHost["__proto__"]` resolved to Object.prototype, so the accumulator WAS
  // Object.prototype: it threw (blacking out the whole minute's request
  // metrics, repeatable on demand) and left `({}).count === NaN` for the rest
  // of the run. Asserting the absence of the pollution, not just that no error
  // escaped - a try/catch would hide exactly the bug this guards.
  const text = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']
    .map((host) => JSON.stringify({ status: 200, duration: 0.01, request: { host } }))
    .join('\n');

  const byHost = aggregateByHost(parseCaddyAccessLogLines(text));

  assert.equal(({} as Record<string, unknown>).count, undefined);
  assert.equal(({} as Record<string, unknown>).statusCounts, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'durationSecondsSum'), false);

  // They pass the charset check, so they are ordinary hosts and must still be
  // counted - the null-prototype map is what makes them safe, not a filter.
  assert.equal(byHost['__proto__']?.count, 1);
  assert.equal(byHost['constructor']?.count, 1);
  assert.deepEqual(byHost['__proto__']?.statusCounts, { '200': 1 });
});

test('aggregateByHost: hosts outside the ingest charset are dropped, trailing newline included', () => {
  // Same charset the HTTP ingest endpoint enforces, so one field cannot be
  // valid at one door and invalid at the other. The trailing newline is the
  // anchor trap: JS `$` (no `m` flag) does not match before a final \n, which
  // is what makes "evil\n" rejected here rather than silently accepted.
  const rejected = [
    'evil\n',
    'a\nb',
    'ho st',
    'ho/st',
    '../etc/passwd',
    'a'.repeat(201),
    '<script>',
  ];
  const accepted = ['woofi-developments.at', 'sub.domain.example.com', 'host:8443', 'a_b-c.d'];

  const text = [...rejected, ...accepted]
    .map((host) => JSON.stringify({ status: 200, duration: 0.01, request: { host } }))
    .join('\n');

  const byHost = aggregateByHost(parseCaddyAccessLogLines(text));

  for (const host of rejected) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(byHost, host),
      false,
      `should drop ${JSON.stringify(host)}`,
    );
  }
  for (const host of accepted) {
    assert.equal(byHost[host]?.count, 1, `should keep ${host}`);
  }
});

test('aggregateByHost: distinct hosts are capped per minute', () => {
  // Every host becomes its own `requests:<host>` envelope on one blob line, so
  // an attacker spraying unique Host headers would otherwise inflate the
  // day-blob and every later read of it.
  const lines = Array.from({ length: 250 }, (_, index) => ({
    status: 200,
    duration: 0.01,
    request: { host: `host-${index}.example.com` },
  }));

  const byHost = aggregateByHost(lines);
  assert.equal(Object.keys(byHost).length, 200);

  // The cap drops only NEW hosts: one already being counted keeps counting, so
  // a flood cannot stop a real vhost's numbers mid-minute.
  const withRepeats = aggregateByHost([
    ...lines,
    { status: 200, duration: 0.01, request: { host: 'host-0.example.com' } },
  ]);
  assert.equal(withRepeats['host-0.example.com']?.count, 2);
});

test('aggregateByHost: real hosts still aggregate exactly as before the hardening', () => {
  // The regression guard for the fix itself: counts, per-status breakdown and
  // the seconds-to-milliseconds latency conversion must be untouched.
  const text = [
    { status: 200, duration: 0.1, request: { host: 'www.woofi-developments.at' } },
    { status: 200, duration: 0.3, request: { host: 'www.woofi-developments.at' } },
    { status: 500, duration: 0.2, request: { host: 'www.woofi-developments.at' } },
    { status: 200, duration: 0.05, request: { host: 'status.woofi-developments.at' } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');

  const byHost = aggregateByHost(parseCaddyAccessLogLines(text));

  assert.equal(byHost['www.woofi-developments.at']?.count, 3);
  assert.deepEqual(byHost['www.woofi-developments.at']?.statusCounts, { '200': 2, '500': 1 });
  // Tolerance, not equality: (0.1+0.3+0.2)/3*1000 is 200.00000000000003 in
  // binary floating point. Pre-existing behaviour, unchanged by the hardening.
  assert.ok(Math.abs((byHost['www.woofi-developments.at']?.avgLatencyMs ?? 0) - 200) < 1e-9);
  assert.equal(byHost['status.woofi-developments.at']?.count, 1);
  assert.equal(byHost['status.woofi-developments.at']?.avgLatencyMs, 50);
});
