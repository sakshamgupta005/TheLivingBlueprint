import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  scanWorkspace,
  discoverWorkspaceFilesDetailed,
  getHostFileExcerpt,
  getHostExcerpts,
} from '../src/workspaceScanner.ts';
import {
  isSensitivePath,
  parseGitIgnore,
  redactSourceContent,
  shouldIgnorePath,
} from '../src/scanFilters.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const tsLibFixture = path.join(fixturesDir, 'ts-lib');
const expressFixture = path.join(fixturesDir, 'small-express');

describe('VS Code Extension - Scanner Safety, Exclusions & Redaction (P2-03)', () => {
  it('excludes ts-lib .env with reason and never leaks fake token into snapshot or excerpts', async () => {
    const result = await scanWorkspace(tsLibFixture);

    // 1. .env must NOT be in discoveredFilePaths
    assert.strictEqual(
      result.discoveredFilePaths.includes('.env'),
      false,
      '.env must not be included in discoveredFilePaths'
    );

    // 2. .env must be in skippedFiles with reason 'sensitive_file'
    const envSkip = result.skippedFiles.find((s) => s.path === '.env');
    assert.ok(envSkip, '.env must be present in skippedFiles');
    assert.strictEqual(envSkip.reason, 'sensitive_file');
    assert.match(envSkip.detail || '', /environment file/i);

    // 3. .env must NOT be in inspectedFiles
    const envInspected = result.inspectedFiles.find((f) => f.path === '.env');
    assert.strictEqual(envInspected, undefined, '.env must never be inspected');

    // 4. Host memory excerpt must not retain .env
    const excerpt = getHostFileExcerpt(result, '.env');
    assert.strictEqual(excerpt, undefined, 'Host excerpt cache must not contain .env');

    // 5. Serialized snapshot posted to webview must NEVER contain the secret token
    const serializedSnapshot = JSON.stringify(result);
    assert.strictEqual(
      serializedSnapshot.includes('FAKE_TOKEN_DO_NOT_USE_123'),
      false,
      'Serialized snapshot must not contain FAKE_TOKEN_DO_NOT_USE_123'
    );

    // 6. Retained host memory excerpts must NEVER contain the secret token
    const allExcerpts = Array.from(getHostExcerpts(result).values());
    for (const text of allExcerpts) {
      assert.strictEqual(
        text.includes('FAKE_TOKEN_DO_NOT_USE_123'),
        false,
        'No retained excerpt may contain FAKE_TOKEN_DO_NOT_USE_123'
      );
    }
  });

  it('excludes sensitive files and directories before reading content', () => {
    // Environment files
    assert.strictEqual(isSensitivePath('.env').sensitive, true);
    assert.strictEqual(isSensitivePath('.env.local').sensitive, true);
    assert.strictEqual(isSensitivePath('.env.production').sensitive, true);
    assert.strictEqual(isSensitivePath('config/.env.test').sensitive, true);

    // Example / sample env files are permitted for structural inspection
    assert.strictEqual(isSensitivePath('.env.example').sensitive, false);
    assert.strictEqual(isSensitivePath('.env.sample').sensitive, false);
    assert.strictEqual(isSensitivePath('config/.env.example').sensitive, false);

    // Cryptographic keys and certs
    assert.strictEqual(isSensitivePath('certs/server.pem').sensitive, true);
    assert.strictEqual(isSensitivePath('id_rsa').sensitive, true);
    assert.strictEqual(isSensitivePath('id_ed25519').sensitive, true);
    assert.strictEqual(isSensitivePath('id_rsa.pub').sensitive, true);
    assert.strictEqual(isSensitivePath('keys/service.key').sensitive, true);
    assert.strictEqual(isSensitivePath('cert.p12').sensitive, true);
    assert.strictEqual(isSensitivePath('keystore.pfx').sensitive, true);

    // Credentials / package manager configs
    assert.strictEqual(isSensitivePath('.npmrc').sensitive, true);
    assert.strictEqual(isSensitivePath('.pypirc').sensitive, true);
    assert.strictEqual(isSensitivePath('.netrc').sensitive, true);
    assert.strictEqual(isSensitivePath('.git-credentials').sensitive, true);
    assert.strictEqual(isSensitivePath('credentials.json').sensitive, true);
    assert.strictEqual(isSensitivePath('credentials.prod.json').sensitive, true);
    assert.strictEqual(isSensitivePath('secrets.json').sensitive, true);
    assert.strictEqual(isSensitivePath('secrets.yaml').sensitive, true);

    // Sensitive directories
    assert.strictEqual(isSensitivePath('.aws/credentials').sensitive, true);
    assert.strictEqual(isSensitivePath('.ssh/config').sensitive, true);
    assert.strictEqual(isSensitivePath('.idea/workspace.xml').sensitive, true);
    assert.strictEqual(isSensitivePath('.venv/bin/python').sensitive, true);

    // New sensitive patterns (Blocker 2)
    assert.strictEqual(isSensitivePath('config/prod.env').sensitive, true);
    assert.strictEqual(isSensitivePath('docker.env').sensitive, true);
    assert.strictEqual(isSensitivePath('certs/server.jks').sensitive, true);
    assert.strictEqual(isSensitivePath('keystore.keystore').sensitive, true);
    assert.strictEqual(isSensitivePath('infra/terraform.tfvars').sensitive, true);
    assert.strictEqual(isSensitivePath('terraform.tfstate').sensitive, true);
    assert.strictEqual(isSensitivePath('serviceAccount.json').sensitive, true);
    assert.strictEqual(isSensitivePath('serviceAccountKey.json').sensitive, true);
    assert.strictEqual(isSensitivePath('.htpasswd').sensitive, true);
    assert.strictEqual(isSensitivePath('kubeconfig').sensitive, true);
    assert.strictEqual(isSensitivePath('kubeconfig.yaml').sensitive, true);
    assert.strictEqual(isSensitivePath('.docker/config.json').sensitive, true);
    assert.strictEqual(isSensitivePath('sub/.docker/config.json').sensitive, true);
  });

  it('redacts planted API-token strings and key assignments while preserving valid code (Blocker 2 table-driven)', () => {
    // Fake secrets are assembled at runtime so no literal in this file matches
    // a real secret format (avoids GitHub push protection / secret scanners).
    const fakeAws = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const fakeStripeLive = 'sk_' + 'live_' + '51Habcdefghijklmnopqrstuvwxyz12345';
    const fakeStripeTest = 'sk_' + 'test_' + '51Habcdefghijklmnopqrstuvwxyz12345';
    const fakeRestricted = 'rk_' + 'live_' + '51Habcdefghijklmnopqrstuvwxyz12345';
    const fakePemLabel = 'RSA ' + 'PRIVATE' + ' KEY';
    const fakeSlack = 'xo' + 'xb-' + '1234567890-1234567890123-abcdef123456';
    const fakeStripeShort = 'sk_' + 'live_' + '51H987654321';

    // 1. Table of secrets that must be redacted
    const secretSamples: Array<{ name: string; input: string; forbiddenSubstring: string }> = [
      {
        name: 'AWS Access Key ID',
        input: `const awsKey = "${fakeAws}";`,
        forbiddenSubstring: fakeAws,
      },
      {
        name: 'Stripe live key',
        input: `const stripe = "${fakeStripeLive}";`,
        forbiddenSubstring: fakeStripeLive,
      },
      {
        name: 'Stripe test key',
        input: `const stripeTest = "${fakeStripeTest}";`,
        forbiddenSubstring: fakeStripeTest,
      },
      {
        name: 'Restricted live key',
        input: `const rk = "${fakeRestricted}";`,
        forbiddenSubstring: fakeRestricted,
      },
      {
        name: 'Inline private key block',
        input: `-----BEGIN ${fakePemLabel}-----\nMIIEowIBAAKCAQEA0m...\n-----END ${fakePemLabel}-----`,
        forbiddenSubstring: 'MIIEowIBAAKCAQEA0m',
      },
      {
        name: 'Postgres connection URL password',
        input: 'const dbUrl = "postgres://admin_user:super_secret_pw@db.internal:5432/mydb";',
        forbiddenSubstring: 'super_secret_pw',
      },
      {
        name: 'Slack token',
        input: `const slackBotToken = "${fakeSlack}";`,
        forbiddenSubstring: fakeSlack,
      },
      {
        name: 'Exported environment secret',
        input: `export STRIPE_SECRET_KEY=${fakeStripeShort}`,
        forbiddenSubstring: fakeStripeShort,
      },
      {
        name: 'const token string assignment',
        input: 'const token = "raw_secret_bearer_token_val_123"',
        forbiddenSubstring: 'raw_secret_bearer_token_val_123',
      },
      {
        name: 'secret property assignment',
        input: 'const config = { secret: "my_top_secret_salt_value" };',
        forbiddenSubstring: 'my_top_secret_salt_value',
      },
      {
        name: 'Long identifier containing key name (myApiKey)',
        input: 'const myApiKey = "apiKeySecret12345";',
        forbiddenSubstring: 'apiKeySecret12345',
      },
    ];

    for (const sample of secretSamples) {
      const redacted = redactSourceContent(sample.input);
      assert.strictEqual(
        redacted.includes(sample.forbiddenSubstring),
        false,
        `Sample '${sample.name}' failed to redact: ${sample.input} -> ${redacted}`
      );
      assert.match(redacted, /\[REDACTED/, `Sample '${sample.name}' should contain [REDACTED]`);
    }

    // Passwords in connection URLs: verify only password portion was redacted
    const urlSample = 'postgres://app_user:secret_pw@localhost:5432/app';
    const redactedUrl = redactSourceContent(urlSample);
    assert.strictEqual(redactedUrl, 'postgres://app_user:[REDACTED]@localhost:5432/app');

    // 2. False-positive samples that must stay unchanged
    const falsePositiveSamples = [
      'const tokenizer = new Tokenizer()',
      'if (password.length > 8) {',
      'const userTokenCount = tokens.length;',
      'export function authenticateToken(token: string): boolean {',
    ];

    for (const fp of falsePositiveSamples) {
      const result = redactSourceContent(fp);
      assert.strictEqual(result, fp, `False positive sample was modified: ${fp} -> ${result}`);
    }
  });

  it('depth limit skips only subtree, records skippedFiles, and does not truncate scan (Blocker 1)', async () => {
    // Build temp fixture with 13-level-deep folder plus package.json and src/index.ts
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-depth-test-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name": "depth-test"}');
      fs.mkdirSync(path.join(tempDir, 'src'));
      fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const a = 1;');

      // Create 13 levels deep: level1/level2/.../level13/deep.ts
      let current = tempDir;
      for (let i = 1; i <= 13; i++) {
        current = path.join(current, `level${i}`);
        fs.mkdirSync(current);
      }
      fs.writeFileSync(path.join(current, 'deep.ts'), 'export const deep = true;');

      const result = await discoverWorkspaceFilesDetailed(tempDir, { maxDepth: 10 });

      // Both shallow files MUST be discovered
      assert.ok(result.discoveredFilePaths.includes('package.json'), 'package.json must be discovered');
      assert.ok(result.discoveredFilePaths.includes('src/index.ts'), 'src/index.ts must be discovered');

      // The deep folder must be skipped and recorded with discovery_depth_exceeded
      const depthSkip = result.skippedFiles.find((s) => s.reason === 'discovery_depth_exceeded');
      assert.ok(depthSkip, 'Must record skippedFiles with discovery_depth_exceeded');
      assert.match(depthSkip.path, /level11/);

      // truncated flag MUST be false (depth does not truncate whole scan)
      assert.strictEqual(result.truncation.truncated, false, 'Scan must not be marked truncated for depth');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('respects .gitignore rules and reports unsupported syntax without crashing', () => {
    const gitIgnoreContent = [
      '# Ignore temp logs and build output',
      '*.log',
      '!important.log',
      'build/',
      '/root-only.txt',
      'deep/**/cache.json',
      '# Unsupported syntax for test',
      '[a-z]*.dat',
      'invalid-regex\\',
    ].join('\n');

    const matcher = parseGitIgnore(gitIgnoreContent);

    // Unsupported rules recorded without crashing
    assert.strictEqual(matcher.unsupportedRules.length, 2);
    assert.strictEqual(matcher.unsupportedRules[0], '[a-z]*.dat');
    assert.strictEqual(matcher.unsupportedRules[1], 'invalid-regex\\');

    // Matching tests
    assert.strictEqual(matcher.matches('error.log', false), true);
    assert.strictEqual(matcher.matches('logs/app.log', false), true);
    assert.strictEqual(matcher.matches('important.log', false), false, 'Negated !important.log must not be ignored');
    assert.strictEqual(matcher.matches('build', true), true, 'Directory build/ matches');
    assert.strictEqual(matcher.matches('build', false), false, 'File build does not match directory-only rule');
    assert.strictEqual(matcher.matches('root-only.txt', false), true);
    assert.strictEqual(matcher.matches('sub/root-only.txt', false), false, 'Root-anchored /root-only.txt does not match subfolder');
    assert.strictEqual(matcher.matches('deep/a/b/cache.json', false), true);
  });

  it('enforces discovery caps and marks scan truncated with reason', async () => {
    // Create temporary workspace with nested tree
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-cap-test-'));
    try {
      // 1. Create 8 files
      for (let i = 0; i < 8; i++) {
        fs.writeFileSync(path.join(tempDir, `file_${i}.txt`), `content ${i}`);
      }

      // Test cap: maxDiscoveredFiles = 3
      const cappedResult = await discoverWorkspaceFilesDetailed(tempDir, {
        maxDiscoveredFiles: 3,
      });

      assert.strictEqual(cappedResult.discoveredFilePaths.length, 3);
      assert.strictEqual(cappedResult.truncation.truncated, true);
      assert.strictEqual(cappedResult.truncation.reason, 'max_files_exceeded');

      // Test depth cap: maxDepth = 2
      let deepDir = tempDir;
      for (let d = 0; d < 5; d++) {
        deepDir = path.join(deepDir, `level_${d}`);
        fs.mkdirSync(deepDir, { recursive: true });
        fs.writeFileSync(path.join(deepDir, 'deep_file.txt'), 'deep');
      }

      const depthResult = await discoverWorkspaceFilesDetailed(tempDir, {
        maxDiscoveredFiles: 50,
        maxDepth: 2,
      });

      // Depth exceeded skips subtree without setting global truncated flag (Blocker 1)
      assert.strictEqual(depthResult.truncation.truncated, false);
      assert.ok(depthResult.skippedFiles.some((s) => s.reason === 'discovery_depth_exceeded'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('maintains deterministic ordering across multiple scan runs', async () => {
    const run1 = await scanWorkspace(expressFixture);
    const run2 = await scanWorkspace(expressFixture);

    assert.deepStrictEqual(run1.discoveredFilePaths, run2.discoveredFilePaths);
    assert.deepStrictEqual(run1.inspectedFiles, run2.inspectedFiles);
    assert.deepStrictEqual(
      run1.skippedFiles.map((s) => s.path),
      run2.skippedFiles.map((s) => s.path)
    );
  });

  it('keeps host excerpts bounded and out of serialized webview snapshot', async () => {
    const result = await scanWorkspace(expressFixture, { maxExcerptChars: 500 });

    // Host excerpt exists in host memory
    const serverExcerpt = getHostFileExcerpt(result, 'src/server.js');
    assert.ok(serverExcerpt, 'Host excerpt should exist for inspected src/server.js');
    assert(serverExcerpt.length <= 500, 'Excerpt must be bounded by maxExcerptChars');

    // hostExcerpts must not be serialized into JSON
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.hostExcerpts, undefined, 'hostExcerpts must not be serialized into webview data');
  });
});
