/**
 * Deterministic Status Engine for The Living Blueprint
 * Pure TypeScript functions, strictly decoupled from React / UI.
 */

import type {
  EvidenceRecord,
  Project,
  ProjectStatusEvaluation,
  Requirement,
  RequirementEvaluation,
  RoomModule,
  RoomStatus,
  RoomStatusEvaluation,
} from './types.ts';

/**
 * Checks whether an evidence record targets a specific requirement.
 */
export function isEvidenceRelevantToRequirement(
  evidence: EvidenceRecord,
  requirementId: string
): boolean {
  if (evidence.targetRequirementId === requirementId) {
    return true;
  }
  if (evidence.targetRequirementIds && evidence.targetRequirementIds.includes(requirementId)) {
    return true;
  }
  return false;
}

/**
 * Deterministically evaluates the status of an individual requirement based on evidence history.
 */
export function evaluateRequirement(
  requirement: Requirement,
  evidenceHistory: EvidenceRecord[]
): RequirementEvaluation {
  const relevant = evidenceHistory.filter((e) =>
    isEvidenceRelevantToRequirement(e, requirement.id)
  );
  const active = relevant.filter((e) => !e.isSuperseded);
  const superseded = relevant.filter((e) => !!e.isSuperseded);

  // 1. Contradictory Evidence Check:
  // Active evidence contains conflicting pass and fail results that have not been superseded
  const activePassed = active.filter(
    (e) => e.verificationResult && e.verificationResult.status === 'passed'
  );
  const activeFailed = active.filter(
    (e) => (e.verificationResult && e.verificationResult.status === 'failed') || e.isBlocker
  );

  if (activePassed.length > 0 && activeFailed.length > 0) {
    return {
      requirementId: requirement.id,
      status: 'unknown',
      reason: 'Contradictory active evidence: both passing and failing/blocking results are active without supersession.',
      activeEvidenceCount: active.length,
      supersededEvidenceCount: superseded.length,
    };
  }

  const activeInconclusive = active.filter(
    (e) => e.verificationResult && e.verificationResult.status === 'inconclusive'
  );
  if (activeInconclusive.length > 0 && activePassed.length === 0) {
    return {
      requirementId: requirement.id,
      status: 'unknown',
      reason: 'Inconclusive active verification result.',
      activeEvidenceCount: active.length,
      supersededEvidenceCount: superseded.length,
    };
  }

  // 2. Blocked Check:
  // Active evidence shows an unresolved blocker or failing verification
  if (activeFailed.length > 0) {
    const failureDescriptions = activeFailed.map((e) => e.description).join('; ');
    return {
      requirementId: requirement.id,
      status: 'blocked',
      reason: `Active blocker or failing verification: ${failureDescriptions}`,
      activeEvidenceCount: active.length,
      supersededEvidenceCount: superseded.length,
    };
  }

  // 3. Verified Check:
  // Requires relevant, active verification evidence from test, configuration, or user confirmation.
  // Rule: AI inference alone and unsupported completion claims must NEVER produce verified.
  const validNonAiVerifications = active.filter(
    (e) =>
      e.sourceType !== 'ai_inference' &&
      e.verificationResult &&
      e.verificationResult.status === 'passed'
  );

  if (validNonAiVerifications.length > 0) {
    return {
      requirementId: requirement.id,
      status: 'verified',
      reason: `Verified by ${validNonAiVerifications.length} active verification evidence record(s).`,
      activeEvidenceCount: active.length,
      supersededEvidenceCount: superseded.length,
    };
  }

  // Check if AI inference alone claims verification
  const aiVerifications = active.filter(
    (e) =>
      e.sourceType === 'ai_inference' &&
      e.verificationResult &&
      e.verificationResult.status === 'passed'
  );

  // 4. Implemented Check:
  // Relevant implementation evidence exists (source code, config), but successful verification is not established.
  const implementationEvidence = active.filter(
    (e) => e.sourceType === 'source_code' || e.sourceType === 'configuration'
  );

  if (implementationEvidence.length > 0) {
    const aiNote =
      aiVerifications.length > 0
        ? ' (AI claims complete, but AI inference alone cannot establish verified status)'
        : '';
    return {
      requirementId: requirement.id,
      status: 'implemented',
      reason: `Implementation evidence exists in source/config, but verification is not established${aiNote}.`,
      activeEvidenceCount: active.length,
      supersededEvidenceCount: superseded.length,
    };
  }

  // If ONLY AI claims exist without implementation or tests
  if (aiVerifications.length > 0) {
    return {
      requirementId: requirement.id,
      status: 'unknown',
      reason: 'Unsupported AI completion claim with no underlying implementation or test evidence.',
      activeEvidenceCount: active.length,
      supersededEvidenceCount: superseded.length,
    };
  }

  // 5. Planned Check:
  // No sufficient evidence of implementation
  return {
    requirementId: requirement.id,
    status: 'planned',
    reason: 'No sufficient evidence of implementation found.',
    activeEvidenceCount: active.length,
    supersededEvidenceCount: superseded.length,
  };
}

/**
 * Deterministically evaluates the overall status of a room module from its requirements and evidence history.
 */
