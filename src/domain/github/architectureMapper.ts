import { deriveRoomStatus } from '../statusEngine.ts';
import type {
  DependencyConnection,
  EvidenceRecord,
  InfrastructurePillar,
  Project,
  Requirement,
  RoomModule,
} from '../types.ts';
import type { ArchitecturalRoom } from '../../types.ts';
import type { GitHubScanResult, InspectedFile } from './types.ts';
import { evaluateCheckRunsForVerification } from '../lifecycle/ciEvaluator.ts';

/**
 * Calculates non-overlapping, harmonious isometric 3D coordinates for N rooms
 * on the house foundation platform (width 380, depth 300).
 */
export function calculateRoomCoordinates(count: number): Array<{
  isoX: number;
  isoY: number;
  width: number;
  height: number;
  depth: number;
}> {
  if (count <= 1) {
    return [{ isoX: -140, isoY: -110, width: 280, height: 80, depth: 220 }];
  }
  if (count === 2) {
    return [
      { isoX: -160, isoY: -130, width: 320, height: 80, depth: 110 },
      { isoX: -160, isoY: 10, width: 320, height: 80, depth: 110 },
    ];
  }
  if (count === 3) {
    return [
      { isoX: -170, isoY: -130, width: 160, height: 80, depth: 120 },
      { isoX: 10, isoY: -130, width: 160, height: 80, depth: 120 },
      { isoX: -80, isoY: 10, width: 160, height: 80, depth: 120 },
    ];
  }
  if (count === 4) {
    return [
      { isoX: -170, isoY: -130, width: 160, height: 80, depth: 120 },
      { isoX: 10, isoY: -130, width: 160, height: 80, depth: 120 },
      { isoX: -170, isoY: 10, width: 160, height: 80, depth: 120 },
      { isoX: 10, isoY: 10, width: 160, height: 80, depth: 120 },
    ];
  }
  if (count === 5) {
    return [
      { isoX: -175, isoY: -130, width: 105, height: 80, depth: 120 },
      { isoX: -55, isoY: -130, width: 105, height: 80, depth: 120 },
      { isoX: 65, isoY: -130, width: 105, height: 80, depth: 120 },
      { isoX: -170, isoY: 10, width: 160, height: 80, depth: 120 },
      { isoX: 10, isoY: 10, width: 160, height: 80, depth: 120 },
    ];
  }
  // 6 or more rooms (3x2 grid)
  return [
    { isoX: -175, isoY: -130, width: 105, height: 80, depth: 120 },
    { isoX: -55, isoY: -130, width: 105, height: 80, depth: 120 },
    { isoX: 65, isoY: -130, width: 105, height: 80, depth: 120 },
    { isoX: -175, isoY: 10, width: 105, height: 80, depth: 120 },
    { isoX: -55, isoY: 10, width: 105, height: 80, depth: 120 },
    { isoX: 65, isoY: 10, width: 105, height: 80, depth: 120 },
  ];
}

/**
 * Dynamically maps a scanned GitHub repository to the Living Blueprint domain model.
 * Infers architecture modules, dependencies, and infrastructure strictly from observed files.
 */
