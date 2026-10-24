const { test } = require('node:test');
const assert = require('node:assert');
const app = require('../src/server.js');

test('tasks server initializes properly', () => {
  assert.ok(app);
});
