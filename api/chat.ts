import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleChatApiRequest } from '../src/server/chatHandler.ts';

/**
 * Vercel Serverless Function configuration.
 * Configures maximum duration to 30 seconds (supported on Hobby & Pro plans).
 * Upstream AI provider client timeout is bounded to 12s, leaving 18s headroom.
 */
export const maxDuration = 30;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleChatApiRequest(req, res);
}
