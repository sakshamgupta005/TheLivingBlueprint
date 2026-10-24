const { test } = require('node:test');
const assert = require('node:assert');
const { formatNote } = require('../src/notes.js');

test('formatNote trims', () => {
  assert.strictEqual(formatNote('  hi  '), 'hi');
});
