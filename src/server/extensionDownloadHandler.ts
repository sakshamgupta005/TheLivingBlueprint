import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export async function handleExtensionDownloadRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Method not allowed. Use GET.' }));
    return;
  }

  // Candidate paths where VSIX may reside
  const candidatePaths = [
    path.resolve(process.cwd(), 'public', 'living-blueprint-vscode-0.1.0.vsix'),
    path.resolve(process.cwd(), 'vscode-extension', 'living-blueprint-vscode-0.1.0.vsix'),
    path.resolve(process.cwd(), 'dist', 'living-blueprint-vscode-0.1.0.vsix'),
  ];

  let resolvedPath: string | null = null;
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      resolvedPath = candidate;
      break;
    }
  }

  if (!resolvedPath) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        error: 'VS Code extension package (.vsix) not found on server.',
      })
    );
    return;
  }

  const stat = fs.statSync(resolvedPath);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="living-blueprint-vscode-0.1.0.vsix"'
  );
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'public, max-age=3600');

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(resolvedPath);
  stream.pipe(res);
}
