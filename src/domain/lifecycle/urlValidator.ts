/**
 * Validation and extraction of commit and pull request references.
 * Strictly enforces repository identity against the active repository.
 */

export interface ValidCommitRef {
  valid: true;
  refType: 'commit_sha' | 'commit_url' | 'pull_request_url';
  resolvedRef: string;
  pullNumber?: number;
  canonicalUrl?: string;
}

export interface InvalidCommitRef {
  valid: false;
  error: string;
}

export type CommitRefValidationResult = ValidCommitRef | InvalidCommitRef;

const COMMIT_SHA_REGEX = /^[0-9a-fA-F]{7,40}$/;

/**
 * Validates a user-supplied commit reference (URL or SHA) against the active repository.
 */
export function validateCommitReference(
  rawInput: string | undefined,
  activeOwner: string,
  activeRepo: string
): CommitRefValidationResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      valid: false,
      error: 'Commit or pull request reference is empty.',
    };
  }

  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      error: 'Commit or pull request reference cannot be blank.',
    };
  }

  // 1. Direct SHA candidate (7-40 hex chars)
  if (COMMIT_SHA_REGEX.test(trimmed)) {
    return {
      valid: true,
      refType: 'commit_sha',
      resolvedRef: trimmed,
      canonicalUrl: `https://github.com/${activeOwner}/${activeRepo}/commit/${trimmed}`,
    };
  }

  // 2. URL validation
  const urlCandidate = trimmed.startsWith('http://') || trimmed.startsWith('https://')
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(urlCandidate);
  } catch {
    return {
      valid: false,
      error: 'Invalid reference format. Provide a commit SHA or a valid GitHub commit/PR link.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return {
      valid: false,
      error: `Unsupported host "${parsed.hostname}". Only links to the active repository on github.com are permitted.`,
    };
  }

  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);

  // Expected formats:
  // 1. /:owner/:repo/commit/:sha (4 segments)
  // 2. /:owner/:repo/pull/:number (4 segments)
  if (segments.length < 4) {
    return {
      valid: false,
      error: 'Invalid GitHub URL. Expected format: https://github.com/:owner/:repo/commit/:sha or /pull/:number',
    };
  }

  const [urlOwner, urlRepo, actionType, idOrSha] = segments;

  // Strict Repository Identity Check
  if (
    urlOwner.toLowerCase() !== activeOwner.toLowerCase() ||
    urlRepo.toLowerCase() !== activeRepo.toLowerCase()
  ) {
    return {
      valid: false,
      error: `Repository mismatch: Link points to "${urlOwner}/${urlRepo}", but active repository is "${activeOwner}/${activeRepo}".`,
    };
  }

  if (actionType === 'commit') {
    if (!COMMIT_SHA_REGEX.test(idOrSha)) {
      return {
        valid: false,
        error: `Malformed commit SHA in URL: "${idOrSha}". Expected 7-40 hex characters.`,
      };
    }
    return {
      valid: true,
      refType: 'commit_url',
      resolvedRef: idOrSha,
      canonicalUrl: `https://github.com/${activeOwner}/${activeRepo}/commit/${idOrSha}`,
    };
  }

  if (actionType === 'pull') {
    const pullNumber = parseInt(idOrSha, 10);
    if (isNaN(pullNumber) || pullNumber <= 0) {
      return {
        valid: false,
        error: `Malformed pull request number in URL: "${idOrSha}".`,
      };
    }
    return {
      valid: true,
      refType: 'pull_request_url',
      resolvedRef: `pull/${pullNumber}`,
      pullNumber,
      canonicalUrl: `https://github.com/${activeOwner}/${activeRepo}/pull/${pullNumber}`,
    };
  }

  return {
    valid: false,
    error: `Unsupported GitHub URL path type: "${actionType}". Expected "commit" or "pull".`,
  };
}
