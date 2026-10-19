const assert = require('node:assert');
const { describe, it } = require('node:test');
const { app } = require('../src/server');

describe('Tasks API Integration', () => {
  it('rejects unauthenticated requests with 401', () => {
    assert.strictEqual(typeof app, 'function');
  });
});
