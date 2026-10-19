import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleExtensionDownloadRequest } from '../src/server/extensionDownloadHandler.ts';

export const maxDuration = 15;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleExtensionDownloadRequest(req, res);
}
