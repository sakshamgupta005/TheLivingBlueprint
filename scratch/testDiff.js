import { buildSystemPrompt } from '../src/server/contextBuilder.ts';

const mockRepo = {
  owner: 'sakshamgupta005',
  repo: 'patchboard-tasks-api',
  branch: 'main',
  commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
  totalFiles: 12,
  inspectedFiles: [
    {
      path: 'src/tasks/validation.js',
      category: 'source',
      contentExcerpt: 'function validateTaskTitle(title) { if (title.length === 0) return false; return true; }',
    },
    {
      path: 'src/routes/tasks.js',
      category: 'source',
      contentExcerpt: 'router.post("/tasks", (req, res) => { res.json({ id: 1 }); });',
    },
    {
      path: 'test/createTask.test.js',
      category: 'test',
      contentExcerpt: 'it("rejects whitespace-only task titles", () => { ... });',
    },
  ],
  discoveredFilePaths: ['src/tasks/validation.js', 'src/routes/tasks.js', 'test/createTask.test.js'],
  detectedTechnologies: ['JavaScript', 'Node.js', 'Express'],
  roomSummaries: [
    {
      id: 'room-routes',
      name: 'API Routing & Gateways',
      status: 'implemented',
      evidence: '3 route handlers defined in src/routes/tasks.js',
    },
  ],
};

const p1 = buildSystemPrompt({
  message: 'How does validation work?',
  repoContext: mockRepo,
});

const p2 = buildSystemPrompt({
  message: 'Show me a workflow diagram of validation',
  repoContext: mockRepo,
});

const lines1 = new Set(p1.split('\n'));
const lines2 = new Set(p2.split('\n'));
let onlyInP1 = 0;
for (const l of lines1) {
  if (!lines2.has(l)) {
    onlyInP1 += l.length + 1;
    console.log('ONLY IN P1:', l.slice(0, 80));
  }
}
console.log('Total only in P1:', onlyInP1);

