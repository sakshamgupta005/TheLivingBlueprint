async function fetchRaw(path) {
  const url = `https://raw.githubusercontent.com/sakshamgupta005/patchboard-tasks-api/4ddfe585adbccd57794efba49ca1102ff654382f/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function main() {
  console.log('--- 1. Fetching Genuine Baseline Repository Files from GitHub ---');
  const filesToFetch = [
    { path: 'src/tasks/validation.js', category: 'source' },
    { path: 'test/createTask.test.js', category: 'test' },
    { path: 'src/tasks/createTask.js', category: 'source' },
    { path: 'src/tasks/store.js', category: 'source' },
    { path: 'src/server.js', category: 'source' },
    { path: 'test/server.test.js', category: 'test' },
    { path: '.github/workflows/ci.yml', category: 'config' },
    { path: 'package.json', category: 'manifest' },
    { path: 'README.md', category: 'readme' },
  ];

  const inspectedFiles = [];
  for (const f of filesToFetch) {
    try {
      const text = await fetchRaw(f.path);
      inspectedFiles.push({
        path: f.path,
        category: f.category,
        sizeBytes: text.length,
        contentExcerpt: text.slice(0, 3000),
      });
      console.log(`Fetched ${f.path} (${text.length} bytes)`);
    } catch (e) {
      console.warn(`Could not fetch ${f.path}:`, e.message);
    }
  }

  const commitSha = '4ddfe585adbccd57794efba49ca1102ff654382f';
  const discoveredFilePaths = [
    'src/tasks/validation.js',
    'src/tasks/createTask.js',
    'src/tasks/store.js',
    'src/server.js',
    'test/createTask.test.js',
    'test/server.test.js',
    '.github/workflows/ci.yml',
    'package.json',
    'README.md',
    'docs/ARCHITECTURE.md',
    'docs/SPECIFICATIONS.md',
    'docs/API.md',
  ];

  const roomSummaries = [
    {
      id: 'room-server',
      name: 'HTTP Server & API Routing',
      layer: 'service',
      status: 'implemented',
      evidence: 'Discovered HTTP server and route dispatcher in src/server.js',
      filePaths: ['src/server.js'],
    },
    {
      id: 'room-tasks',
      name: 'Task Management & Store',
      layer: 'core',
      status: 'implemented',
      evidence: 'Discovered domain implementation in src/tasks/createTask.js, src/tasks/store.js',
      filePaths: ['src/tasks/createTask.js', 'src/tasks/store.js'],
    },
    {
      id: 'room-validation',
      name: 'Input Validation & Schema',
      layer: 'core',
      status: 'implemented',
      evidence: 'Discovered input validation rules in src/tasks/validation.js',
      filePaths: ['src/tasks/validation.js'],
    },
    {
      id: 'room-tests',
      name: 'Automated Tests & Quality',
      layer: 'gateway',
      status: 'blocked',
      evidence: 'CI check failure: Run Unit and Integration Tests',
      filePaths: ['test/createTask.test.js', 'test/server.test.js'],
      ciStatus: 'failing',
      ciCheckName: 'Run Unit and Integration Tests',
    },
  ];

  const ciEvaluation = {
    status: 'failing',
    isVerified: false,
    reason: 'Failing check: Run Unit and Integration Tests on commit 4ddfe58',
    checkRunsCount: 1,
    failedChecks: ['Run Unit and Integration Tests'],
  };

  const repoContext = {
    owner: 'sakshamgupta005',
    repo: 'patchboard-tasks-api',
    branch: 'main',
    commitSha,
    totalFiles: 18,
    inspectedFiles,
    discoveredFilePaths,
    detectedTechnologies: ['JavaScript', 'Node.js', 'GitHub Actions'],
    roomSummaries,
    ciEvaluation,
  };

  console.log('\n--- 2. Sending Real /api/chat Request to Gemini ---');
  const chatRes = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Does this repository correctly reject task titles containing only whitespace? Explain what the code proves and cite the relevant source and test files.',
      selectedRoomId: 'room-validation',
      repoContext,
    }),
  });

  const chatData = await chatRes.json();
  console.log('Chat Status HTTP:', chatRes.status);
  console.log('Gemini Chat Output:\n', JSON.stringify(chatData, null, 2));

  console.log('\n--- 3. Sending Real /api/investigate Request to Gemini ---');
  const invRes = await fetch('http://localhost:3000/api/investigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId: 'room-validation',
      roomName: 'Input Validation & Schema',
      roomLayer: 'core',
      roomStatus: 'implemented',
      roomEvidence: 'Discovered input validation rules in src/tasks/validation.js',
      roomFilePaths: ['src/tasks/validation.js'],
      repoContext: {
        ...repoContext,
        dependencies: ['room-tasks'],
      },
    }),
  });

  const invData = await invRes.json();
  console.log('Investigation Status HTTP:', invRes.status);
  console.log('Gemini Investigation Output:\n', JSON.stringify(invData, null, 2));
}

main().catch((err) => {
  console.error('Execution error:', err);
  process.exit(1);
});
