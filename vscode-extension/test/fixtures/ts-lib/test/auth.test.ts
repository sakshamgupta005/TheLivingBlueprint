import { test } from 'node:test';
import assert from 'node:assert';
import { authenticateToken } from '../src/auth.ts';

test('authenticateToken validates non-empty tokens', () => {
  assert.strictEqual(authenticateToken('valid_token'), true);
  assert.strictEqual(authenticateToken(''), false);
});
