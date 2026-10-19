import { describe, it } from 'node:test';
import assert from 'node:assert';
import { handleChatApiRequest } from '../src/server/chatHandler.ts';
import { handleInvestigateApiRequest } from '../src/server/investigateHandler.ts';
import { handleHealthApiRequest } from '../src/server/healthHandler.ts';
import chatApiHandler from '../api/chat.ts';
import investigateApiHandler from '../api/investigate.ts';
import healthApiHandler from '../api/health.ts';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  end: (chunk?: string) => void;
}

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      if (chunk) {
        this.body += chunk;
      }
    },
  };
}

function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | object;
}): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage & {
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
  };

  emitter.method = options.method || 'POST';
  emitter.headers = options.headers || { 'content-type': 'application/json' };

  if (options.body !== undefined) {
    if (typeof options.body === 'object') {
      (emitter as any).body = options.body;
    } else {
      (emitter as any).body = options.body;
    }
  }

  // Also support stream async iterator
  emitter[Symbol.asyncIterator] = async function* () {
    if (typeof options.body === 'string') {
      yield Buffer.from(options.body);
    } else if (options.body && typeof options.body === 'object') {
      yield Buffer.from(JSON.stringify(options.body));
    }
  };

  return emitter as unknown as IncomingMessage;
}

describe('Production API Routes & Serverless Adapters', () => {
  describe('HTTP Method and Content-Type Validation', () => {
    it('rejects GET requests on /api/chat with 405 Method Not Allowed', async () => {
      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await handleChatApiRequest(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 405);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.match(data.error, /Method not allowed/i);
    });

    it('rejects GET requests on /api/investigate with 405 Method Not Allowed', async () => {
      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await handleInvestigateApiRequest(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 405);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.match(data.error, /Method not allowed/i);
    });

    it('rejects POST requests on /api/health with 405 Method Not Allowed', async () => {
      const req = createMockRequest({ method: 'POST' });
      const res = createMockResponse();

      await handleHealthApiRequest(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 405);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.match(data.error, /Method not allowed/i);
    });

    it('rejects non-JSON Content-Type on /api/chat with 415 Unsupported Media Type', async () => {
      const req = createMockRequest({
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      });
      const res = createMockResponse();

      await handleChatApiRequest(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 415);
      const data = JSON.parse(res.body);
      assert.match(data.error, /Unsupported Media Type/i);
    });
  });

  describe('Payload Size Limits and Malformed JSON', () => {
    it('rejects oversized payloads on /api/chat with 413 Payload Too Large (>100KB)', async () => {
      const hugeString = 'x'.repeat(105 * 1024);
      const req = createMockRequest({
        method: 'POST',
        body: JSON.stringify({ message: hugeString }),
      });
      const res = createMockResponse();

      await handleChatApiRequest(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 413);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.match(data.error, /Payload Too Large/i);
    });

    it('rejects malformed JSON on /api/chat with 400 Bad Request', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: '{"invalid json here: true,',
      });
      const res = createMockResponse();

      await handleChatApiRequest(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.match(data.error, /Malformed JSON/i);
    });

    it('rejects missing required parameters on /api/investigate with 400 Bad Request', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: JSON.stringify({ message: 'only message, missing roomId and repoContext' }),
      });
      const res = createMockResponse();

      await handleInvestigateApiRequest(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.match(data.error, /Missing required investigation parameters/i);
    });
  });

  describe('Configuration & Security Guardrails', () => {
    it('returns CONFIG_REQUIRED safely on /api/chat when GEMINI_API_KEY is not configured', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: JSON.stringify({ message: 'Hello companions' }),
      });
      const res = createMockResponse();

      await handleChatApiRequest(req, res as unknown as ServerResponse, {});
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.code, 'CONFIG_REQUIRED');
      assert.match(data.error, /GEMINI_API_KEY/i);
    });

    it('returns CONFIG_REQUIRED safely on /api/investigate when GEMINI_API_KEY is missing', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: JSON.stringify({
          roomId: 'room-auth',
          repoContext: {
            owner: 'test',
            repo: 'test-repo',
            inspectedFiles: [],
            discoveredFilePaths: [],
            detectedTechnologies: [],
          },
        }),
      });
      const res = createMockResponse();

      await handleInvestigateApiRequest(req, res as unknown as ServerResponse, {});
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.code, 'CONFIG_REQUIRED');
    });

    it('health endpoint reports service status and configuration state without leaking credentials', async () => {
      // Test without API key
      const reqUnconfigured = createMockRequest({ method: 'GET' });
      const resUnconfigured = createMockResponse();
      await handleHealthApiRequest(reqUnconfigured, resUnconfigured as unknown as ServerResponse, {});
      assert.strictEqual(resUnconfigured.statusCode, 200);
      const dataUnconfigured = JSON.parse(resUnconfigured.body);
      assert.strictEqual(dataUnconfigured.status, 'ok');
      assert.strictEqual(dataUnconfigured.aiConfigured, false);
      assert.strictEqual(dataUnconfigured.model, 'gemini-3.8-flash');
      assert.strictEqual(dataUnconfigured.apiKey, undefined);

      // Test with API key present
      const reqConfigured = createMockRequest({ method: 'GET' });
      const resConfigured = createMockResponse();
      await handleHealthApiRequest(
        reqConfigured,
        resConfigured as unknown as ServerResponse,
        { GEMINI_API_KEY: 'test-secret-key-12345', AI_MODEL: 'gemini-3.8-flash' }
      );
      const dataConfigured = JSON.parse(resConfigured.body);
      assert.strictEqual(dataConfigured.status, 'ok');
      assert.strictEqual(dataConfigured.aiConfigured, true);
      assert.strictEqual(dataConfigured.model, 'gemini-3.8-flash');
      // Assert secret key is NEVER exposed in the JSON response
      assert.strictEqual(dataConfigured.apiKey, undefined);
      assert.strictEqual(resConfigured.body.includes('test-secret-key-12345'), false);
    });

    it('never leaks upstream secret URLs or keys during provider errors', async () => {
      const secretKey = 'super-secret-key-9999';
      const req = createMockRequest({
        method: 'POST',
        body: JSON.stringify({ message: 'Hello' }),
      });
      const res = createMockResponse();

      const mockFailingFetch: typeof fetch = async () => {
        throw new Error(`Upstream connection failed: https://generativelanguage.googleapis.com/?key=${secretKey}`);
      };

      await handleChatApiRequest(
        req,
        res as unknown as ServerResponse,
        { GEMINI_API_KEY: secretKey },
        mockFailingFetch
      );

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);
      assert.strictEqual(res.body.includes(secretKey), false);
    });
  });

  describe('Serverless Function Entrypoints Parity & Configuration', () => {
    it('confirms api/chat.ts serverless function delegates to handleChatApiRequest and configures maxDuration', async () => {
      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await chatApiHandler(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 405);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);

      const chatModule = await import('../api/chat.ts');
      assert.strictEqual(chatModule.maxDuration, 30);
    });

    it('confirms api/investigate.ts serverless function delegates to handleInvestigateApiRequest and configures maxDuration', async () => {
      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await investigateApiHandler(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 405);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.success, false);

      const investigateModule = await import('../api/investigate.ts');
      assert.strictEqual(investigateModule.maxDuration, 30);
    });

    it('confirms api/health.ts serverless function delegates to handleHealthApiRequest and configures maxDuration', async () => {
      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await healthApiHandler(req, res as unknown as ServerResponse);
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.status, 'ok');

      const healthModule = await import('../api/health.ts');
      assert.strictEqual(healthModule.maxDuration, 10);
    });

    it('validates vercel.json rewrite regex prevents API routes from redirecting to index.html', async () => {
      const { readFileSync } = await import('node:fs');
      const vercelConfig = JSON.parse(readFileSync('vercel.json', 'utf8'));

      assert.strictEqual(vercelConfig.functions['api/*.ts'].maxDuration, 30);

      const spaRewrite = vercelConfig.rewrites.find((r: any) => r.destination === '/index.html');
      assert.ok(spaRewrite, 'Must have SPA rewrite to /index.html');

      // Test negative lookahead regex
      const regex = new RegExp(`^${spaRewrite.source.replace('(.*)', '.*')}$`);
      assert.strictEqual(regex.test('/api/chat'), false, '/api/chat must NOT rewrite to index.html');
      assert.strictEqual(regex.test('/api/investigate'), false, '/api/investigate must NOT rewrite to index.html');
      assert.strictEqual(regex.test('/api/health'), false, '/api/health must NOT rewrite to index.html');
      assert.strictEqual(regex.test('/overview'), true, '/overview must rewrite to index.html');
      assert.strictEqual(regex.test('/room/1'), true, '/room/1 must rewrite to index.html');
    });
  });
});
