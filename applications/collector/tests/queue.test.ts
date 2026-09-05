import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SampleQueue } from '../dist/lib/queue.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vps-metrics-queue-test-'));
}

test('SampleQueue: push then readAll preserves order', () => {
  const dir = tempDir();
  const queue = new SampleQueue(dir, 10);
  queue.push('a');
  queue.push('b');
  queue.push('c');
  assert.deepEqual(queue.readAll(), ['a', 'b', 'c']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SampleQueue: evicts the OLDEST lines first once over maxLines - bounded, not unbounded growth', () => {
  const dir = tempDir();
  const queue = new SampleQueue(dir, 3);
  for (const line of ['1', '2', '3', '4', '5']) {
    queue.push(line);
  }
  assert.deepEqual(queue.readAll(), ['3', '4', '5']);
  assert.equal(queue.size, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SampleQueue: replaceAll with an empty array removes the queue file entirely', () => {
  const dir = tempDir();
  const queue = new SampleQueue(dir, 10);
  queue.push('a');
  queue.replaceAll([]);
  assert.equal(queue.size, 0);
  assert.equal(fs.existsSync(path.join(dir, 'queue.jsonl')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
