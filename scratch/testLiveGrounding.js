import { scanGitHubRepository } from '../src/domain/github/scanner.ts';
import { mapScanResultToHouse } from '../src/domain/github/architectureMapper.ts';

async function main() {
  console.log('--- 1. Scanning Live GitHub Repository ---');
  const scanResult = await scanGitHubRepository('https://github.com/sakshamgupta005/patchboard-tasks-api');
  console.log('Scan Success:', scanResult.success);
  console.log('Scanned Commit SHA:', scanResult.commitSha);
  console.log('Inspected Files Count:', scanResult.inspectedFiles.length);
  console.log('Discovered Files Count:', scanResult.totalFilesDiscovered);
  console.log('CI Check Runs:', scanResult.checkRuns?.length);
  console.log('CI Outcome:', scanResult.ciEvaluation?.outcome);

  const { rooms } = mapScanResultToHouse(scanResult);
  const validationRoom = rooms.find((r) => r.id === 'room-validation') || rooms[0];
  console.log('Target Room:', validationRoom.name, `(${validationRoom.id})`);
  console.log('Room File Paths:', validationRoom.filePaths);

  console.log('\n--- 2. Testing Real /api/chat ---');
  const chatPayload = {
    message: 'Does this repository correctly reject task titles containing only whitespace? Explain what the code proves and cite the relevant source and test files.',
    selectedRoomId: validationRoom.id,
    repoContext: {
      owner: scanResult.owner,
      repo: scanResult.repo,
      branch: scanResult.metadata?.defaultBranch || 'main',
      commitSha: scanResult.commitSha,
      totalFiles: scanResult.totalFilesDiscovered,
      inspectedFiles: scanResult.inspectedFiles.map((f) => ({
        path: f.path,
        category: f.category,
        contentExcerpt: f.contentExcerpt,
        sizeBytes: f.sizeBytes,
      })),
      discoveredFilePaths: scanResult.discoveredFilePaths,
      detectedTechnologies: scanResult.detectedTechnologies,
      roomSummaries: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        layer: r.layer,
        status: r.status,
        evidence: r.evidence,
        filePaths: r.filePaths,
        ciStatus: r.metrics?.ciStatus,
        ciCheckName: r.metrics?.ciCheckName,
      })),
      ciEvaluation: scanResult.ciEvaluation
        ? {
            status: scanResult.ciEvaluation.outcome === 'failed' ? 'failing' : 'passing',
            isVerified: scanResult.ciEvaluation.outcome === 'verified',
            reason: scanResult.ciEvaluation.outcomeReason,
            checkRunsCount: scanResult.ciEvaluation.relevantTestChecks.length,
            failedChecks: scanResult.ciEvaluation.relevantTestChecks
              .filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out')
              .map((c) => c.name),
          }
        : undefined,
    },
  };

  const chatRes = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chatPayload),
  });

  const chatData = await chatRes.json();
  console.log('Chat Status HTTP:', chatRes.status);
  console.log('Chat Response:', JSON.stringify(chatData, null, 2));

  console.log('\n--- 3. Testing Real /api/investigate ---');
  const investigatePayload = {
    roomId: validationRoom.id,
    roomName: validationRoom.name,
    roomLayer: validationRoom.layer,
    roomStatus: validationRoom.status,
    roomEvidence: validationRoom.evidence,
    roomFilePaths: validationRoom.filePaths,
    repoContext: {
      owner: scanResult.owner,
      repo: scanResult.repo,
      branch: scanResult.metadata?.defaultBranch || 'main',
      commitSha: scanResult.commitSha,
      inspectedFiles: scanResult.inspectedFiles.map((f) => ({
        path: f.path,
        category: f.category,
        contentExcerpt: f.contentExcerpt,
        sizeBytes: f.sizeBytes,
      })),
      discoveredFilePaths: scanResult.discoveredFilePaths,
      detectedTechnologies: scanResult.detectedTechnologies,
      dependencies: validationRoom.dependencies,
      ciEvaluation: scanResult.ciEvaluation
        ? {
            status: scanResult.ciEvaluation.outcome === 'failed' ? 'failing' : 'passing',
            isVerified: scanResult.ciEvaluation.outcome === 'verified',
            reason: scanResult.ciEvaluation.outcomeReason,
            checkRunsCount: scanResult.ciEvaluation.relevantTestChecks.length,
            failedChecks: scanResult.ciEvaluation.relevantTestChecks
              .filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out')
              .map((c) => c.name),
          }
        : undefined,
    },
  };

  const invRes = await fetch('http://localhost:3000/api/investigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(investigatePayload),
  });

  const invData = await invRes.json();
  console.log('Investigation Status HTTP:', invRes.status);
  console.log('Investigation Finding:', JSON.stringify(invData, null, 2));
}

main().catch((err) => {
  console.error('Test script failed:', err);
  process.exit(1);
});