export function deriveRoomStatus(room: RoomModule): RoomStatusEvaluation {
  const totalEvidenceCount = room.evidenceHistory.length;
  const activeEvidenceCount = room.evidenceHistory.filter((e) => !e.isSuperseded).length;
  const supersededEvidenceCount = room.evidenceHistory.filter((e) => !!e.isSuperseded).length;

  // Case A: Room has defined requirements
  if (room.requirements.length > 0) {
    const reqEvals = room.requirements.map((req) =>
      evaluateRequirement(req, room.evidenceHistory)
    );

    // Rule: any blocked requirement blocks the room
    const blockedReq = reqEvals.find((r) => r.status === 'blocked');
    if (blockedReq) {
      return {
        roomId: room.id,
        status: 'blocked',
        reason: `Room blocked: Requirement '${blockedReq.requirementId}' is blocked (${blockedReq.reason}).`,
        requirementEvaluations: reqEvals,
        totalEvidenceCount,
        activeEvidenceCount,
        supersededEvidenceCount,
      };
    }

    // Rule: any unknown requirement makes overall room status unknown
    const unknownReq = reqEvals.find((r) => r.status === 'unknown');
    if (unknownReq) {
      return {
        roomId: room.id,
        status: 'unknown',
        reason: `Room status unknown: Requirement '${unknownReq.requirementId}' has contradictory or insufficient evidence.`,
        requirementEvaluations: reqEvals,
        totalEvidenceCount,
        activeEvidenceCount,
        supersededEvidenceCount,
      };
    }

    // Rule: all requirements verified -> room is verified
    const allVerified = reqEvals.every((r) => r.status === 'verified');
    if (allVerified) {
      return {
        roomId: room.id,
        status: 'verified',
        reason: `All ${room.requirements.length} requirement(s) verified by active evidence.`,
        requirementEvaluations: reqEvals,
        totalEvidenceCount,
        activeEvidenceCount,
        supersededEvidenceCount,
      };
    }

    // Rule: all requirements planned -> room is planned
    const allPlanned = reqEvals.every((r) => r.status === 'planned');
    if (allPlanned) {
      return {
        roomId: room.id,
        status: 'planned',
        reason: `All ${room.requirements.length} requirement(s) are planned with no implementation.`,
        requirementEvaluations: reqEvals,
        totalEvidenceCount,
        activeEvidenceCount,
        supersededEvidenceCount,
      };
    }

    // Otherwise, partially implemented or partially verified without full verification
    return {
      roomId: room.id,
      status: 'implemented',
      reason: `Requirements are partially implemented (${reqEvals.filter((r) => r.status === 'verified').length}/${room.requirements.length} verified, verification incomplete).`,
      requirementEvaluations: reqEvals,
      totalEvidenceCount,
      activeEvidenceCount,
      supersededEvidenceCount,
    };
  }

  // Case B: Room has no granular requirements (module-level evaluation)
  const active = room.evidenceHistory.filter((e) => !e.isSuperseded);
  const activePassed = active.filter(
    (e) => e.verificationResult && e.verificationResult.status === 'passed'
  );
  const activeFailed = active.filter(
    (e) => (e.verificationResult && e.verificationResult.status === 'failed') || e.isBlocker
  );

  if (activePassed.length > 0 && activeFailed.length > 0) {
    return {
      roomId: room.id,
      status: 'unknown',
      reason: 'Contradictory room-level evidence without supersession.',
      requirementEvaluations: [],
      totalEvidenceCount,
      activeEvidenceCount,
      supersededEvidenceCount,
    };
  }

  if (activeFailed.length > 0) {
    return {
      roomId: room.id,
      status: 'blocked',
      reason: 'Active room-level blocker or failing verification.',
      requirementEvaluations: [],
      totalEvidenceCount,
      activeEvidenceCount,
      supersededEvidenceCount,
    };
  }

  const nonAiVerifications = active.filter(
    (e) =>
      e.sourceType !== 'ai_inference' &&
      e.verificationResult &&
      e.verificationResult.status === 'passed'
  );

  if (nonAiVerifications.length > 0) {
    return {
      roomId: room.id,
      status: 'verified',
      reason: 'Verified by room-level passing verification.',
      requirementEvaluations: [],
      totalEvidenceCount,
      activeEvidenceCount,
      supersededEvidenceCount,
    };
  }

  const hasImplementation = active.some(
    (e) => e.sourceType === 'source_code' || e.sourceType === 'configuration'
  );
  if (hasImplementation) {
    return {
      roomId: room.id,
      status: 'implemented',
      reason: 'Room has implementation code/configuration, but verification is pending.',
      requirementEvaluations: [],
      totalEvidenceCount,
      activeEvidenceCount,
      supersededEvidenceCount,
    };
  }

  return {
    roomId: room.id,
    status: 'planned',
    reason: 'No implementation evidence exists for this room.',
    requirementEvaluations: [],
    totalEvidenceCount,
    activeEvidenceCount,
    supersededEvidenceCount,
  };
}

/**
 * Evaluates the status of an entire project across all rooms.
 */
export function deriveProjectStatus(project: Project): ProjectStatusEvaluation {
  const roomEvaluations = project.rooms.map((room) => deriveRoomStatus(room));
  const summary: Record<RoomStatus, number> = {
    planned: 0,
    implemented: 0,
    verified: 0,
    blocked: 0,
    unknown: 0,
  };

  for (const r of roomEvaluations) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }

  return {
    projectId: project.id,
    rooms: roomEvaluations,
    summary,
  };
}

/**
 * Appends a new evidence record and marks an older record as superseded if specified.
 * Preserves the complete historical audit log without ever deleting older records.
 */
export function addEvidenceRecord(
  room: RoomModule,
  newEvidence: EvidenceRecord,
  supersedesEvidenceId?: string
): RoomModule {
  const updatedHistory = room.evidenceHistory.map((rec) => {
    if (supersedesEvidenceId && rec.id === supersedesEvidenceId) {
      return {
        ...rec,
        isSuperseded: true,
        supersededBy: newEvidence.id,
        supersededAt: newEvidence.timestamp,
      };
    }
    return rec;
  });

  updatedHistory.push(newEvidence);

  return {
    ...room,
    evidenceHistory: updatedHistory,
  };
}
