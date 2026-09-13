import assert from 'node:assert/strict';
import test from 'node:test';
import { projectNameError } from '../src/lib/validate.ts';

test('an empty or whitespace-only name is rejected', () => {
  assert.ok(projectNameError('') !== null);
  assert.ok(projectNameError('   ') !== null);
});

test('a name over 200 characters is rejected', () => {
  assert.ok(projectNameError('a'.repeat(200)) === null);
  assert.ok(projectNameError('a'.repeat(201)) !== null);
});

test('an ordinary name passes', () => {
  assert.equal(projectNameError('vps-contabo-01'), null);
});
