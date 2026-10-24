/**
 * Scan filtering, security deny-lists, .gitignore integration, and source redaction
 * for local VS Code workspace scanning.
 *
 * Layers on top of the shared isFileIgnored without modifying web app behavior.
 */

import { isFileIgnored } from '../../src/domain/github/fileFilter.ts';
import { redactSensitiveInfo } from '../../src/server/errorClassifier.ts';

export type SkippedFileReason =
  | 'ignored_directory'
  | 'binary_asset'
  | 'lockfile'
  | 'sensitive_file'
  | 'gitignore'
  | 'exceeds_file_size_limit'
  | 'scan_file_budget_exceeded'
  | 'scan_byte_budget_exceeded'
  | 'content_fetch_failed'
  | 'discovery_depth_exceeded'
  | 'unsupported_file_type';

export interface ExtensionSkippedFile {
  path: string;
  reason: SkippedFileReason;
  detail?: string;
}

export interface SensitiveCheckResult {
  sensitive: boolean;
  reason?: string;
}

const SENSITIVE_DIR_NAMES = new Set(['.aws', '.ssh', '.idea', '.venv']);

const SENSITIVE_EXACT_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  'kubeconfig',
  'secrets',
]);

const SENSITIVE_EXTENSIONS = new Set([
  'pem',
  'key',
  'p12',
  'pfx',
  'jks',
  'keystore',
  'tfvars',
  'tfstate',
]);

/**
 * Checks whether a given path points to a known sensitive file or directory
 * that must NEVER be read into memory or retained unredacted.
 */
export function isSensitivePath(relPath: string): SensitiveCheckResult {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1] || '';
  const lowerBase = basename.toLowerCase();

  // 1. Sensitive directory names anywhere in path
  for (const segment of segments) {
    if (SENSITIVE_DIR_NAMES.has(segment.toLowerCase())) {
      return {
        sensitive: true,
        reason: `Directory '${segment}' is on the local sensitive deny-list`,
      };
    }
  }

  // Docker credentials (.docker/config.json)
  if (
    normalized.endsWith('.docker/config.json') ||
    (segments.some((s) => s.toLowerCase() === '.docker') && lowerBase === 'config.json')
  ) {
    return {
      sensitive: true,
      reason: `Docker credential file '${basename}' is on the local sensitive deny-list`,
    };
  }

  // 2. Exact match filenames (.npmrc, .pypirc, .netrc, .git-credentials, .htpasswd, kubeconfig)
  if (SENSITIVE_EXACT_NAMES.has(lowerBase) || lowerBase.startsWith('kubeconfig')) {
    return {
      sensitive: true,
      reason: `Credential file '${basename}' is on the local sensitive deny-list`,
    };
  }

  // 3. Environment files (*.env, .env*)
  const isEnvFile =
    lowerBase.startsWith('.env') ||
    lowerBase.endsWith('.env') ||
    lowerBase.includes('.env.');

  if (isEnvFile) {
    // .env.example and .env.sample are explicitly permitted for structural inspection with redaction
    const isExampleOrSample =
      lowerBase === '.env.example' ||
      lowerBase === '.env.sample' ||
      lowerBase.endsWith('.env.example') ||
      lowerBase.endsWith('.env.sample') ||
      lowerBase.startsWith('.env.example.') ||
      lowerBase.startsWith('.env.sample.');

    if (isExampleOrSample) {
      return { sensitive: false };
    }
    return {
      sensitive: true,
      reason: `Environment file '${basename}' contains secrets and is excluded from inspection`,
    };
  }

  // 4. Certificates and private keys (*.pem, *.key, *.p12, *.pfx, *.jks, *.keystore, *.tfvars, *.tfstate)
  const extMatch = lowerBase.match(/\.([a-z0-9]+)$/);
  if (extMatch && SENSITIVE_EXTENSIONS.has(extMatch[1])) {
    return {
      sensitive: true,
      reason: `Cryptographic key/credential '${basename}' is excluded from inspection`,
    };
  }

  // 5. SSH key files (id_rsa*, id_ed25519*)
  if (lowerBase.startsWith('id_rsa') || lowerBase.startsWith('id_ed25519')) {
    return {
      sensitive: true,
      reason: `SSH key '${basename}' is on the local sensitive deny-list`,
    };
  }

  // 6. JSON credentials (credentials*.json, serviceAccount*.json)
  if (
    (lowerBase.startsWith('credentials') || lowerBase.startsWith('serviceaccount')) &&
    lowerBase.endsWith('.json')
  ) {
    return {
      sensitive: true,
      reason: `Credentials file '${basename}' is excluded from inspection`,
    };
  }

  // 7. Secrets files (secrets.*)
  if (lowerBase.startsWith('secrets.')) {
    return {
      sensitive: true,
      reason: `Secrets file '${basename}' is excluded from inspection`,
    };
  }

  return { sensitive: false };
}

