import http from 'node:http';
import { getAllTasks } from './tasks/store.js';
import { createTask, TaskValidationError } from './tasks/createTask.js';

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    const { method } = req;

    // 1. Health check
    if (pathname === '/health' && method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'Patchboard Tasks API',
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Task Collection: GET
    if (pathname === '/api/tasks' && method === 'GET') {
      return sendJson(res, 200, {
        tasks: getAllTasks(),
      });
    }

    // 3. Task Collection: POST
    if (pathname === '/api/tasks' && method === 'POST') {
      let bodyText = '';
      for await (const chunk of req) {
        bodyText += chunk;
      }

      let payload;
      try {
        payload = JSON.parse(bodyText || '{}');
      } catch {
        return sendJson(res, 400, { error: 'Malformed JSON payload' });
      }

      try {
        const created = createTask(payload.title);
        return sendJson(res, 201, { task: created });
      } catch (err) {
        if (err instanceof TaskValidationError) {
          return sendJson(res, 400, { error: err.message });
        }
        return sendJson(res, 500, { error: 'Internal server error' });
      }
    }

    // 4. Fallback 404
    sendJson(res, 404, {
      error: `Route ${method} ${pathname} not found.`,
    });
  });
}

// Auto-start when executed directly
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = process.env.PORT || 3001;
  const server = createServer();
  server.listen(port, () => {
    console.log(`Patchboard Tasks API listening on port ${port}`);
  });
}
