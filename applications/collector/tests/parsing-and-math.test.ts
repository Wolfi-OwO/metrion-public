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