export interface GitIgnoreRule {
  pattern: string;
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
  raw: string;
}

export interface GitIgnoreMatcher {
  rules: GitIgnoreRule[];
  unsupportedRules: string[];
  matches(relPath: string, isDirectory: boolean): boolean;
}

/**
 * Translates a supported .gitignore glob into a regular expression.
 * Supported subset:
 *  - # comments and blank lines
 *  - ! negation prefix
 *  - trailing / directory indicator
 *  - leading / or inner / root anchoring
 *  - * (wildcard within segment)
 *  - ** (directory recursion)
 *  - ? (single character within segment)
 *
 * Unsupported syntax:
 *  - character classes/ranges ([a-z], [!0-9], [[:alpha:]])
 *  - trailing unescaped backslashes
 */
function convertGitIgnoreGlobToRegex(pattern: string): RegExp | null {
  // If pattern contains character ranges or classes, mark as unsupported
  if (/\[.*\]/.test(pattern) || pattern.endsWith('\\')) {
    return null;
  }

  let p = pattern;
  const isAnchored = p.startsWith('/') || p.includes('/');
  if (p.startsWith('/')) {
    p = p.slice(1);
  }

  // Escape regex special chars except * and ?
  let regexStr = p.replace(/[.+^$(){}|[\]\\]/g, '\\$&');

  // Handle ** and *
  // Replace ** with a placeholder
  regexStr = regexStr.replace(/\*\*/g, '__DOUBLE_STAR__');
  // Replace * with [^/]*
  regexStr = regexStr.replace(/\*/g, '[^/]*');
  // Replace ? with [^/]
  regexStr = regexStr.replace(/\?/g, '[^/]');
  // Replace placeholder with .*
  regexStr = regexStr.replace(/__DOUBLE_STAR__/g, '.*');

  if (isAnchored) {
    return new RegExp(`^${regexStr}(?:/.*)?$`, 'i');
  } else {
    return new RegExp(`(?:^|/)${regexStr}(?:/.*)?$`, 'i');
  }
}

/**
 * Parses top-level .gitignore content into an evaluator rule set.
 */
export function parseGitIgnore(content: string): GitIgnoreMatcher {
  const rules: GitIgnoreRule[] = [];
  const unsupportedRules: string[] = [];

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    let pattern = trimmed;
    let negated = false;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1).trim();
    }

    let directoryOnly = false;
    if (pattern.endsWith('/')) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    const regex = convertGitIgnoreGlobToRegex(pattern);
    if (!regex) {
      unsupportedRules.push(rawLine);
      continue;
    }

    rules.push({
      pattern,
      regex,
      negated,
      directoryOnly,
      raw: rawLine,
    });
  }

  return {
    rules,
    unsupportedRules,
    matches(relPath: string, isDirectory: boolean): boolean {
      const normalized = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      let ignored = false;

      for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory) {
          continue;
        }
        if (rule.regex.test(normalized)) {
          ignored = !rule.negated;
        }
      }

      return ignored;
    },
  };
}

export interface PathFilterDecision {
  ignored: boolean;
  reason?: SkippedFileReason;
  detail?: string;
}

/**
 * Evaluates whether a path should be skipped during local discovery.
 * Layers local sensitive deny-lists and .gitignore on top of shared isFileIgnored.
 */
