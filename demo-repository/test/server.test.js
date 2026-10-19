import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../src/server.js';
import { clearTasks } from '../src/tasks/store.js';

describe('HTTP Server & API Endpoints', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer();
    await new Promise((resolve) => {
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    clearTasks();
  });

  it('GET /health returns 200 OK with service status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(data.service, 'Patchboard Tasks API');
    assert.ok(data.timestamp);
  });

  it('GET /api/tasks returns initial empty collection', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, { tasks: [] });
  });

  it('POST /api/tasks creates task and returns 201 Created', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Configure CI pipeline' }),
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.task.title, 'Configure CI pipeline');
    assert.strictEqual(data.task.completed, false);
    assert.ok(data.task.id);

    // Verify task is now present in collection
    const listRes = await fetch(`${baseUrl}/api/tasks`);
    const listData = await listRes.json();
    assert.strictEqual(listData.tasks.length, 1);
    assert.strictEqual(listData.tasks[0].title, 'Configure CI pipeline');
  });

  it('POST /api/tasks returns 400 when title is missing or not a string', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /Task title/i);
  });

  it('GET /api/unknown returns 404 Not Found', async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.match(data.error, /not found/i);
  });
});
