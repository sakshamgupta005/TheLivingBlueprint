import type {
  WalkthroughEvaluationInput,
  WalkthroughEvaluationResult,
  WalkthroughStep,
} from './types.ts';

export const DEMO_REPO_URL = 'https://github.com/sakshamgupta005/patchboard-tasks-api';
export const DEMO_REPO_OWNER = 'sakshamgupta005';
export const DEMO_REPO_NAME = 'patchboard-tasks-api';

export function evaluateWalkthroughSteps(
  input: WalkthroughEvaluationInput
): WalkthroughEvaluationResult {
  const {
    isSampleActive,
    lastScanResult,
    selectedRoom,
    rooms,
    chatMessages,
    findingsByRoomId,
    fixLifecyclesByRoomId,
    isAiConfigured = true,
  } = input;

  // 1. Scan public Patchboard Tasks API
  const isRealRepoScanned = Boolean(
    !isSampleActive &&
      lastScanResult &&
      lastScanResult.success &&
      lastScanResult.owner &&
      lastScanResult.repo
  );
  const isDemoRepoScanned = Boolean(
    isRealRepoScanned &&
      lastScanResult?.owner?.toLowerCase() === DEMO_REPO_OWNER.toLowerCase() &&
      lastScanResult?.repo?.toLowerCase() === DEMO_REPO_NAME.toLowerCase()
  );

  let step1Note = 'Awaiting real repository scan';
  if (isDemoRepoScanned) {
    step1Note = `Scanned ${DEMO_REPO_OWNER}/${DEMO_REPO_NAME} (@${lastScanResult?.commitSha?.slice(0, 7) || 'latest'})`;
  } else if (isRealRepoScanned) {
    step1Note = `Scanned ${lastScanResult?.owner}/${lastScanResult?.repo} (@${lastScanResult?.commitSha?.slice(0, 7) || 'latest'})`;
  } else if (isSampleActive) {
    step1Note = 'Currently on fallback BookNook sample data';
  }

  const step1: WalkthroughStep = {
    id: 'scan-repo',
    number: 1,
    title: 'Scan Patchboard Tasks API',
    description: 'Scan the public repository (https://github.com/sakshamgupta005/patchboard-tasks-api) using GitHub REST API.',
    isComplete: isRealRepoScanned,
    statusNote: step1Note,
    actionLabel: !isRealRepoScanned ? 'Prefill demo URL' : undefined,
    actionId: !isRealRepoScanned ? 'prefill_demo' : undefined,
  };

  // 2. Explore dynamically derived rooms
  const isRoomExplored = Boolean(!isSampleActive && selectedRoom && selectedRoom.id);
  const step2: WalkthroughStep = {
    id: 'explore-rooms',
    number: 2,
    title: 'Explore dynamically derived rooms',
    description: 'Click on rooms in the isometric house to inspect domain boundaries, associated files, and dependencies.',
    isComplete: isRoomExplored,
    statusNote: isRoomExplored
      ? `Selected room: "${selectedRoom?.name}" (${selectedRoom?.layer} layer)`
      : 'Click any room in the architecture canvas',
    actionLabel: !isRoomExplored && isRealRepoScanned ? 'Select a room' : undefined,
    actionId: !isRoomExplored && isRealRepoScanned ? 'select_room' : undefined,
  };

  // 3. Open failing testing or validation evidence
  const isFailingSelected = Boolean(
    !isSampleActive &&
      selectedRoom &&
      (selectedRoom.status === 'blocked' ||
        selectedRoom.metrics?.ciStatus === 'failing' ||
        selectedRoom.id.toLowerCase().includes('validation') ||
        selectedRoom.id.toLowerCase().includes('test'))
  );
  const blockedRoomExists = rooms.some(
    (r) => r.status === 'blocked' || r.metrics?.ciStatus === 'failing'
  );

  const step3: WalkthroughStep = {
    id: 'open-failing-evidence',
    number: 3,
    title: 'Open failing testing or validation evidence',
    description: 'Inspect the room with blocker evidence (e.g. failing CI test run on whitespace title validation).',
    isComplete: isFailingSelected,
    statusNote: isFailingSelected
      ? `Inspecting "${selectedRoom?.name}" — Status: ${selectedRoom?.status.toUpperCase()}${
          selectedRoom?.metrics?.ciCheckName ? ` (${selectedRoom.metrics.ciCheckName}: failing)` : ''
        }`
      : blockedRoomExists
      ? 'A failing/blocked room is waiting to be inspected'
      : 'No failing room active in current view',
    actionLabel: !isFailingSelected && blockedRoomExists ? 'Focus blocked room' : undefined,
    actionId: !isFailingSelected && blockedRoomExists ? 'focus_blocked_room' : undefined,
  };

  // 4. Ask Barkley and Cleo about selected room
  const userMessages = chatMessages.filter((m) => m.sender === 'user');
  const isChatAsked = userMessages.length > 0;
  const companionReplies = chatMessages.filter((m) => m.sender === 'dog' || m.sender === 'cat');

  let step4Note = 'No user queries asked yet';
  if (isChatAsked) {
    step4Note = `${userMessages.length} question(s) asked · ${companionReplies.length} companion response(s)`;
  } else if (!isAiConfigured) {
    step4Note = 'Requires GEMINI_API_KEY in server environment';
  }

  const step4: WalkthroughStep = {
    id: 'ask-companions',
    number: 4,
    title: 'Ask Barkley and Cleo about selected room',
    description: 'Send a question in the chat panel to see grounded Barkley (dog) and Cleo (cat) responses.',
    isComplete: isChatAsked,
    statusNote: step4Note,
    actionLabel: !isChatAsked ? 'Ask about this room' : undefined,
    actionId: !isChatAsked ? 'ask_chat' : undefined,
  };

  // 5. Investigate issue and generate repair prompt
  const activeRoomFinding = selectedRoom ? findingsByRoomId[selectedRoom.id] : undefined;
  const anyFindingWithPrompt = Object.values(findingsByRoomId).find(
    (f) => Boolean(f?.generatedPrompt)
  );
  const isInvestigated = Boolean(activeRoomFinding?.generatedPrompt || anyFindingWithPrompt);

  let step5Note = 'Room not yet investigated';
  if (isInvestigated) {
    const findingToCite = activeRoomFinding || anyFindingWithPrompt;
    step5Note = `Generated repair prompt: "${findingToCite?.title.slice(0, 36)}..." (${findingToCite?.evidenceClassification.toUpperCase()})`;
  } else if (!isAiConfigured) {
    step5Note = 'Requires GEMINI_API_KEY for live investigation';
  }

  const step5: WalkthroughStep = {
    id: 'investigate-issue',
    number: 5,
    title: 'Investigate issue & generate repair prompt',
    description: 'Click "Investigate this room" in the inspector to run grounded diagnosis and create a prompt for a coding agent.',
    isComplete: isInvestigated,
    statusNote: step5Note,
    actionLabel: !isInvestigated && isFailingSelected ? 'Run investigation' : undefined,
    actionId: !isInvestigated && isFailingSelected ? 'investigate' : undefined,
  };

  // 6. Report fix and re-inspect verification evidence
  const activeLifecycle = selectedRoom ? fixLifecyclesByRoomId[selectedRoom.id] : undefined;
  const anyLifecycle = Object.values(fixLifecyclesByRoomId).find((l) => Boolean(l?.report));
  const isFixReported = Boolean(activeLifecycle?.report || anyLifecycle);

  let step6Note = 'Fix not yet reported';
  if (isFixReported) {
    const life = activeLifecycle || anyLifecycle;
    step6Note = `Fix reported: "${life?.report?.summary.slice(0, 32)}..." · Verification: ${
      life?.resultingStatusEvaluation?.status.toUpperCase() || 'pending'
    }`;
  }

  const step6: WalkthroughStep = {
    id: 'report-fix',
    number: 6,
    title: 'Report repair & inspect verification evidence',
    description: 'Use "Report fix & re-inspect repository" to submit claimed fixes and verify against GitHub check runs.',
    isComplete: isFixReported,
    statusNote: step6Note,
    actionLabel: !isFixReported && isInvestigated ? 'Open fix reporter' : undefined,
    actionId: !isFixReported && isInvestigated ? 'open_fix_report' : undefined,
  };

  const steps = [step1, step2, step3, step4, step5, step6];
  const completedCount = steps.filter((s) => s.isComplete).length;
  const isAllCompleted = completedCount === steps.length;
  const nextStepIndex = steps.findIndex((s) => !s.isComplete);

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    isAllCompleted,
    nextStepIndex: nextStepIndex !== -1 ? nextStepIndex : steps.length - 1,
  };
}
