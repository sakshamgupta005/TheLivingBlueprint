import type { FileCategory, GitTreeEntry, SkippedFile } from './types.ts';

const IGNORED_DIRECTORY_PREFIXES = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  '.nuxt/',
  'vendor/',
  'target/',
  'bin/',
  'obj/',
  'coverage/',
  '.vscode/',
  '.idea/',
  'venv/',
  '.venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.turbo/',
  'out/',
];

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'poetry.lock',
  'composer.lock',
  'gemfile.lock',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'webp', 'bmp', 'pdf',
  'zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'wasm', 'mp4', 'mov', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'exe', 'dll', 'dylib', 'so',
  'min.js', 'min.css', 'map', 'pyc', 'class', 'jar', 'o', 'a',
  'bin', 'dat',
]);

const MANIFEST_NAMES = new Set([
  'package.json',
  'cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'pipfile',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'gemfile',
  'composer.json',
]);

export function categorizeFile(path: string): FileCategory {
  const lower = path.toLowerCase();
  const basename = lower.split('/').pop() || '';

  if (MANIFEST_NAMES.has(basename)) {
    return 'manifest';
  }
  if (basename.startsWith('readme')) {
    return 'readme';
  }
  if (
    basename.includes('test') ||
    basename.includes('spec') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/')
  ) {
    return 'test';
  }
  if (
    basename.startsWith('dockerfile') ||
    basename.includes('docker-compose') ||
    lower.includes('.github/workflows/') ||
    basename.endsWith('.config.js') ||
    basename.endsWith('.config.ts') ||
    basename === 'tsconfig.json'
  ) {
    return 'config';
  }
  if (lower.endsWith('.md') || lower.includes('/docs/')) {
    return 'documentation';
  }
  return 'source';
}

export function isFileIgnored(path: string): { ignored: boolean; reason?: SkippedFile['reason'] } {
  const lower = path.toLowerCase();
  const basename = lower.split('/').pop() || '';

  for (const prefix of IGNORED_DIRECTORY_PREFIXES) {
    if (lower.startsWith(prefix) || lower.includes(`/${prefix}`)) {
      return { ignored: true, reason: 'ignored_directory' };
    }
  }

  if (LOCKFILE_NAMES.has(basename)) {
    return { ignored: true, reason: 'lockfile' };
  }

  const parts = basename.split('.');
  if (parts.length > 1) {
    const ext = parts.pop()!;
    if (BINARY_EXTENSIONS.has(ext)) {
      return { ignored: true, reason: 'binary_asset' };
    }
    // Also check double-extension like .min.js
    const subExt = `${parts.pop()}.${ext}`;
    if (BINARY_EXTENSIONS.has(subExt)) {
      return { ignored: true, reason: 'binary_asset' };
    }
  }

  return { ignored: false };
}

/**
 * Scores a repository file path according to architectural importance for bounded scanning.
 * Favors manifests, entry points, routes, schemas/models, CI workflows, and tests.
 * Deprioritizes generated, minified, and vendored code.
 */