export function shouldIgnorePath(
  relPath: string,
  isDirectory: boolean,
  gitIgnoreMatcher?: GitIgnoreMatcher
): PathFilterDecision {
  // 1. Local sensitive rules take absolute highest priority
  const sensitiveCheck = isSensitivePath(relPath);
  if (sensitiveCheck.sensitive) {
    return {
      ignored: true,
      reason: 'sensitive_file',
      detail: sensitiveCheck.reason,
    };
  }

  // 2. Shared fileFilter rules
  const sharedCheck = isFileIgnored(relPath + (isDirectory ? '/' : ''));
  if (sharedCheck.ignored) {
    return {
      ignored: true,
      reason: (sharedCheck.reason as SkippedFileReason) || 'ignored_directory',
      detail: `Excluded by shared fileFilter (${sharedCheck.reason})`,
    };
  }

  // 3. Top-level .gitignore rules
  if (gitIgnoreMatcher && gitIgnoreMatcher.matches(relPath, isDirectory)) {
    return {
      ignored: true,
      reason: 'gitignore',
      detail: 'Excluded by top-level .gitignore pattern',
    };
  }

  return { ignored: false };
}

/**
 * Sanitizes inspected source content before storing or inspecting in memory.
 * Reuses redactSensitiveInfo and applies narrowly targeted token and key assignment redactions.
 */
export function redactSourceContent(content: string, extraSecrets: string[] = []): string {
  if (!content) return '';

  // 1. Run shared errorClassifier redactor
  let sanitized = redactSensitiveInfo(content, extraSecrets);

  // 2. Targeted token formats
  // AWS Access Key ID: AKIA...
  sanitized = sanitized.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');

  // Google API Key: AIza...
  sanitized = sanitized.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED]');

  // OpenAI / Anthropic / general secret tokens: sk-..., sk-ant-...
  sanitized = sanitized.replace(/\bsk-(?:ant-)?[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED]');

  // Stripe / payment / provider tokens: sk_live_..., sk_test_..., rk_live_..., rk_test_...
  sanitized = sanitized.replace(/\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{10,}\b/g, '[REDACTED]');

  // Slack tokens: xox[abpors]-...
  sanitized = sanitized.replace(/\bxox[abpors]-[0-9a-zA-Z-]{10,}\b/g, '[REDACTED]');

  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  sanitized = sanitized.replace(/\bgh[pousr]_[a-zA-Z0-9]{20,}\b/g, '[REDACTED]');
  sanitized = sanitized.replace(/\bgithub_pat_[a-zA-Z0-9_]{60,}\b/g, '[REDACTED]');

  // Bearer tokens with long base64/hex strings
  sanitized = sanitized.replace(/(Bearer\s+)[a-zA-Z0-9_.+/=-]{16,}/gi, '$1[REDACTED]');

  // Inline PEM private key blocks
  sanitized = sanitized.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]'
  );

  // Passwords in connection URLs (e.g. postgres://user:pass@host:5432/db)
  sanitized = sanitized.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^@\s\/]*?:)([^@\s\/]+)(@[^\s\/]+)/g,
    '$1[REDACTED]$3'
  );

  // 3. Secret-like assignments in code (e.g. const token = "...", secret: '...', export STRIPE_SECRET_KEY=...)
  // Handles identifiers with prefix/suffix (e.g. STRIPE_SECRET_KEY, myApiKey, authToken)
  const envPattern =
    /^([ \t]*(?:export\s+)?[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASS|PASSWORD|AUTH)[A-Za-z0-9_]*\s*=\s*)(["']?)([^"'\r\n\s]+)\2/gim;
  sanitized = sanitized.replace(envPattern, '$1$2[REDACTED]$2');

  const codeAssignmentPattern =
    /((?:^|\b)(?:export\s+)?(?:const|let|var\s+)?(?:[a-zA-Z0-9_]*(?:api_?key|secret(?:_?key)?|access_?token|auth_?token|token|password|passwd)(?=$|[\s:=_A-Z]))\s*[:=]\s*)(["'])((?:\\.|[^\r\n"'\\])+)\2/gmi;
  sanitized = sanitized.replace(codeAssignmentPattern, '$1$2[REDACTED]$2');

  const assignmentPattern =
    /\b((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|jwt[_-]?secret|password)\s*[:=]\s*(?:\\?["'])?)([^"'\s\r\n\\]{4,})((?:\\?["'])?)/gi;
  sanitized = sanitized.replace(assignmentPattern, '$1[REDACTED]$3');

  return sanitized;
}
