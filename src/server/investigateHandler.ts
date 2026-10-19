import type { IncomingMessage, ServerResponse } from 'node:http';
import { executeRoomInvestigation } from './investigationProvider.ts';
import type { InvestigateApiRequest } from '../domain/investigation/types.ts';

export async function handleInvestigateApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  // Method validation
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Method not allowed. Use POST.' }));
    return;
  }

  // Content-Type validation
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    res.statusCode = 415;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        error: 'Unsupported Media Type. Expected Content-Type: application/json.',
      })
    );
    return;
  }

  const maxBodyBytes = 150 * 1024; // 150 KB limit
  let requestData: InvestigateApiRequest;

  try {
    // Check if body was pre-parsed (e.g. in Vercel Serverless Function runtime)
    const anyReq = req as unknown as { body?: unknown };
    if (anyReq.body !== undefined && anyReq.body !== null) {
      if (typeof anyReq.body === 'object') {
        const serialized = JSON.stringify(anyReq.body);
        if (serialized.length > maxBodyBytes) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          return;
        }
        requestData = anyReq.body as InvestigateApiRequest;
      } else if (typeof anyReq.body === 'string') {
        if (anyReq.body.length > maxBodyBytes) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          return;
        }
        requestData = JSON.parse(anyReq.body);
      } else {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: 'Malformed JSON payload' }));
        return;
      }
    } else {
      // Read from raw stream (e.g. Vite dev/preview middleware or plain Node http)
      let bodyText = '';
      for await (const chunk of req) {
        bodyText += chunk;
        if (bodyText.length > maxBodyBytes) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          return;
        }
      }

      requestData = JSON.parse(bodyText || '{}');
    }

    if (!requestData.roomId || !requestData.repoContext) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          success: false,
          error: 'Missing required investigation parameters (roomId, repoContext).',
        })
      );
      return;
    }

    const result = await executeRoomInvestigation(requestData, env, fetchFn);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'Malformed JSON payload' }));
      return;
    }

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
  }
}