export function scoreFileForInspection(path: string): number {
  const lower = path.toLowerCase();
  const basename = lower.split('/').pop() || '';
  const category = categorizeFile(path);

  // 1. Deprioritize minified, generated, and vendored files
  if (basename.includes('.min.') || basename.endsWith('.min.js') || basename.endsWith('.min.css')) return 5;
  if (lower.includes('/vendor/') || lower.startsWith('vendor/')) return 5;
  if (lower.includes('/generated/') || lower.startsWith('generated/') || lower.includes('.generated.')) return 10;
  if (lower.includes('/gen/') || lower.startsWith('gen/')) return 10;

  // 2. Primary manifests
  if (category === 'manifest') {
    return lower.includes('/') ? 95 : 100;
  }

  // 3. README files (root and subdirectories)
  if (category === 'readme') {
    return lower.includes('/') ? 91 : 92;
  }

  // 3b. Key documentation files (docs, contributing, architecture, team)
  if (category === 'documentation') {
    if (
      lower.includes('team') ||
      lower.includes('contribut') ||
      lower.includes('architect') ||
      lower.includes('overview') ||
      lower.includes('guide') ||
      lower.includes('about')
    ) {
      return 89;
    }
    return 80;
  }

  // 4. Core entry points
  if (
    basename.startsWith('index.') ||
    basename.startsWith('main.') ||
    basename.startsWith('app.') ||
    basename.startsWith('server.') ||
    basename.startsWith('cli.') ||
    basename === 'manage.py'
  ) {
    return 90;
  }

  // 5. Route handlers and controllers
  if (
    /(?:^|\/)(?:routes|controllers|endpoints|api|handlers)\//i.test(lower) ||
    /(?:route|controller|endpoint|router)\.(?:ts|js|py|go|rs)$/i.test(basename)
  ) {
    return 85;
  }

  // 6. Core business logic, schemas, and models
  if (
    /(?:^|\/)(?:schemas?|models?|entities|domain|services?|store)\//i.test(lower) ||
    /(?:schema|model|entity|service|repository)\.(?:ts|js|py|go|rs|prisma|sql)$/i.test(basename)
  ) {
    return 82;
  }

  // 7. CI Workflows
  if (lower.includes('.github/workflows/')) {
    return 78;
  }

  // 8. Representative tests
  if (category === 'test') {
    return 75;
  }

  // 9. Key infrastructure and configuration
  if (
    category === 'config' &&
    (basename.startsWith('dockerfile') ||
      basename.includes('docker-compose') ||
      basename === 'tsconfig.json' ||
      basename.includes('.config.'))
  ) {
    return 70;
  }

  // 10. General configuration and source
  if (category === 'source') return 50;
  if (category === 'config') return 45;
  if (category === 'readme' || category === 'documentation') return 30;

  return 20;
}

/**
 * Identifies unsupported or non-source file extensions present in the repository tree.
 */
export function identifyUnsupportedFileTypes(tree: GitTreeEntry[]): string[] {
  const unsupportedExts = new Set<string>();

  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    const parts = entry.path.toLowerCase().split('.');
    if (parts.length > 1) {
      const ext = parts.pop()!;
      if (BINARY_EXTENSIONS.has(ext)) {
        unsupportedExts.add(ext);
      }
    }
  }

  return Array.from(unsupportedExts).sort();
}

/**
 * Prioritizes discovered tree entries for bounded source-code reading (up to maxFiles, clamped at 40).
 */
export function prioritizeFilesForInspection(
  tree: GitTreeEntry[],
  maxFiles = 25,
  maxSizeBytes = 80 * 1024
): { candidates: GitTreeEntry[]; skipped: SkippedFile[] } {
  const boundedMaxFiles = Math.min(40, Math.max(1, maxFiles));
  const skipped: SkippedFile[] = [];
  const validBlobs: GitTreeEntry[] = [];

  for (const entry of tree) {
    if (entry.type !== 'blob') {
      continue;
    }

    const { ignored, reason } = isFileIgnored(entry.path);
    if (ignored && reason) {
      skipped.push({ path: entry.path, reason });
      continue;
    }

    if (entry.size !== undefined && entry.size > maxSizeBytes) {
      skipped.push({ path: entry.path, reason: 'exceeds_file_size_limit' });
      continue;
    }

    validBlobs.push(entry);
  }

  validBlobs.sort((a, b) => scoreFileForInspection(b.path) - scoreFileForInspection(a.path));

  const candidates = validBlobs.slice(0, boundedMaxFiles);
  const remaining = validBlobs.slice(boundedMaxFiles);

  for (const rem of remaining) {
    skipped.push({ path: rem.path, reason: 'scan_file_budget_exceeded' });
  }

  return { candidates, skipped };
}

