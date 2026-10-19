import { describe, it } from 'node:test';
import assert from 'node:assert';
import { app } from '../src/server';

describe('Users API route', () => {
  it('initializes express app', () => {
    assert.strictEqual(typeof app, 'function');
  });
});
