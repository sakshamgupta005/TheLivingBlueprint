/**
 * GitHub repository URL validation and parsing.
 * Restricts queries strictly to valid public GitHub repositories.
 */

export interface ParsedGitHubUrl {
  valid: true;
  owner: string;
  repo: string;
  canonicalUrl: string;
}

export interface InvalidGitHubUrl {
  valid: false;
  error: string;
}

export type GitHubUrlValidationResult = ParsedGitHubUrl | InvalidGitHubUrl;

// GitHub owner: alphanumeric + single hyphens, 1-39 chars.
// GitHub repo: alphanumeric, hyphens, underscores, dots, 1-100 chars.
const OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const REPO_REGEX = /^[a-zA-Z0-9_.-]{1,100}$/;

export function validateGitHubUrl(rawInput: string): GitHubUrlValidationResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return { valid: false, error: 'Repository URL cannot be empty.' };
  }

  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Repository URL cannot be empty.' };
  }

  // Auto-prefix protocol if user typed "github.com/owner/repo"
  const urlCandidate = trimmed.startsWith('http://') || trimmed.startsWith('https://')
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(urlCandidate);
  } catch {
    return { valid: false, error: 'Malformed URL. Please provide a valid web URL.' };
  }

  // Must be github.com (or www.github.com)
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return {
      valid: false,
      error: `Unsupported host "${parsed.hostname}". Only public GitHub repositories (github.com) are supported.`,
    };
  }

  // Disallow query params or fragments that could manipulate path
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (!path) {
    return { valid: false, error: 'Missing repository path. Expected format: github.com/owner/repository' };
  }

  // Remove optional trailing .git
  const cleanPath = path.endsWith('.git') ? path.slice(0, -4) : path;
  const segments = cleanPath.split('/').filter(Boolean);

  if (segments.length !== 2) {
    return {
      valid: false,
      error: 'Invalid repository path. Expected format: https://github.com/{owner}/{repository}',
    };
  }

  const [owner, repo] = segments;

  if (!OWNER_REGEX.test(owner)) {
    return { valid: false, error: `Invalid GitHub owner or organization name: "${owner}".` };
  }

  if (!REPO_REGEX.test(repo) || repo === '.' || repo === '..') {
    return { valid: false, error: `Invalid GitHub repository name: "${repo}".` };
  }

  return {
    valid: true,
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}
