import type { BenchmarkFixture } from './types.ts';

export const docHeavyFixture: BenchmarkFixture = {
  id: 'fixture-doc-heavy',
  name: 'Documentation & Generated-Heavy Repository',
  owner: 'benchmark-org',
  repo: 'protocol-spec-and-docs',
  defaultBranch: 'main',
  commitSha: 'e5f60718293a4b5c6d7e8f90123456789012345a',
  checkRuns: [],
  files: {
    'README.md': `# Open Protocol Specification\n\nThis repository holds the formal RFC specifications, design notes, and generated language schemas.`,
    'docs/rfc-001-protocol.md': `# RFC 001: Protocol Handshake\n\nDetailed byte-level layout for the wire protocol handshake.`,
    'docs/rfc-002-framing.md': `# RFC 002: Frame Encoding\n\nVariable-length integer encoding and chunk framing specifications.`,
    'docs/rfc-003-security.md': `# RFC 003: Encryption & Auth\n\nTLS 1.3 profile, ciphersuite constraints, and authentication token formats.`,
    'docs/glossary.md': `# Protocol Glossary\n\nTerminology definitions for implementors.`,
    'docs/contributing.md': `# Contributing Guide\n\nInstructions on formatting RFC documents.`,
    'generated/protocol_schema.json': JSON.stringify(
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'ProtocolFrame',
        type: 'object',
        properties: {
          magic: { type: 'string', pattern: '^0x[0-9a-fA-F]{8}$' },
          version: { type: 'integer', minimum: 1 },
          payload: { type: 'string' },
        },
        required: ['magic', 'version'],
      },
      null,
      2
    ),
    'generated/client_stubs.ts': `// GENERATED CODE - DO NOT EDIT MANUALLY
export interface ProtocolFrameStub {
  magic: string;
  version: number;
  payload: string;
}
`,
    'dist/protocol.bundle.min.js': `/* Minified distribution bundle */ var x=1;`,
    'coverage/coverage-summary.json': `{"total":{"lines":{"total":0,"covered":0}}}`,
    'package-lock.json': `{"name": "protocol-spec-and-docs", "lockfileVersion": 3}`,
  },
  knownFacts: {
    name: 'Documentation & Generated-Heavy Repository',
    description: 'Repository dominated by markdown RFC documents, generated schemas, and ignored build artifacts.',
    entryPoints: [],
    routes: [],
    imports: [],
    tests: [],
    workflows: [],
    expectedRelationships: [],
    expectedRooms: ['room-core'], // Gracefully defaults to application core without inventing nonexistent services
    unsupportedOrUncertainFacts: [
      'No runnable application server or HTTP routes exist in this repository',
      'No automated test suite is configured or discovered',
      'Minified artifacts in dist/ and lockfiles are skipped by file filter rules',
    ],
  },
};
