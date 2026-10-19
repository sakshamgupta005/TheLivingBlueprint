import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleHealthApiRequest } from '../src/server/healthHandler.ts';

/**
 * Health check runs instantaneously and requires minimal execution duration.
 */
export const maxDuration = 10;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleHealthApiRequest(req, res);
}
