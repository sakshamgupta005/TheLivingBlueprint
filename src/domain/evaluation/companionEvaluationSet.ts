import type { CompanionEvalCase } from './types.ts';

export const COMPANION_EVALUATION_SET: CompanionEvalCase[] = [
  // =========================================================================
  // 1. Code Explanation (5 cases)
  // =========================================================================
  {
    id: 'eval-code-1',
    category: 'code_explanation',
    question: 'How does the task title validation function work?',
    explanationLevel: 'beginner',
    selectedRoomId: 'room-validation',
    description: 'Explain validateTaskTitle in plain English using a relatable analogy for a beginner.',
    expectedDirectAnswerTerms: ['checks', 'title', 'present'],
    expectedGroundingRefs: ['src/tasks/validation.js', 'validateTaskTitle'],
    requiredTermDefinitions: ['validation'],
    rubricCriteria: {
      grounding: 'Cites src/tasks/validation.js and validateTaskTitle without inventing files or functions.',
      correctness: 'Accurately explains that it tests if title.length === 0.',
      helpfulness: 'Answers directly first, explains why validation matters, and suggests next inspection.',
      clarity: 'Uses plain English, avoids greeting filler, and defines technical terms on first use.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'The task title validation function checks whether a submitted title is present before creating a task. In src/tasks/validation.js, validateTaskTitle(title) inspects the raw length of the string: if title.length === 0, it returns false; otherwise it returns true. Think of validation (a checkpoint that tests user input before saving it) like a guard at a gate checking if your ticket has text printed on it. This matters because tasks need meaningful names to be useful. To see how this is called, inspect the route handler in src/routes.js.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['Inspect how validateTaskTitle is called in src/routes.js', 'Why does whitespace slip past this check?'],
        },
      ],
    },
    samplePoorResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'Woof! Barkley here! Validation is super cool! The function validateTaskInput in input.js checks input.title and validates the entire user payload with regex!',
        },
      ],
    },
  },
  {
    id: 'eval-code-2',
    category: 'code_explanation',
    question: 'What happens inside the route handler when a client sends POST /tasks?',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-routes',
    description: 'Trace request reception in src/routes.js, validation delegation, and response behavior.',
    expectedDirectAnswerTerms: ['post', 'tasks', 'validate'],
    expectedGroundingRefs: ['src/routes.js', 'validateTaskTitle'],
    rubricCriteria: {
      grounding: 'Cites src/routes.js and router.post("/tasks").',
      correctness: 'Traces control flow from route receiving req.body.title into validateTaskTitle.',
      helpfulness: 'Explains coupling between routes and validation modules.',
      clarity: 'Engineering-focused, clear architectural explanation.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'When a POST /tasks request arrives, the Express route handler in src/routes.js extracts req.body.title and delegates verification to validateTaskTitle in src/tasks/validation.js. If validation returns false, the router rejects the request with an HTTP 400 error status. If valid, the task object is created and returned with an HTTP 201 status. This separation ensures the HTTP routing layer does not hard-code validation business rules. Next, we can inspect how storage persists the created task.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['What HTTP status code is returned on validation failure?', 'How does storage persist the task?'],
        },
      ],
    },
  },
  {
    id: 'eval-code-3',
    category: 'code_explanation',
    question: 'Explain the string length checking logic in src/tasks/validation.js step by step',
    explanationLevel: 'technical',
    selectedRoomId: 'room-validation',
    description: 'Precise analysis of boolean condition title.length === 0 and return contracts.',
    expectedDirectAnswerTerms: ['title.length', 'return', '0'],
    expectedGroundingRefs: ['src/tasks/validation.js', 'validateTaskTitle'],
    rubricCriteria: {
      grounding: 'Cites exact file src/tasks/validation.js and condition title.length === 0.',
      correctness: 'Identifies exact line logic and return types (boolean true/false).',
      helpfulness: 'Notes boundary conditions (empty string vs whitespace).',
      clarity: 'Technical precision with exact identifiers.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'In src/tasks/validation.js, validateTaskTitle(title) evaluates `if (title.length === 0) return false; return true;`. Step 1: it accesses the .length property of the string argument. Step 2: if the integer length is strictly 0, execution branches to return boolean false. Step 3: for any non-zero length, it falls through to return boolean true. Because no `.trim()` sanitization is applied prior to this check, strings consisting entirely of whitespace characters (e.g. "   ") have length > 0 and evaluate to true.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['Inspect line references in test/createTask.test.js', 'How should the check be refactored?'],
        },
        {
          speaker: 'cat',
          text: 'Notice that if title is null or undefined, accessing .length will throw a TypeError at runtime. That unhandled edge case is currently unshielded.',
          evidenceReference: 'src/tasks/validation.js',
        },
      ],
    },
  },
  {
    id: 'eval-code-4',
    category: 'code_explanation',
    question: 'What does validateTaskTitle return when given valid input?',
    explanationLevel: 'beginner',
    selectedRoomId: 'room-validation',
    description: 'Direct answer about return value for valid inputs.',
    expectedDirectAnswerTerms: ['true', 'boolean'],
    expectedGroundingRefs: ['src/tasks/validation.js', 'validateTaskTitle'],
    rubricCriteria: {
      grounding: 'Cites validateTaskTitle.',
      correctness: 'States it returns boolean true.',
      helpfulness: 'Explains what the caller does with that return value.',
      clarity: 'Concise and immediately answers the question.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'validateTaskTitle returns the boolean value true when given a valid title with characters. In src/tasks/validation.js, after passing the length check, the function reaches `return true;`, signaling to the router that the task is safe to create. If you want to see how the router responds to this true return, inspect src/routes.js.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['What does it return when the title is empty?', 'Where does the router handle this boolean?'],
        },
      ],
    },
  },
  {
    id: 'eval-code-5',
    category: 'code_explanation',
    question: 'Explain how task creation connects to the router in src/routes.js',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-routes',
    description: 'Explains route registration, import relationship, and request handling.',
    expectedDirectAnswerTerms: ['router', 'import', 'validate'],
    expectedGroundingRefs: ['src/routes.js', 'src/tasks/validation.js'],
    rubricCriteria: {
      grounding: 'Cites src/routes.js and its relationship to src/tasks/validation.js.',
      correctness: 'Accurately outlines how the router imports and invokes validation.',
      helpfulness: 'Describes the architectural separation of concerns.',
      clarity: 'Structured and clear.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'The task creation endpoint is registered in src/routes.js using Express router.post("/tasks", ...). It imports validateTaskTitle from src/tasks/validation.js and calls it at the start of the request lifecycle. If validation succeeds, it constructs the new task entity and sends an HTTP 201 response. This structure keeps routing concerns separate from validation logic.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['Trace the full request journey from client to response', 'Inspect error handling in the router'],
        },
      ],
    },
  },

  // =========================================================================
  // 2. Bug Diagnosis (5 cases)
  // =========================================================================
  {
    id: 'eval-bug-1',
    category: 'bug_diagnosis',
    question: 'Why is the test failing on whitespace-only task titles?',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-validation',
    description: 'Diagnose the whitespace validation bypass against the failing test in test/createTask.test.js.',
    expectedDirectAnswerTerms: ['spaces', 'length', 'trim'],
    expectedGroundingRefs: ['src/tasks/validation.js', 'test/createTask.test.js', 'validateTaskTitle'],
    rubricCriteria: {
      grounding: 'Cites src/tasks/validation.js and test/createTask.test.js.',
      correctness: 'Explains that raw string length > 0 for whitespace, bypassing length === 0.',
      helpfulness: 'Explains test expectations versus actual source behavior.',
      clarity: 'Insightful, grounded explanation.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'The test is failing because the validation logic checks raw string length without trimming whitespace first. In src/tasks/validation.js, validateTaskTitle checks `if (title.length === 0) return false;`. When a title contains only spaces like "   ", its length is 3, so it slips past the check and returns true. Later, the code trims the title to an empty string, leaving a blank task title. The test in test/createTask.test.js specifically asserts that whitespace-only titles must be rejected with HTTP 400.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['Inspect test/createTask.test.js line assertions', 'Show suggested code fix for validateTaskTitle'],
        },
        {
          speaker: 'cat',
          text: 'The GitHub Actions CI check confirms this: the test runner exited with code 1 specifically on the whitespace assertion.',
          evidenceReference: 'test/createTask.test.js',
        },
      ],
    },
  },
  {
    id: 'eval-bug-2',
    category: 'bug_diagnosis',
    question: 'What is the root cause of the validation bypass in validateTaskTitle?',
    explanationLevel: 'technical',
    selectedRoomId: 'room-validation',
    description: 'Technical root-cause analysis citing exact string handling and condition.',
    expectedDirectAnswerTerms: ['length === 0', 'trim', 'bypass'],
    expectedGroundingRefs: ['src/tasks/validation.js', 'validateTaskTitle'],
    rubricCriteria: {
      grounding: 'Cites exact function validateTaskTitle and file src/tasks/validation.js.',
      correctness: 'Identifies the absence of trim() before evaluating length === 0.',
      helpfulness: 'Explains both the mechanism and the recommended remediation.',
      clarity: 'Technical precision without ambiguity.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'The root cause in validateTaskTitle is evaluating raw length on an untrimmed string in src/tasks/validation.js: `if (title.length === 0) return false;`. This causes a validation bypass for whitespace. In JavaScript, whitespace characters like spaces, tabs, and newlines have positive character counts, so a string containing "   " evaluates to length 3, evaluating to false for the rejection branch. The fix is trimming whitespace prior to the length check: `if (!title || title.trim().length === 0) return false;`.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['Review git diff in the repair prompt', 'Inspect CI failure logs'],
        },
      ],
    },
  },
  {
    id: 'eval-bug-3',
    category: 'bug_diagnosis',
    question: 'Does the code trim whitespace before checking title length?',
    explanationLevel: 'beginner',
    selectedRoomId: 'room-validation',
    description: 'Direct factual confirmation that trim is not called prior to length check.',
    expectedDirectAnswerTerms: ['no', 'does not trim', 'before'],
    expectedGroundingRefs: ['src/tasks/validation.js'],
    rubricCriteria: {
      grounding: 'Cites src/tasks/validation.js.',
      correctness: 'Directly answers NO, trimming is not done before checking length.',
      helpfulness: 'Explains the consequence of this missing step.',
      clarity: 'Direct and plain English.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'No, the code does not trim whitespace before checking the length. In src/tasks/validation.js, validateTaskTitle immediately inspects title.length without calling .trim() first. Trimming (removing spaces from the beginning and end of text) happens too late, which allows a title made entirely of spaces to pass through as valid.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['What happens when spaces pass validation?', 'How does the test catch this?'],
        },
      ],
    },
  },
  {
    id: 'eval-bug-4',
    category: 'bug_diagnosis',
    question: 'Why did GitHub Actions CI fail on commit 4ddfe58?',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-validation',
    description: 'Connects exact commit SHA CI failure to the failing test case.',
    expectedDirectAnswerTerms: ['ci', 'fail', 'test/createTask.test.js'],
    expectedGroundingRefs: ['test/createTask.test.js', '4ddfe585adbccd57794efba49ca1102ff654382f'],
    rubricCriteria: {
      grounding: 'Cites commit 4ddfe58 and test/createTask.test.js.',
      correctness: 'Identifies the failing test run in CI on that commit.',
      helpfulness: 'Explains why the status engine marks the room as blocked.',
      clarity: 'Clear and evidence-grounded.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'GitHub Actions CI failed on commit 4ddfe58 because the automated test runner executed test/createTask.test.js and encountered an assertion failure. Specifically, the test "rejects whitespace-only task titles" sent a title with only spaces and expected an HTTP 400 Bad Request, but the API returned HTTP 201 Created. The CI job terminated with exit code 1, which is why The Living Blueprint marks Input Validation as blocked.',
          evidenceReference: 'test/createTask.test.js',
          suggestedFollowUps: ['Inspect the CI check details in telemetry drawer', 'Generate an automated repair prompt'],
        },
        {
          speaker: 'cat',
          text: 'Remember, The Living Blueprint only counts check runs matching this exact commit SHA: 4ddfe585adbccd57794efba49ca1102ff654382f. We never treat passing checks from other branches as current evidence.',
          evidenceReference: 'test/createTask.test.js',
        },
      ],
    },
  },
  {
    id: 'eval-bug-5',
    category: 'bug_diagnosis',
    question: 'How can we fix the whitespace bypass bug in src/tasks/validation.js?',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-validation',
    description: 'Proposes concise, correct code remediation with trim().',
    expectedDirectAnswerTerms: ['trim()', 'title.trim().length', 'src/tasks/validation.js'],
    expectedGroundingRefs: ['src/tasks/validation.js', 'validateTaskTitle'],
    rubricCriteria: {
      grounding: 'Cites src/tasks/validation.js.',
      correctness: 'Recommends title.trim().length === 0 or typeof title !== "string".',
      helpfulness: 'Provides copy-ready direction and mentions re-running tests.',
      clarity: 'Clear and actionable.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'To fix the bug, update validateTaskTitle in src/tasks/validation.js to trim the title before evaluating length: `if (!title || typeof title !== "string" || title.trim().length === 0) return false; return true;`. This strips leading and trailing spaces before checking length, correctly rejecting whitespace-only titles with false so the router returns HTTP 400. Once patched, running test/createTask.test.js will verify the fix.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['View repair prompt in room investigation', 'Inspect test/createTask.test.js expectations'],
        },
      ],
    },
  },

  // =========================================================================
  // 3. Missing Evidence / Unsupported Premises (5 cases)
  // =========================================================================
  {
    id: 'eval-missing-1',
    category: 'missing_evidence',
    question: 'Why is the OAuth2 authentication failing?',
    explanationLevel: 'intermediate',
    description: 'Must reject false premise: OAuth2 does not exist in this repository.',
    expectedDirectAnswerTerms: ['does not use', 'no oauth', 'not present'],
    expectedGroundingRefs: [],
    unsupportedPremise: {
      feature: 'OAuth2 authentication',
      mustReject: true,
      expectedRejectionTerms: ['does not use', 'no oauth', 'not found', 'not present', 'no authentication'],
    },
    rubricCriteria: {
      grounding: 'States clearly that OAuth2 is not present in the scanned repository files.',
      correctness: 'Rejects the unsupported premise immediately; does not invent an OAuth handler.',
      helpfulness: 'Explains what authentication or gateway structure actually exists.',
      clarity: 'Courteous and decisive.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'This repository does not use OAuth2 authentication, and there are no OAuth files or configurations in the scanned codebase. The project is a lightweight task management API with endpoints in src/routes.js and no authentication layer implemented. If your application needs authentication, an auth room would need to be designed from scratch.',
          suggestedFollowUps: ['What rooms are currently implemented?', 'Inspect API routes in src/routes.js'],
        },
        {
          speaker: 'cat',
          text: 'Cleo here to verify: across all 18 discovered files in this git tree, there is zero mention of oauth, passport, or jwt tokens.',
        },
      ],
    },
    samplePoorResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'The OAuth2 authentication is failing because the client secret in auth.config.js is expired or the token endpoint returned a 401 Unauthorized!',
        },
      ],
    },
  },
  {
    id: 'eval-missing-2',
    category: 'missing_evidence',
    question: 'How does Redis caching work in this repository?',
    explanationLevel: 'intermediate',
    description: 'Must reject false premise: Redis is not present in the repository.',
    expectedDirectAnswerTerms: ['does not use redis', 'no redis', 'not present'],
    expectedGroundingRefs: [],
    unsupportedPremise: {
      feature: 'Redis caching',
      mustReject: true,
      expectedRejectionTerms: ['does not use redis', 'no redis', 'not present', 'no caching'],
    },
    rubricCriteria: {
      grounding: 'Checks repository technologies and confirms Redis is absent.',
      correctness: 'Rejects premise; refuses to invent Redis caching logic.',
      helpfulness: 'Clarifies what data handling actually exists.',
      clarity: 'Direct and honest.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'This repository does not use Redis caching. There are no Redis dependencies in package.json or caching modules in the source tree. All requests pass directly from the Express router to in-memory validation and data structures.',
          suggestedFollowUps: ['What technologies were detected in package.json?', 'Inspect project architecture layers'],
        },
      ],
    },
  },
  {
    id: 'eval-missing-3',
    category: 'missing_evidence',
    question: 'Where are the GraphQL schemas and resolvers located?',
    explanationLevel: 'intermediate',
    description: 'Must reject false premise: project is a REST API, not GraphQL.',
    expectedDirectAnswerTerms: ['no graphql', 'rest api', 'not present'],
    expectedGroundingRefs: ['src/routes.js'],
    unsupportedPremise: {
      feature: 'GraphQL',
      mustReject: true,
      expectedRejectionTerms: ['no graphql', 'rest', 'not present', 'does not use'],
    },
    rubricCriteria: {
      grounding: 'Cites REST routes in src/routes.js.',
      correctness: 'Rejects GraphQL premise; points to REST endpoints.',
      helpfulness: 'Explains how the REST endpoints are structured.',
      clarity: 'Clear separation between REST and GraphQL.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'There are no GraphQL schemas or resolvers in this repository. This application is built as a REST API using Express, with routes defined in src/routes.js (such as POST /tasks). It does not use GraphQL or Apollo.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['What REST endpoints are exposed?', 'Inspect src/routes.js'],
        },
      ],
    },
  },
  {
    id: 'eval-missing-4',
    category: 'missing_evidence',
    question: 'How does the Stripe billing webhook handler verify signatures?',
    explanationLevel: 'intermediate',
    description: 'Must reject false premise: no Stripe or billing logic exists.',
    expectedDirectAnswerTerms: ['does not contain stripe', 'no billing', 'not present'],
    expectedGroundingRefs: [],
    unsupportedPremise: {
      feature: 'Stripe billing',
      mustReject: true,
      expectedRejectionTerms: ['does not contain stripe', 'no billing', 'no stripe', 'not present'],
    },
    rubricCriteria: {
      grounding: 'States clearly that billing and Stripe do not exist in the repository.',
      correctness: 'Rejects premise; refuses to hallucinate Stripe webhook verification.',
      helpfulness: 'Clarifies actual scope of the project.',
      clarity: 'Direct refusal to fabricate.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'This repository does not contain Stripe or any billing webhook handlers. The codebase is scoped strictly to task creation and validation. There are no payment or webhook integrations installed.',
          suggestedFollowUps: ['What features are implemented in this repository?'],
        },
      ],
    },
  },
  {
    id: 'eval-missing-5',
    category: 'missing_evidence',
    question: 'Why is the PostgreSQL connection pool exhausted?',
    explanationLevel: 'intermediate',
    description: 'Must clarify that PostgreSQL connection pooling is not part of inspected files.',
    expectedDirectAnswerTerms: ['not inspected', 'no postgresql pool', 'not present in inspected'],
    expectedGroundingRefs: [],
    unsupportedPremise: {
      feature: 'PostgreSQL connection pool',
      mustReject: true,
      expectedRejectionTerms: ['no evidence', 'not inspected', 'not present', 'no postgresql', 'uninspected', 'does not have'],
    },
    rubricCriteria: {
      grounding: 'Distinguishes inspected files from unverified database claims.',
      correctness: 'Rejects premise of a failing PostgreSQL pool.',
      helpfulness: 'Explains what database evidence exists or is uninspected.',
      clarity: 'Truthful evidence boundary.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'There is no evidence of a PostgreSQL connection pool failure in the inspected files or CI test results. While a file src/db/connection.js was discovered in the git tree, it was not inspected in this scan, and the active CI failure is caused by an input validation bug in test/createTask.test.js rather than a database pool exhaustion.',
          evidenceReference: 'test/createTask.test.js',
          suggestedFollowUps: ['Inspect active CI check failure details', 'What files were inspected in the scan?'],
        },
        {
          speaker: 'cat',
          text: 'Cleo note: Never blame the database when the CI logs explicitly point to a string validation test failing with HTTP 201 instead of 400.',
        },
      ],
    },
  },

  // =========================================================================
  // 4. Architecture & System Boundaries (5 cases)
  // =========================================================================
  {
    id: 'eval-arch-1',
    category: 'architecture',
    question: 'Explain how this project\'s architecture hangs together across layers',
    explanationLevel: 'intermediate',
    description: 'Architectural overview connecting gateway, validation, and testing rooms.',
    expectedDirectAnswerTerms: ['gateway', 'validation', 'layer', 'routes'],
    expectedGroundingRefs: ['src/routes.js', 'src/tasks/validation.js', 'test/createTask.test.js'],
    rubricCriteria: {
      grounding: 'References real architecture rooms and files.',
      correctness: 'Maps rooms to their respective layers (gateway vs core vs test).',
      helpfulness: 'Explains separation of concerns and data flow.',
      clarity: 'Structured architectural narrative.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'This project follows a layered micro-architecture visualized in The Living Blueprint as separate rooms. At the gateway layer, API Routes (src/routes.js) receives external HTTP requests. It delegates to the core logic layer, where Input Validation (src/tasks/validation.js) enforces payload rules. Finally, the testing layer (test/createTask.test.js) verifies that invalid inputs are rejected. This separation ensures routing, domain validation, and testing remain decoupled.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['Trace a request through these layers', 'Show me a workflow diagram'],
        },
      ],
    },
  },
  {
    id: 'eval-arch-2',
    category: 'architecture',
    question: 'Why does the API Routes room depend on Input Validation?',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-routes',
    description: 'Explains architectural coupling between routes and validation.',
    expectedDirectAnswerTerms: ['depend', 'validate', 'boundary'],
    expectedGroundingRefs: ['src/routes.js', 'src/tasks/validation.js'],
    rubricCriteria: {
      grounding: 'Cites src/routes.js depending on src/tasks/validation.js.',
      correctness: 'Explains why the router calls validation before creating tasks.',
      helpfulness: 'Explains the security and consistency boundary.',
      clarity: 'Clear explanation of coupling.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'The API Routes room depends on Input Validation because incoming HTTP payloads cannot be trusted. In src/routes.js, the router imports validateTaskTitle from src/tasks/validation.js to ensure that title constraints are satisfied before any task entity is processed or stored. This dependency establishes an input boundary that prevents malformed data from polluting downstream state.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['What happens if validation fails?', 'Inspect src/tasks/validation.js'],
        },
      ],
    },
  },
  {
    id: 'eval-arch-3',
    category: 'architecture',
    question: 'What are the primary architectural layers and rooms in this repository?',
    explanationLevel: 'beginner',
    description: 'Explains house rooms and layers in accessible terms.',
    expectedDirectAnswerTerms: ['gateway', 'routes', 'validation'],
    expectedGroundingRefs: ['src/routes.js', 'src/tasks/validation.js'],
    rubricCriteria: {
      grounding: 'Cites the actual derived rooms in the house.',
      correctness: 'Identifies rooms accurately without fabricating database/auth rooms.',
      helpfulness: 'Uses the house blueprint metaphor to make layers intuitive.',
      clarity: 'Beginner-friendly and welcoming.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'In The Living Blueprint, this project is organized into two primary architectural rooms. First is the API Routes room at the gateway layer (src/routes.js), which acts like the front door receiving HTTP requests. Second is the Input Validation room at the core layer (src/tasks/validation.js), which acts like a checkpoint inspecting the task title before entry. Together, they handle receiving and checking new task submissions.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['What is the status of each room?', 'Why is Input Validation marked blocked?'],
        },
      ],
    },
  },
  {
    id: 'eval-arch-4',
    category: 'architecture',
    question: 'What can this application actually do and what is missing?',
    explanationLevel: 'intermediate',
    description: 'Summarizes implemented capabilities versus missing features based on code evidence.',
    expectedDirectAnswerTerms: ['create tasks', 'validation', 'missing'],
    expectedGroundingRefs: ['src/routes.js', 'src/tasks/validation.js'],
    rubricCriteria: {
      grounding: 'Grounded in discovered routes and code files.',
      correctness: 'Identifies implemented task creation vs missing auth, persistence, or edit endpoints.',
      helpfulness: 'Gives the developer an honest capability audit.',
      clarity: 'Balanced and objective.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'Based on the inspected code, this application can accept HTTP POST requests to create tasks and perform basic title validation. What is missing: there are no endpoints for updating, deleting, or listing tasks, no user authentication, and the title validation currently allows whitespace-only titles to slip through. Storage appears in-memory or uninspected.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['Inspect the failing test case', 'Explore room investigation details'],
        },
      ],
    },
  },
  {
    id: 'eval-arch-5',
    category: 'architecture',
    question: 'What happens if the validation module throws an unhandled exception?',
    explanationLevel: 'technical',
    selectedRoomId: 'room-validation',
    description: 'Evaluates exception handling boundaries and blast radius in Express.',
    expectedDirectAnswerTerms: ['unhandled', 'express', '500'],
    expectedGroundingRefs: ['src/routes.js', 'src/tasks/validation.js'],
    rubricCriteria: {
      grounding: 'Cites src/routes.js and src/tasks/validation.js.',
      correctness: 'Identifies that an unhandled throw in the route handler triggers Express default 500 handler.',
      helpfulness: 'Explains error boundary resilience and blast radius.',
      clarity: 'Technical precision regarding exception bubbling.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'If validateTaskTitle throws an unhandled exception (for instance, a TypeError from accessing title.length when title is null), the exception bubbles out of the route handler in src/routes.js into Express\'s default error-handling middleware. Express terminates the request with an HTTP 500 Internal Server Error status. Because there is no custom try/catch block inside the router, the blast radius is contained to that individual HTTP request without crashing the Node process.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['How should null safety be added to validateTaskTitle?'],
        },
        {
          speaker: 'cat',
          text: 'Currently, src/tasks/validation.js does not check `typeof title === "string"`. A null payload causes an unhandled crash right at title.length.',
          evidenceReference: 'src/tasks/validation.js',
        },
      ],
    },
  },

  // =========================================================================
  // 5. Tests & CI Verification (4 cases)
  // =========================================================================
  {
    id: 'eval-test-1',
    category: 'tests_ci',
    question: 'What is the difference between test/createTask.test.js existing and CI check passing?',
    explanationLevel: 'beginner',
    selectedRoomId: 'room-validation',
    description: 'Fundamental Living Blueprint distinction between test file existing and verification passing.',
    expectedDirectAnswerTerms: ['existing', 'not proof', 'passed', 'ci'],
    expectedGroundingRefs: ['test/createTask.test.js'],
    rubricCriteria: {
      grounding: 'Cites test/createTask.test.js and CI check evidence.',
      correctness: 'Separates "file detected" from "test executed and passed".',
      helpfulness: 'Teaches core verification principle clearly.',
      clarity: 'Memorable and accessible.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'In The Living Blueprint, a test file simply existing in the repository is not proof that the code works. test/createTask.test.js existing only proves someone wrote a test. For a feature to be verified, the test must actually run in continuous integration (CI) on the exact scanned commit and exit with a passing status. In this repository, the test exists, but the CI check failed, which is why the room is marked blocked rather than verified.',
          evidenceReference: 'test/createTask.test.js',
          suggestedFollowUps: ['What check run failed in CI?', 'Why is the test failing?'],
        },
        {
          speaker: 'cat',
          text: 'Cleo\'s golden rule: Code existing is not proof of working software. Real CI results on this exact commit are the only ground truth.',
        },
      ],
    },
  },
  {
    id: 'eval-test-2',
    category: 'tests_ci',
    question: 'Did the test suite pass on the exact scanned commit SHA?',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-validation',
    description: 'Direct factual confirmation of CI outcome on commit SHA 4ddfe58.',
    expectedDirectAnswerTerms: ['no', 'failed', 'commit', '4ddfe58'],
    expectedGroundingRefs: ['4ddfe585adbccd57794efba49ca1102ff654382f', 'test/createTask.test.js'],
    rubricCriteria: {
      grounding: 'Cites exact commit SHA 4ddfe58 and test/createTask.test.js.',
      correctness: 'Directly answers NO; the CI run failed.',
      helpfulness: 'Explains what check failed.',
      clarity: 'Unambiguous factual reporting.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'No, the test suite did not pass on the scanned commit SHA (4ddfe585adbccd57794efba49ca1102ff654382f). The GitHub Actions CI workflow "Run Unit and Integration Tests" executed and failed due to an assertion failure in test/createTask.test.js. The status engine honors only this commit\'s evidence.',
          evidenceReference: 'test/createTask.test.js',
          suggestedFollowUps: ['Inspect the failure logs', 'What assertion failed in test/createTask.test.js?'],
        },
      ],
    },
  },
  {
    id: 'eval-test-3',
    category: 'tests_ci',
    question: 'What exact test assertion failed in test/createTask.test.js?',
    explanationLevel: 'technical',
    selectedRoomId: 'room-validation',
    description: 'Cites the exact test title and assertion expectation.',
    expectedDirectAnswerTerms: ['rejects whitespace-only task titles', '400', 'status'],
    expectedGroundingRefs: ['test/createTask.test.js'],
    rubricCriteria: {
      grounding: 'Cites test/createTask.test.js and the test title.',
      correctness: 'Identifies the failing assertion expecting HTTP 400.',
      helpfulness: 'Explains why the API response differed.',
      clarity: 'Technical precision with exact status codes.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'In test/createTask.test.js, the failing test is "rejects whitespace-only task titles". It sends `POST /tasks` with `{ title: "   " }` and asserts that `res.status` equals 400. However, because validateTaskTitle accepts the whitespace string, the route handler returns HTTP 201 Created, causing the assertion to throw an AssertionError and fail the CI run.',
          evidenceReference: 'test/createTask.test.js',
          suggestedFollowUps: ['How does validateTaskTitle evaluate "   "?', 'View suggested repair patch'],
        },
      ],
    },
  },
  {
    id: 'eval-test-4',
    category: 'tests_ci',
    question: 'Why does the status engine mark Input Validation as blocked rather than verified?',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-validation',
    description: 'Explains deterministic status calculation rules for blocked status.',
    expectedDirectAnswerTerms: ['blocked', 'failing test', 'status engine'],
    expectedGroundingRefs: ['src/tasks/validation.js', 'test/createTask.test.js'],
    rubricCriteria: {
      grounding: 'Cites status engine rules, src/tasks/validation.js, and test/createTask.test.js.',
      correctness: 'Explains that active failing CI test evidence overrides code existence to yield BLOCKED.',
      helpfulness: 'Explains how the status can transition back to VERIFIED after a fix.',
      clarity: 'Transparent explanation of status rules.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'The deterministic status engine marks Input Validation as blocked because active evidence shows a relevant failing test. Although the implementation exists in src/tasks/validation.js, the GitHub CI check run for the current commit reported a test failure in test/createTask.test.js. Under Living Blueprint rules, a failing test takes precedence over code existence, blocking the subsystem until a passing re-test supersedes the failure.',
          evidenceReference: 'test/createTask.test.js',
          suggestedFollowUps: ['How can we supersed this failure with a fix?', 'Generate a repair prompt'],
        },
      ],
    },
  },

  // =========================================================================
  // 6. Follow-up & Progressive Exploration (4 cases)
  // =========================================================================
  {
    id: 'eval-followup-1',
    category: 'follow_up',
    question: 'Can you explain that whitespace validation bug for a beginner using an analogy?',
    explanationLevel: 'beginner',
    selectedRoomId: 'room-validation',
    description: 'Translates the whitespace bug into an intuitive physical analogy for beginners.',
    expectedDirectAnswerTerms: ['package', 'box', 'empty', 'spaces'],
    expectedGroundingRefs: ['src/tasks/validation.js'],
    requiredTermDefinitions: ['validation'],
    rubricCriteria: {
      grounding: 'Anchors analogy in the real title.length === 0 check.',
      correctness: 'Accurately maps the flaw (spaces taking up room vs actual content).',
      helpfulness: 'Genuinely teaches the concept to a beginner.',
      clarity: 'Engaging, clear, and relatable.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'Imagine mailing a package: the postal rule says "the box cannot be empty." If someone fills the box with packing peanuts and no gift, the scale shows the box is full, so it passes the checkpoint! That is what happens in src/tasks/validation.js: the code only checks if the text length is 0. A string of spaces has length, so the system thinks the box has contents. Later, someone dumps out the packing peanuts, leaving nothing inside! That is why we need trimming—to check if there is an actual gift inside.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['What does the code look like when fixed?', 'Inspect the test in test/createTask.test.js'],
        },
      ],
    },
  },
  {
    id: 'eval-followup-2',
    category: 'follow_up',
    question: 'What should I inspect next in the codebase?',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-validation',
    description: 'Provides proactive, actionable next steps for developer investigation.',
    expectedDirectAnswerTerms: ['inspect', 'test/createTask.test.js', 'src/routes.js'],
    expectedGroundingRefs: ['test/createTask.test.js', 'src/routes.js'],
    rubricCriteria: {
      grounding: 'Points to actual files in the repository context.',
      correctness: 'Recommends high-value next targets (failing test and caller route).',
      helpfulness: 'Provides clear rationale for why each target matters.',
      clarity: 'Organized and concise.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'Here are the two best places to inspect next: First, inspect test/createTask.test.js to see the exact assertion expectations and mock payload that triggered the CI failure. Second, inspect src/routes.js to understand how the router receives req.body.title and handles HTTP error responses. Both files will give you complete context for repairing the validation room.',
          evidenceReference: 'test/createTask.test.js',
          suggestedFollowUps: ['Inspect test/createTask.test.js', 'Inspect src/routes.js'],
        },
      ],
    },
  },
  {
    id: 'eval-followup-3',
    category: 'follow_up',
    question: 'What is the technical contract and boundary behavior of validateTaskTitle?',
    explanationLevel: 'technical',
    selectedRoomId: 'room-validation',
    description: 'Detailed contract specification (parameters, return types, edge cases).',
    expectedDirectAnswerTerms: ['contract', 'boolean', 'parameter'],
    expectedGroundingRefs: ['src/tasks/validation.js', 'validateTaskTitle'],
    rubricCriteria: {
      grounding: 'Cites src/tasks/validation.js and validateTaskTitle.',
      correctness: 'Specifies input type, return type boolean, and unhandled null/undefined.',
      helpfulness: 'Analyzes contract strengths and fragility.',
      clarity: 'Technical contract specification.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'Contract specification for validateTaskTitle(title) in src/tasks/validation.js: Input signature expects a single parameter `title`. Return type is primitive boolean: returns false when title.length === 0, and true for any other value. Boundary behavior: strictly rejects the empty string "" with false; permits whitespace strings (" ") with true; throws an unhandled TypeError if passed null or undefined due to dereferencing .length. A robust contract requires type checking and trimming.',
          evidenceReference: 'src/tasks/validation.js',
          suggestedFollowUps: ['Generate TypeScript interface contract', 'View repair prompt'],
        },
      ],
    },
  },
  {
    id: 'eval-followup-4',
    category: 'follow_up',
    question: 'Show me a workflow diagram of the task creation request flow',
    explanationLevel: 'intermediate',
    selectedRoomId: 'room-routes',
    description: 'Returns grounded structured workflow diagram illustrating request flow.',
    expectedDirectAnswerTerms: ['workflow diagram', 'flow', 'routes'],
    expectedGroundingRefs: ['src/routes.js', 'src/tasks/validation.js'],
    rubricCriteria: {
      grounding: 'Workflow diagram nodes reference real files (src/routes.js, src/tasks/validation.js).',
      correctness: 'Edges trace valid path: Client -> Router -> Validation -> Response.',
      helpfulness: 'Diagram clarifies data flow and decision branches.',
      clarity: 'Validated diagram schema.',
    },
    sampleGoodResponse: {
      replies: [
        {
          speaker: 'dog',
          text: 'Here is the step-by-step workflow diagram for task creation, showing how a request flows from the client through routing, validation, and response branches.',
          evidenceReference: 'src/routes.js',
          suggestedFollowUps: ['Explain the validation decision step in detail', 'What happens on invalid title?'],
        },
      ],
      workflowDiagram: {
        id: 'diag-task-creation',
        title: 'Task Creation Request Flow',
        explanation: 'Traces POST /tasks from HTTP client through validation to response',
        simulationType: 'code-derived workflow walkthrough',
        nodes: [
          {
            id: 'node-client',
            label: 'HTTP Client',
            role: 'Caller',
            nodeType: 'external',
            classification: 'observed',
            description: 'Sends POST /tasks with JSON payload',
          },
          {
            id: 'node-router',
            label: 'API Router',
            role: 'Gateway Handler',
            nodeType: 'component',
            roomId: 'room-routes',
            filePath: 'src/routes.js',
            classification: 'observed',
            description: 'Receives request and delegates title to validator',
          },
          {
            id: 'node-validator',
            label: 'Title Validator',
            role: 'Validation Checkpoint',
            nodeType: 'decision',
            roomId: 'room-validation',
            filePath: 'src/tasks/validation.js',
            classification: 'observed',
            description: 'Evaluates title.length === 0',
          },
          {
            id: 'node-response',
            label: 'HTTP Response',
            role: 'Response Generator',
            nodeType: 'step',
            roomId: 'room-routes',
            filePath: 'src/routes.js',
            classification: 'observed',
            description: 'Returns HTTP 201 Created or HTTP 400 Bad Request',
          },
        ],
        edges: [
          { from: 'node-client', to: 'node-router', label: 'POST /tasks', classification: 'observed' },
          { from: 'node-router', to: 'node-validator', label: 'validateTaskTitle(title)', classification: 'observed' },
          { from: 'node-validator', to: 'node-response', label: 'valid / invalid status', classification: 'observed' },
        ],
      },
    },
  },
];
