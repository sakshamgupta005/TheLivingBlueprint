import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleInvestigateApiRequest } from '../src/server/investigateHandler.ts';

/**
 * Vercel Serverless Function configuration.
 * Configures maximum duration to 30 seconds (supported on Hobby & Pro plans).
 * Upstream AI provider client timeout is bounded to 14s, leaving 16s headroom.
 */
export const maxDuration = 30;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleInvestigateApiRequest(req, res);
}
