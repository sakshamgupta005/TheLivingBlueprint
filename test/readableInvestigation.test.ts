import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inspectorSource = fs.readFileSync(
  path.resolve(__dirname, '../src/components/RoomInspector.tsx'),
  'utf-8'
);

const cssContent = fs.readFileSync(
  path.resolve(__dirname, '../src/index.css'),
  'utf-8'
);

describe('T17: Readable Investigation Workspace and Expandable Detail View', () => {
  it('1. Selected-room inspector places a prominent primary action directly below room header', () => {
    // Action must be located in room-primary-investigate-banner
    assert.ok(
      inspectorSource.includes('room-primary-investigate-banner'),
      'Must contain room-primary-investigate-banner container'
    );
    assert.ok(
      inspectorSource.includes('btn-investigate-room-primary'),
      'Must contain primary investigate button'
    );
    assert.ok(
      inspectorSource.includes('🔍 Investigate this room'),
      'Must offer "🔍 Investigate this room" action'
    );
    assert.ok(
      inspectorSource.includes('Find potential issues, understand the evidence, and explore what needs attention.'),
      'Must include the exact required concise supporting text'
    );

    // Primary action banner must appear before definitions, descriptions, and metrics
    const bannerIdx = inspectorSource.indexOf('room-primary-investigate-banner');
    const descIdx = inspectorSource.indexOf('room-detail-desc');
    const metricsIdx = inspectorSource.indexOf('room-detail-metrics');

    assert.ok(bannerIdx < descIdx, 'Investigate banner must appear before room description');
    assert.ok(bannerIdx < metricsIdx, 'Investigate banner must appear before metrics');
  });

  it('2. Clearly guides the user to select a room when no room is selected', () => {
    assert.ok(
      inspectorSource.includes('room-inspector-empty'),
      'Must contain empty state container class'
    );
    assert.ok(
      inspectorSource.includes('No room selected'),
      'Must explicitly inform user no room is selected'
    );
    assert.ok(
      inspectorSource.includes('Select a room in the architecture house above'),
      'Must guide the user to select a room from the architecture house'
    );
    assert.ok(
      inspectorSource.includes('Dismiss inspector guide'),
      'Must provide dismiss affordance so users can close the guide card'
    );
  });

  it('3. Findings present a strong, readable hierarchy: Finding, Assessment, Evidence, Uncertainties, Recommendation, Prompt', () => {
    // Finding header with clear title and expand trigger
    assert.ok(
      inspectorSource.includes('finding-header-top-row'),
      'Must contain finding header top row'
    );
    assert.ok(
      inspectorSource.includes('finding-section-eyebrow'),
      'Must contain diagnostic finding eyebrow'
    );
    assert.ok(
      inspectorSource.includes('finding-title'),
      'Must contain finding title'
    );

    // 1. Finding explanation in readable prose
    assert.ok(
      inspectorSource.includes('finding-explanation'),
      'Must render finding explanation in readable prose'
    );

    // 2. Assessment badges
    assert.ok(
      inspectorSource.includes('finding-badges-row'),
      'Must contain assessment badges row'
    );
    assert.ok(
      inspectorSource.includes('category-pill') &&
      inspectorSource.includes('severity-pill') &&
      inspectorSource.includes('classification-pill') &&
      inspectorSource.includes('timing-pill'),
      'Must include category, severity, classification, and timing metadata'
    );

    // 3. Validated Evidence section
    assert.ok(
      inspectorSource.includes('finding-evidence-section'),
      'Must contain dedicated validated evidence section'
    );
    assert.ok(
      inspectorSource.includes('VALIDATED EVIDENCE:'),
      'Must display VALIDATED EVIDENCE section header'
    );
    assert.ok(
      inspectorSource.includes('finding-code-evidence-box'),
      'Must contain code evidence excerpt box'
    );
    assert.ok(
      inspectorSource.includes('derivedLineNumber'),
      'Must display derived line numbers for code evidence'
    );
    assert.ok(
      inspectorSource.includes('finding-refs-list'),
      'Must list validated file references with inspection status and GitHub URLs'
    );

    // 4. What remains uncertain
    assert.ok(
      inspectorSource.includes('finding-uncertainties-wrapper'),
      'Must contain what remains uncertain section'
    );
    assert.ok(
      inspectorSource.includes('WHAT REMAINS UNCERTAIN:'),
      'Must display WHAT REMAINS UNCERTAIN section header'
    );
    assert.ok(
      inspectorSource.includes('finding-uncertainties-box'),
      'Must display uncertainties container'
    );

    // 5. Recommended next step
    assert.ok(
      inspectorSource.includes('finding-recommendation-wrapper'),
      'Must contain recommended next step section'
    );
    assert.ok(
      inspectorSource.includes('RECOMMENDED NEXT STEP:'),
      'Must display RECOMMENDED NEXT STEP header'
    );

    // 6. Repair prompt section with prominent copy button
    assert.ok(
      inspectorSource.includes('repair-prompt-section'),
      'Must contain dedicated repair prompt section'
    );
    assert.ok(
      inspectorSource.includes('CODING AGENT REPAIR PROMPT:'),
      'Must display CODING AGENT REPAIR PROMPT header'
    );
    assert.ok(
      inspectorSource.includes('btn-copy-prompt'),
      'Must include copy prompt button'
    );
    assert.ok(
      inspectorSource.includes('Copy prompt for coding agent'),
      'Must provide prominent copy action text'
    );
  });

  it('4. Provides clearly visible "Expand view" controls in both primary banner and finding card', () => {
    assert.ok(
      inspectorSource.includes('btn-expand-investigation-trigger'),
      'Primary banner must have expand trigger button'
    );
    assert.ok(
      inspectorSource.includes('btn-expand-finding'),
      'Finding card must have expand trigger button'
    );
    assert.ok(
      inspectorSource.includes('⤢ Expand view'),
      'Must display clear "⤢ Expand view" label'
    );
  });

  it('5. Expanded reading mode uses accessible dialog semantics and keyboard controls', () => {
    assert.ok(
      inspectorSource.includes('role="dialog"'),
      'Must use role="dialog" for expanded view modal'
    );
    assert.ok(
      inspectorSource.includes('aria-modal="true"'),
      'Must set aria-modal="true"'
    );
    assert.ok(
      inspectorSource.includes('aria-labelledby="expanded-investigation-title"'),
      'Must set aria-labelledby linking to modal title'
    );
    assert.ok(
      inspectorSource.includes("e.key === 'Escape'"),
      'Must listen for Escape key to dismiss expanded view'
    );
    assert.ok(
      inspectorSource.includes("document.body.style.overflow = 'hidden'"),
      'Must prevent background scrolling while expanded view is open'
    );
    assert.ok(
      inspectorSource.includes('document.body.style.overflow = originalOverflow'),
      'Must restore background scrolling when expanded view is closed'
    );
    assert.ok(
      inspectorSource.includes('lastActiveElementRef.current?.focus'),
      'Must restore keyboard focus when modal closes'
    );
  });

  it('6. Does not duplicate investigation requests or re-fetch on expand/collapse', () => {
    // Only handleInvestigate makes a network request
    const fetchMatches = inspectorSource.match(/fetch\(['"]\/api\/investigate['"]/g);
    assert.strictEqual(
      fetchMatches ? fetchMatches.length : 0,
      1,
      'There must be exactly one place in RoomInspector that calls /api/investigate'
    );

    // Opening expanded view is a purely local state toggle
    assert.ok(
      inspectorSource.includes('setIsExpanded(true)'),
      'Opening modal updates presentation state'
    );
    assert.ok(
      !inspectorSource.includes('setIsExpanded(true); handleInvestigate'),
      'Must not trigger network request on expand'
    );
    assert.ok(
      !inspectorSource.includes('setIsExpanded(false); handleInvestigate'),
      'Must not trigger network request on collapse'
    );
  });

  it('7. Preserves finding, repair prompt, and lifecycle state across expand/collapse transitions', () => {
    // The expanded view reads directly from the existing finding, room, and lifecycle props
    assert.ok(
      inspectorSource.includes('finding.generatedPrompt'),
      'Expanded view renders existing generated prompt'
    );
    assert.ok(
      inspectorSource.includes('FixLifecyclePanel'),
      'Both normal and expanded views use the existing lifecycle state'
    );
    assert.ok(
      inspectorSource.includes('savedLifecycleState={savedLifecycleState}'),
      'Preserves saved lifecycle state'
    );
  });

  it('8. CSS enforces near-full-screen bounds (88-94% width, 88-92% height) and internal scrolling', () => {
    assert.ok(
      cssContent.includes('width: 90vw;'),
      'Desktop expanded dialog width must be within 88-94% of viewport (~90vw)'
    );
    assert.ok(
      cssContent.includes('height: 90vh;'),
      'Desktop expanded dialog height must be within 88-92% of viewport (~90vh)'
    );
    assert.ok(
      cssContent.includes('max-width: 1140px;'),
      'Must have sensible max-width for readability'
    );
    assert.ok(
      cssContent.includes('overflow-y: auto;'),
      'Dialog body must provide internal vertical scrolling'
    );
    assert.ok(
      cssContent.includes('investigation-modal-backdrop'),
      'Must provide backdrop overlay'
    );
  });

  it('9. CSS prevents horizontal overflow on long paths, commits, and code snippets', () => {
    assert.ok(
      cssContent.includes('overflow-wrap: anywhere;') || cssContent.includes('word-break: break-all;'),
      'Long paths and hashes must wrap without pushing containers outside'
    );
    assert.ok(
      cssContent.includes('code-evidence-pre'),
      'Must have code evidence pre block styling'
    );
    assert.ok(
      cssContent.includes('overflow-x: auto;'),
      'Code snippets must scroll horizontally within container rather than expanding the panel'
    );
  });

  it('10. Responsive mobile styling adapts into full screen with zero horizontal overflow', () => {
    assert.ok(
      cssContent.includes('@media (max-width: 860px)'),
      'Must include responsive mobile/tablet breakpoint'
    );
    assert.ok(
      cssContent.includes('width: 100vw;'),
      'Adapts to 100vw on mobile'
    );
    assert.ok(
      cssContent.includes('height: 100vh;'),
      'Adapts to 100vh on mobile'
    );
  });

  it('11. Failed investigations and missing configuration remain readable and recoverable', () => {
    assert.ok(
      inspectorSource.includes('room-error-banner'),
      'Maintains error banner on investigation failure'
    );
    assert.ok(
      inspectorSource.includes('btn-retry-investigate'),
      'Provides retry affordance on failure'
    );
    assert.ok(
      inspectorSource.includes('room-setup-banner'),
      'Maintains setup banner when API key is missing'
    );
  });
});
