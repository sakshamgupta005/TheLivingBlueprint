import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export function findExtensionVsix(
  requestedPath?: string,
  baseDir: string = process.cwd()
): string | null {
  const candidateDirs = [
    path.resolve(baseDir, 'vscode-extension'),
    path.resolve(baseDir, 'public'),
    path.resolve(baseDir, 'dist'),
  ];

  // If a specific .vsix filename is requested in URL, check candidates for that exact filename
  if (requestedPath) {
    const cleanName = path.basename(requestedPath.split('?')[0]);
    if (cleanName.endsWith('.vsix')) {
      for (const dir of candidateDirs) {
        const candidate = path.join(dir, cleanName);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  // Otherwise, discover all living-blueprint-vscode-*.vsix files
  const candidates: Array<{ path: string; name: string; semverWeight: number; mtime: number }> = [];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.vsix')) continue;
        if (!file.startsWith('living-blueprint-vscode')) continue;
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;

        const semverMatch = file.match(/(\d+)\.(\d+)\.(\d+)/);
        let semverWeight = 0;
        if (semverMatch) {
          semverWeight =
            parseInt(semverMatch[1], 10) * 1000000 +
            parseInt(semverMatch[2], 10) * 1000 +
            parseInt(semverMatch[3], 10);
        } else if (file.includes('latest')) {
          // If no version number, give latest a baseline weight of 1
          semverWeight = 1;
        }

        candidates.push({
          path: full,
          name: file,
          semverWeight,
          mtime: stat.mtimeMs,
        });
      }
    } catch {
      // Ignore read errors and continue
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Prefer highest semver, then newest mtime
  candidates.sort((a, b) => b.semverWeight - a.semverWeight || b.mtime - a.mtime);
  return candidates[0].path;
}

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

  const resolvedPath = findExtensionVsix(req.url);

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
  const filename = path.basename(resolvedPath);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'public, max-age=3600');

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(resolvedPath);
  stream.pipe(res);
}
