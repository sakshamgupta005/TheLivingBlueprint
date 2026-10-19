import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App } from '../src/App';

describe('Web App Component', () => {
  it('exports component', () => {
    assert.strictEqual(typeof App, 'function');
  });
});
