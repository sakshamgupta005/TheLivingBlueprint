import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  addEvidenceRecord,
  deriveProjectStatus,
  deriveRoomStatus,
  evaluateRequirement,
  isEvidenceRelevantToRequirement,
} from '../src/domain/statusEngine.ts';
import type { EvidenceRecord, Project, Requirement, RoomModule } from '../src/domain/types.ts';

describe('Deterministic Status Engine', () => {
  const reqAuth: Requirement = {
    id: 'req-auth',
    title: 'JWT Authentication',
    description: 'Issue signed JWTs upon valid user login.',
  };

  const reqRefresh: Requirement = {
    id: 'req-refresh',
    title: 'Refresh Token Rotation',
    description: 'Rotate refresh token upon exchange.',
  };

  const baseRoom: RoomModule = {
    id: 'room-auth',
    name: 'Auth Module',
    description: 'Handles login and tokens',
    layer: 'service',
    requirements: [reqAuth, reqRefresh],
    evidenceHistory: [],
  };

  it('evaluates status: PLANNED when there is no sufficient evidence of implementation', () => {
    const room: RoomModule = { ...baseRoom, evidenceHistory: [] };
    const evaluation = deriveRoomStatus(room);

    assert.strictEqual(evaluation.status, 'planned');
    assert.match(evaluation.reason, /planned/i);
    assert.strictEqual(evaluation.requirementEvaluations.length, 2);
    assert.strictEqual(evaluation.requirementEvaluations[0].status, 'planned');
    assert.strictEqual(evaluation.requirementEvaluations[1].status, 'planned');
  });

  it('evaluates status: IMPLEMENTED when relevant code exists but verification is not established', () => {
    const codeEvidence: EvidenceRecord = {
      id: 'ev-code-1',
      sourceType: 'source_code',
      description: 'Implemented jwt.sign and verify middleware',
      timestamp: '2026-10-18T10:00:00Z',
      reference: 'src/auth/jwt.ts:1-45',
      targetRequirementId: 'req-auth',
    };

    const room: RoomModule = {
      ...baseRoom,
      requirements: [reqAuth],
      evidenceHistory: [codeEvidence],
    };

    const evaluation = deriveRoomStatus(room);
    assert.strictEqual(evaluation.status, 'implemented');
    assert.strictEqual(evaluation.requirementEvaluations[0].status, 'implemented');
  });

  it('evaluates status: VERIFIED when relevant, current verification evidence supports requirements', () => {
    const testAuth: EvidenceRecord = {
      id: 'ev-test-1',
      sourceType: 'test_result',
      description: 'Unit test: JWT signing and validation',
      timestamp: '2026-10-18T10:05:00Z',
      reference: 'test/auth.test.ts',
      targetRequirementId: 'req-auth',
      verificationResult: { status: 'passed', testName: 'testJwtSigning' },
    };

    const testRefresh: EvidenceRecord = {
      id: 'ev-test-2',
      sourceType: 'test_result',
      description: 'Integration test: Refresh token rotation',
      timestamp: '2026-10-18T10:06:00Z',
      reference: 'test/refresh.test.ts',
      targetRequirementId: 'req-refresh',
      verificationResult: { status: 'passed', testName: 'testTokenRotation' },
    };

    const room: RoomModule = {
      ...baseRoom,
      evidenceHistory: [testAuth, testRefresh],
    };

    const evaluation = deriveRoomStatus(room);
    assert.strictEqual(evaluation.status, 'verified');
    assert.strictEqual(evaluation.requirementEvaluations[0].status, 'verified');
    assert.strictEqual(evaluation.requirementEvaluations[1].status, 'verified');
  });

  it('evaluates status: BLOCKED when relevant current evidence shows failing verification or unresolved blocker', () => {
    const failingTest: EvidenceRecord = {
      id: 'ev-fail-1',
      sourceType: 'test_result',
      description: 'Integration test: Token rotation rejected with 500 error',
      timestamp: '2026-10-18T10:10:00Z',
      reference: 'test/refresh.test.ts:42',
      targetRequirementId: 'req-refresh',
      verificationResult: { status: 'failed', details: 'Database connection timeout' },
    };

    const room: RoomModule = {
      ...baseRoom,
      evidenceHistory: [failingTest],
    };

    const evaluation = deriveRoomStatus(room);
    assert.strictEqual(evaluation.status, 'blocked');
    assert.match(evaluation.reason, /blocked/i);
  });

  it('evaluates status: UNKNOWN when active evidence is contradictory without supersession', () => {
    const passingTest: EvidenceRecord = {
      id: 'ev-pass-1',
      sourceType: 'test_result',
      description: 'Local test passed',
      timestamp: '2026-10-18T10:00:00Z',
      targetRequirementId: 'req-auth',
      verificationResult: { status: 'passed' },
    };

    const failingTest: EvidenceRecord = {
      id: 'ev-fail-1',
      sourceType: 'test_result',
      description: 'CI run failed for same commit',
      timestamp: '2026-10-18T10:01:00Z',
      targetRequirementId: 'req-auth',
      verificationResult: { status: 'failed' },
    };

    const room: RoomModule = {
      ...baseRoom,
      requirements: [reqAuth],
      evidenceHistory: [passingTest, failingTest], // Both active, neither superseded
    };

    const evaluation = deriveRoomStatus(room);
    assert.strictEqual(evaluation.status, 'unknown');
    assert.match(evaluation.reason, /contradictory/i);
  });

  it('does NOT allow a passing test to automatically verify every requirement in a room', () => {
    // req-auth has a passing test
    const testAuth: EvidenceRecord = {
      id: 'ev-test-auth',
      sourceType: 'test_result',
      description: 'Auth JWT verified',
      timestamp: '2026-10-18T10:00:00Z',
      targetRequirementId: 'req-auth',
      verificationResult: { status: 'passed' },
    };

    // req-refresh only has implementation code, no passing test
    const codeRefresh: EvidenceRecord = {
      id: 'ev-code-refresh',
      sourceType: 'source_code',
      description: 'Refresh rotation draft code',
      timestamp: '2026-10-18T10:02:00Z',
      targetRequirementId: 'req-refresh',
    };

    const room: RoomModule = {
      ...baseRoom,
      evidenceHistory: [testAuth, codeRefresh],
    };

    const evaluation = deriveRoomStatus(room);
    // Room must NOT be verified because req-refresh is not verified
    assert.strictEqual(evaluation.status, 'implemented');

    const authEval = evaluation.requirementEvaluations.find((r) => r.requirementId === 'req-auth');
    const refreshEval = evaluation.requirementEvaluations.find((r) => r.requirementId === 'req-refresh');

    assert.strictEqual(authEval?.status, 'verified');
    assert.strictEqual(refreshEval?.status, 'implemented');
  });

  it('handles a failed test followed by a valid retest with evidence supersession', () => {
    const failedTest: EvidenceRecord = {
      id: 'ev-test-fail',
      sourceType: 'test_result',
      description: 'Jest run #1: Syntax error in token decoder',
      timestamp: '2026-10-18T10:00:00Z',
      targetRequirementId: 'req-auth',
      verificationResult: { status: 'failed', details: 'SyntaxError: Unexpected token' },
    };

    let room: RoomModule = {
      ...baseRoom,
      requirements: [reqAuth],
      evidenceHistory: [failedTest],
    };

    // Before retest: status is blocked
    const evalBefore = deriveRoomStatus(room);
    assert.strictEqual(evalBefore.status, 'blocked');

    // Retest passes and explicitly supersedes the failed test
    const passingRetest: EvidenceRecord = {
      id: 'ev-test-pass',
      sourceType: 'test_result',
      description: 'Jest run #2: All tests passing after fix',
      timestamp: '2026-10-18T10:05:00Z',
      targetRequirementId: 'req-auth',
      verificationResult: { status: 'passed' },
    };

    room = addEvidenceRecord(room, passingRetest, 'ev-test-fail');

    // Verification check: failed test is preserved in history, NOT erased
    assert.strictEqual(room.evidenceHistory.length, 2);
    const oldRecord = room.evidenceHistory.find((e) => e.id === 'ev-test-fail');
    assert.strictEqual(oldRecord?.isSuperseded, true);
    assert.strictEqual(oldRecord?.supersededBy, 'ev-test-pass');

    // Status evaluation after valid retest: now verified
    const evalAfter = deriveRoomStatus(room);
    assert.strictEqual(evalAfter.status, 'verified');
    assert.strictEqual(evalAfter.activeEvidenceCount, 1);
    assert.strictEqual(evalAfter.supersededEvidenceCount, 1);
  });

  it('ensures AI inference alone and unsupported completion claims never produce VERIFIED', () => {
    const aiClaim: EvidenceRecord = {
      id: 'ev-ai-claim',
      sourceType: 'ai_inference',
      description: 'AI model claims: "I have implemented and fully verified JWT authentication"',
      timestamp: '2026-10-18T10:00:00Z',
      targetRequirementId: 'req-auth',
      verificationResult: { status: 'passed' },
    };

    const codeEvidence: EvidenceRecord = {
      id: 'ev-code',
      sourceType: 'source_code',
      description: 'Source code in jwt.ts',
      timestamp: '2026-10-18T10:01:00Z',
      targetRequirementId: 'req-auth',
    };

    const roomWithCodeAndAi: RoomModule = {
      ...baseRoom,
      requirements: [reqAuth],
      evidenceHistory: [aiClaim, codeEvidence],
    };

    const evalWithCode = deriveRoomStatus(roomWithCodeAndAi);
    // Must be implemented, NOT verified!
    assert.notStrictEqual(evalWithCode.status, 'verified');
    assert.strictEqual(evalWithCode.status, 'implemented');

    // Without code or tests, AI claim alone is unknown / planned, never verified
    const roomAiOnly: RoomModule = {
      ...baseRoom,
      requirements: [reqAuth],
      evidenceHistory: [aiClaim],
    };

    const evalAiOnly = deriveRoomStatus(roomAiOnly);
    assert.notStrictEqual(evalAiOnly.status, 'verified');
    assert.strictEqual(evalAiOnly.status, 'unknown');
  });

  it('aggregates project status deterministically across multiple rooms', () => {
    const verifiedRoom: RoomModule = {
      id: 'room-1',
      name: 'Catalog',
      description: 'Book catalog',
      layer: 'core',
      requirements: [{ id: 'req-1', title: 'Schema' }],
      evidenceHistory: [
        {
          id: 'ev-1',
          sourceType: 'test_result',
          description: 'Catalog test passed',
          timestamp: '2026-10-18T10:00:00Z',
          targetRequirementId: 'req-1',
          verificationResult: { status: 'passed' },
        },
      ],
    };

    const blockedRoom: RoomModule = {
      id: 'room-2',
      name: 'Checkout',
      description: 'Stripe payments',
      layer: 'service',
      requirements: [{ id: 'req-2', title: 'Stripe Webhooks' }],
      evidenceHistory: [
        {
          id: 'ev-2',
          sourceType: 'test_result',
          description: 'Webhook verification failed',
          timestamp: '2026-10-18T10:00:00Z',
          targetRequirementId: 'req-2',
          verificationResult: { status: 'failed' },
        },
      ],
    };

    const plannedRoom: RoomModule = {
      id: 'room-3',
      name: 'Recommendations',
      description: 'ML embeddings',
      layer: 'gateway',
      requirements: [{ id: 'req-3', title: 'Embedding Model' }],
      evidenceHistory: [],
    };

    const project: Project = {
      id: 'proj-booknook',
      name: 'BookNook',
      rooms: [verifiedRoom, blockedRoom, plannedRoom],
      pillars: [],
      dependencies: [],
    };

    const projEval = deriveProjectStatus(project);
    assert.strictEqual(projEval.summary.verified, 1);
    assert.strictEqual(projEval.summary.blocked, 1);
    assert.strictEqual(projEval.summary.planned, 1);
    assert.strictEqual(projEval.summary.implemented, 0);
    assert.strictEqual(projEval.summary.unknown, 0);
  });
});