export function mapScanResultToHouse(scan: GitHubScanResult): {
  project: Project;
  rooms: ArchitecturalRoom[];
  pillars: InfrastructurePillar[];
} {
  const repoName = scan.metadata?.name || scan.repo || 'Repository';
  const timestamp = new Date().toISOString();
  const inspectedFiles = scan.inspectedFiles || [];
  const allPaths = scan.discoveredFilePaths || inspectedFiles.map((f) => f.path);

  // 1. Identify File Functional Clusters
  const testFiles = inspectedFiles.filter(
    (f) =>
      f.category === 'test' ||
      /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[a-z0-9]+$/i.test(f.path)
  );

  const hasRelevantTestChecks = Boolean(
    scan.checkRuns?.some(
      (c) =>
        c.isRelevantTestCheck &&
        (!c.commitSha || !scan.commitSha || c.commitSha === scan.commitSha)
    )
  );

  const hasTestFiles =
    testFiles.length > 0 ||
    allPaths.some((p) => /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[a-z0-9]+$/i.test(p));

  const hasTestsOrCi = hasTestFiles || hasRelevantTestChecks;

  const serverFiles = inspectedFiles.filter(
    (f) =>
      !testFiles.includes(f) &&
      (/(?:server|app|index|main)\.(?:js|ts|mjs|cjs|go|py)$/i.test(f.path) ||
        /(?:^|\/)(?:api|routes|controllers|endpoints|server)\//i.test(f.path))
  );

  const validationFiles = inspectedFiles.filter(
    (f) =>
      !testFiles.includes(f) &&
      !serverFiles.includes(f) &&
      (/(?:validation|validators?|rules?|schemas?)\.(?:js|ts|mjs|cjs|py)$/i.test(f.path) ||
        /(?:^|\/)(?:validation|validators|schemas)\//i.test(f.path))
  );

  const authFiles = inspectedFiles.filter(
    (f) =>
      !testFiles.includes(f) &&
      (/(?:auth|login|session|jwt|token|credential|permission)\.(?:js|ts|mjs|cjs|py)$/i.test(f.path) ||
        /(?:^|\/)(?:auth|session|security)\//i.test(f.path))
  );

  const dbFiles = inspectedFiles.filter(
    (f) =>
      !testFiles.includes(f) &&
      /(?:schema\.prisma|migrations?\/|typeorm|alembic\/|prisma\/|(?:database|db|models?|repository)\.(?:js|ts|mjs|cjs|py|go|rs|sqlite|sql)|database\.sqlite|store\.sqlite)/i.test(f.path)
  );

  const uiFiles = inspectedFiles.filter(
    (f) =>
      !testFiles.includes(f) &&
      !serverFiles.includes(f) &&
      (/(?:^|\/)(?:components|views|pages|templates)\//i.test(f.path) ||
        /\.(?:tsx|jsx|vue|svelte)$/i.test(f.path))
  );

  const classified = new Set<string>([
    ...testFiles.map((f) => f.path),
    ...serverFiles.map((f) => f.path),
    ...validationFiles.map((f) => f.path),
    ...authFiles.map((f) => f.path),
    ...dbFiles.map((f) => f.path),
    ...uiFiles.map((f) => f.path),
  ]);

  const remainingSource = inspectedFiles.filter(
    (f) =>
      (f.category === 'source' || f.category === 'manifest' || f.category === 'readme') &&
      !classified.has(f.path)
  );

  // Non-domain directory identifiers that should not be converted into business domain rooms
  const NON_DOMAIN_FOLDERS = new Set(['src', 'lib', 'app', 'config', 'configs', 'generated', 'gen', 'docs', 'examples', 'dist', 'build', 'core']);

  // Group remaining source files by domain folder (e.g. src/tasks/... -> 'tasks', packages/shared/... -> 'shared')
  const domainFolders = new Map<string, InspectedFile[]>();
  for (const f of remainingSource) {
    if (f.category === 'manifest' || f.category === 'readme' || f.category === 'documentation') continue;
    const monorepoMatch = f.path.match(/(?:packages|apps|services|modules)\/([a-zA-Z0-9_-]+)\/src\/([a-zA-Z0-9_-]+)\//i);
    const monorepoPkgMatch = f.path.match(/(?:packages|apps|services|modules)\/([a-zA-Z0-9_-]+)\//i);
    const srcSubMatch = f.path.match(/(?:src|lib|app)\/([a-zA-Z0-9_-]+)\//i);
    const topMatch = f.path.match(/^([a-zA-Z0-9_-]+)\//i);

    let folder = 'core';
    if (monorepoMatch && !NON_DOMAIN_FOLDERS.has(monorepoMatch[2].toLowerCase())) {
      folder = monorepoMatch[2].toLowerCase();
    } else if (monorepoPkgMatch && !NON_DOMAIN_FOLDERS.has(monorepoPkgMatch[1].toLowerCase())) {
      folder = monorepoPkgMatch[1].toLowerCase();
    } else if (srcSubMatch && !NON_DOMAIN_FOLDERS.has(srcSubMatch[1].toLowerCase())) {
      folder = srcSubMatch[1].toLowerCase();
    } else if (topMatch && !NON_DOMAIN_FOLDERS.has(topMatch[1].toLowerCase())) {
      folder = topMatch[1].toLowerCase();
    }

    if (folder !== 'core') {
      const list = domainFolders.get(folder) || [];
      list.push(f);
      domainFolders.set(folder, list);
    }
  }

  // 2. Build Modules and Module File Mappings
  const modules: RoomModule[] = [];
  const moduleFileMap = new Map<string, InspectedFile[]>();

  // A. Server & Routing
  if (serverFiles.length > 0) {
    const reqs: Requirement[] = [
      { id: 'req-server-routing', title: 'HTTP Request Routing & Endpoints' },
    ];
    const ev: EvidenceRecord[] = serverFiles.map((f) => ({
      id: `ev-server-${f.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
      sourceType: 'source_code',
      description: `Discovered HTTP server and route dispatcher in ${f.path}`,
      timestamp,
      reference: f.path,
      targetRequirementId: 'req-server-routing',
    }));
    modules.push({
      id: 'room-server',
      name: 'HTTP Server & API Routing',
      description: 'HTTP server configuration, route dispatching, and request lifecycle.',
      layer: 'service',
      requirements: reqs,
      evidenceHistory: ev,
    });
    moduleFileMap.set('room-server', serverFiles);
  }

  // B. Specific Domain Subsystems (e.g. Task Domain & Storage)
  for (const [folder, files] of domainFolders.entries()) {
    const cleanId = `room-${folder}`;
    const cleanTitle =
      folder === 'tasks'
        ? 'Task Management & Store'
        : `${folder.charAt(0).toUpperCase() + folder.slice(1)} Domain & State`;
    const reqId = `req-${folder}-domain`;
    const reqs: Requirement[] = [{ id: reqId, title: `${cleanTitle} Operations` }];
    const ev: EvidenceRecord[] = files.map((f) => ({
      id: `ev-${folder}-${f.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
      sourceType: 'source_code',
      description: `Discovered domain implementation in ${f.path}`,
      timestamp,
      reference: f.path,
      targetRequirementId: reqId,
    }));
    modules.push({
      id: cleanId,
      name: cleanTitle,
      description: `${cleanTitle} business logic, data models, and operations.`,
      layer: 'core',
      requirements: reqs,
      evidenceHistory: ev,
    });
    moduleFileMap.set(cleanId, files);
  }

  // C. Input Validation & Schema
  if (validationFiles.length > 0) {
    const reqs: Requirement[] = [
      { id: 'req-validation-rules', title: 'Input Validation & Request Sanitization' },
    ];
    const ev: EvidenceRecord[] = validationFiles.map((f) => ({
      id: `ev-val-${f.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
      sourceType: 'source_code',
      description: `Discovered input validation rules in ${f.path}`,
      timestamp,
      reference: f.path,
      targetRequirementId: 'req-validation-rules',
    }));
    modules.push({
      id: 'room-validation',
      name: 'Input Validation & Schema',
      description: 'Request validation schemas, input sanitization, and data integrity constraints.',
      layer: 'core',
      requirements: reqs,
      evidenceHistory: ev,
    });
    moduleFileMap.set('room-validation', validationFiles);
  }

  // D. Authentication & Security (ONLY if authentic files exist)
  if (authFiles.length > 0) {
    const reqs: Requirement[] = [
      { id: 'req-auth-access', title: 'Access Control & Authentication' },
    ];
    const ev: EvidenceRecord[] = authFiles.map((f) => ({
      id: `ev-auth-${f.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
      sourceType: 'source_code',
      description: `Discovered authentication logic in ${f.path}`,
      timestamp,
      reference: f.path,
      targetRequirementId: 'req-auth-access',
    }));
    modules.push({
      id: 'room-auth',
      name: 'Authentication & Access Control',
      description: 'User authentication, session tokens, and access control.',
      layer: 'service',
      requirements: reqs,
      evidenceHistory: ev,
    });
    moduleFileMap.set('room-auth', authFiles);
  }

  // E. UI Presentation Layer (ONLY if UI components exist)
  if (uiFiles.length > 0) {
    const reqs: Requirement[] = [
      { id: 'req-ui-views', title: 'UI Component Rendering & Views' },
    ];
    const ev: EvidenceRecord[] = uiFiles.map((f) => ({
      id: `ev-ui-${f.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
      sourceType: 'source_code',
      description: `Discovered UI presentation component in ${f.path}`,
      timestamp,
      reference: f.path,
      targetRequirementId: 'req-ui-views',
    }));
    modules.push({
      id: 'room-ui',
      name: 'UI Components & Views',
      description: 'User interface components, presentation templates, and view rendering.',
      layer: 'service',
      requirements: reqs,
      evidenceHistory: ev,
    });
    moduleFileMap.set('room-ui', uiFiles);
  }

  // F. Database / Persistence Layer (ONLY if db files exist)
  if (dbFiles.length > 0) {
    const reqs: Requirement[] = [
      { id: 'req-db-schema', title: 'Database Schema & Persistence' },
    ];
    const ev: EvidenceRecord[] = dbFiles.map((f) => ({
      id: `ev-db-${f.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
      sourceType: 'source_code',
      description: `Discovered database configuration/schema in ${f.path}`,
      timestamp,
      reference: f.path,
      targetRequirementId: 'req-db-schema',
    }));
    modules.push({
      id: 'room-database',
      name: 'Data Persistence & Storage',
      description: 'Database models, connection pooling, and persistence migrations.',
      layer: 'foundation',
      requirements: reqs,
      evidenceHistory: ev,
    });
    moduleFileMap.set('room-database', dbFiles);
  }

  // G. Automated Tests & Quality (ONLY if test files or CI runs exist)
  if (hasTestsOrCi) {
    const reqs: Requirement[] = [
      { id: 'req-gw-ci', title: 'Automated Test Verification & CI Runs' },
    ];
    const ev: EvidenceRecord[] = [];
    if (testFiles.length > 0) {
      for (const tf of testFiles) {
        ev.push({
          id: `ev-test-file-${tf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
          sourceType: 'source_code',
          description: `Test suite file detected at ${tf.path}. Automated test execution has not been verified.`,
          timestamp,
          reference: tf.path,
          targetRequirementId: 'req-gw-ci',
        });
      }
    } else {
      const discoveredTests = allPaths.filter((p) => /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[a-z0-9]+$/i.test(p));
      ev.push({
        id: 'ev-test-files-uninspected',
        sourceType: 'source_code',
        description: `Test suite files discovered in tree (${discoveredTests.slice(0, 3).join(', ')}), but content was not inspected within scan budget. Automated test execution has not been verified.`,
        timestamp,
        reference: discoveredTests[0] || 'tests',
        targetRequirementId: 'req-gw-ci',
      });
    }

    // Real CI Verification Evidence from Scanned Commit Check Runs
    if (scan.checkRuns && scan.checkRuns.length > 0) {
      const evalResult =
        scan.ciEvaluation ||
        evaluateCheckRunsForVerification(
          scan.checkRuns,
          'req-gw-ci',
          scan.commitSha || 'unknown',
          timestamp
        );

      if (evalResult.verificationEvidenceRecords.length > 0) {
        ev.push(...evalResult.verificationEvidenceRecords);
      }
    }

    modules.push({
      id: 'room-tests',
      name: 'Automated Tests & Quality',
      description: 'Unit, integration, and CI regression suites.',
      layer: 'gateway',
      requirements: reqs,
      evidenceHistory: ev,
    });
    moduleFileMap.set('room-tests', testFiles);
  }

  // H. Fallback if no specific modules were detected
  if (modules.length === 0) {
    const reqs: Requirement[] = [
      { id: 'req-unspecified', title: 'Core Repository Structure' },
    ];
    const ev: EvidenceRecord[] = [];
    const src = inspectedFiles[0];
    if (src) {
      ev.push({
        id: `ev-src-${src.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        sourceType: 'source_code',
        description: `Discovered repository entry in ${src.path}`,
        timestamp,
        reference: src.path,
        targetRequirementId: 'req-unspecified',
      });
    }
    modules.push({
      id: 'room-core',
      name: 'Application Core',
      description: 'Core source code and application structure.',
      layer: 'core',
      requirements: reqs,
      evidenceHistory: ev,
    });
    moduleFileMap.set('room-core', src ? [src] : []);
  }

  // 3. Derive Evidence-Backed Inter-Module Dependencies
  const dependencies: DependencyConnection[] = [];
  for (const [modId, files] of moduleFileMap.entries()) {
    for (const f of files) {
      const excerpt = (f.contentExcerpt || '').toLowerCase();
      for (const [otherModId, otherFiles] of moduleFileMap.entries()) {
        if (modId === otherModId) continue;
        const targetFolder = otherModId.replace('room-', '');
        const referencesOther = otherFiles.some(
          (of) => excerpt.includes(of.path.toLowerCase()) || excerpt.includes(targetFolder)
        );
        if (referencesOther) {
          const depId = `dep-${modId}-${otherModId}`;
          if (!dependencies.some((d) => d.id === depId)) {
            dependencies.push({
              id: depId,
              sourceRoomId: modId,
              targetRoomId: otherModId,
              type: modId === 'room-tests' ? 'imports' : 'calls',
              status: 'verified',
            });
          }
        }
      }
    }
  }

  // 4. Derive Coords and Evaluate Rooms Deterministically
  const coordsList = calculateRoomCoordinates(modules.length);

  const architecturalRooms: ArchitecturalRoom[] = modules.map((mod, idx) => {
    const evaluation = deriveRoomStatus(mod);
    const activeFiles = mod.evidenceHistory.filter((e) => !e.isSuperseded);
    const evidenceSummary =
      activeFiles.length > 0
        ? activeFiles.map((e) => e.description).join('; ')
        : mod.requirements.length > 0 && mod.evidenceHistory.length === 0
        ? 'Planned: No implementation files discovered in scanned representative tree.'
        : evaluation.reason;

    const modFiles = moduleFileMap.get(mod.id) || [];
    const isTestRoom = mod.id === 'room-tests' || mod.layer === 'gateway';

    let ciStatus: 'passing' | 'failing' | 'pending' | 'unavailable' | 'not_run' | undefined;
    let ciCheckName: string | undefined;
    let ciUrl: string | undefined;

    if (isTestRoom) {
      if (scan.checkRuns && scan.checkRuns.length > 0) {
        const matchingCommitChecks = scan.checkRuns.filter(
          (c) => !c.commitSha || !scan.commitSha || c.commitSha === scan.commitSha
        );
        const relevant = matchingCommitChecks.filter((c) => c.isRelevantTestCheck);
        if (relevant.length > 0) {
          const failed = relevant.find(
            (c) =>
              c.status === 'completed' &&
              (c.conclusion === 'failure' || c.conclusion === 'timed_out')
          );
          const pending = relevant.find(
            (c) => c.status === 'queued' || c.status === 'in_progress'
          );
          const passed = relevant.find(
            (c) => c.status === 'completed' && c.conclusion === 'success'
          );

          if (failed) {
            ciStatus = 'failing';
            ciCheckName = failed.name;
            ciUrl = failed.htmlUrl;
          } else if (pending) {
            ciStatus = 'pending';
            ciCheckName = pending.name;
            ciUrl = pending.htmlUrl;
          } else if (passed) {
            ciStatus = 'passing';
            ciCheckName = passed.name;
            ciUrl = passed.htmlUrl;
          } else {
            ciStatus = 'unavailable';
          }
        } else if (matchingCommitChecks.length > 0) {
          ciStatus = 'not_run';
        } else {
          ciStatus = 'unavailable';
        }
      } else {
        ciStatus = 'unavailable';
      }
    } else if (scan.checkRuns && scan.checkRuns.length > 0) {
      // Check if a specific check run builds/tests this individual module
      const modKeyword = mod.id.replace('room-', '').toLowerCase();
      const moduleSpecificCheck = scan.checkRuns.find(
        (c) =>
          (!c.commitSha || !scan.commitSha || c.commitSha === scan.commitSha) &&
          c.name.toLowerCase().includes(modKeyword)
      );
      if (moduleSpecificCheck) {
        if (moduleSpecificCheck.status === 'completed') {
          ciStatus =
            moduleSpecificCheck.conclusion === 'failure' || moduleSpecificCheck.conclusion === 'timed_out'
              ? 'failing'
              : moduleSpecificCheck.conclusion === 'success'
              ? 'passing'
              : 'unavailable';
        } else {
          ciStatus = 'pending';
        }
        ciCheckName = moduleSpecificCheck.name;
        ciUrl = moduleSpecificCheck.htmlUrl;
      }
    }

    const roomDeps = dependencies
      .filter((d) => d.sourceRoomId === mod.id)
      .map((d) => {
        const target = modules.find((m) => m.id === d.targetRoomId);
        return target ? target.name : d.targetRoomId;
      });

    return {
      id: mod.id,
      name: mod.name,
      layer: mod.layer,
      status: evaluation.status,
      description: mod.description,
      evidence: `Scanned from ${scan.owner}/${scan.repo}: ${evidenceSummary}`,
      filePaths: modFiles.map((f) => f.path),
      dependencies: roomDeps,
      metrics: {
        testFilesCount: isTestRoom ? testFiles.length : undefined,
        filesCount: modFiles.length,
        ciStatus,
        ciCheckName,
        ciUrl,
      },
      coords: coordsList[idx] || { isoX: 0, isoY: 0, width: 140, height: 80, depth: 100 },
    };
  });

  // 5. Detect Real Infrastructure Pillars
  const configFiles = inspectedFiles.filter((f) => f.category === 'config');
  const manifestFiles = inspectedFiles.filter((f) => f.category === 'manifest');
  const pillars: InfrastructurePillar[] = [];

  const dockerFile = configFiles.find((f) => /dockerfile|docker-compose/i.test(f.path));
  if (dockerFile) {
    pillars.push({
      id: 'pillar-docker',
      name: 'Docker Infrastructure',
      description: `Container configuration detected in ${dockerFile.path}`,
      pillarType: 'runtime',
      status: 'configured',
    });
  }

  const ciFile = configFiles.find((f) => f.path.includes('.github/workflows/'));
  if (ciFile) {
    pillars.push({
      id: 'pillar-ci',
      name: 'GitHub Actions CI',
      description: `Continuous Integration workflow detected in ${ciFile.path}`,
      pillarType: 'observability',
      status: 'configured',
    });
  }

  if (dbFiles.length > 0) {
    pillars.push({
      id: 'pillar-database',
      name: 'Database Persistence',
      description: `Database persistence schema detected in ${dbFiles[0].path}`,
      pillarType: 'database',
      status: 'configured',
    });
  }

  const manifest = manifestFiles[0];
  if (manifest) {
    pillars.push({
      id: 'pillar-manifest',
      name: `Manifest: ${manifest.path}`,
      description: `Project manifest and dependency specifications in ${manifest.path}`,
      pillarType: 'hosting',
      status: 'verified',
    });
  }

  const project: Project = {
    id: `project-${scan.owner}-${scan.repo}`,
    name: repoName,
    description: scan.metadata?.description || `Scanned from github.com/${scan.owner}/${scan.repo}`,
    rooms: modules,
    pillars,
    dependencies,
  };

  return {
    project,
    rooms: architecturalRooms,
    pillars,
  };
}
