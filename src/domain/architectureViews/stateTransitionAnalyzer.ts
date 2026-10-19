import type {
  ArchitectureLensResult,
  DetectedState,
  DetectedStateTransition,
  StateMachineModel,
  StateTransitionModel,
} from './types.ts';

export interface StateAnalyzerInput {
  files: Record<string, string>; // path -> content
}

/**
 * Detects explicit enums, state constants, and recognizable transitions in inspected files.
 * Transitions are shown ONLY when supported by code evidence.
 */
export function analyzeStateTransitions(
  input: StateAnalyzerInput
): ArchitectureLensResult<StateTransitionModel> {
  const machines: StateMachineModel[] = [];

  for (const [filePath, content] of Object.entries(input.files)) {
    const lines = content.split('\n');

    // 1. TypeScript / JavaScript Enum: enum Status { A = 'a', B = 'b' }
    const enumRegex = /(?:export\s+)?enum\s+([A-Za-z0-9_$]+)\s*\{([^}]+)\}/g;
    let match: RegExpExecArray | null;

    while ((match = enumRegex.exec(content)) !== null) {
      const enumName = match[1];
      const body = match[2];
      const matchPos = match.index;
      const startLine = content.slice(0, matchPos).split('\n').length;

      const states: DetectedState[] = [];
      const rawMembers = body.split(',');
      for (const raw of rawMembers) {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        const [k, v] = trimmed.split('=').map((s) => s.trim().replace(/['"]/g, ''));
        if (k) {
          states.push({
            id: `${enumName}.${k}`,
            label: k,
            value: v || k,
            sourceFile: filePath,
            line: startLine,
          });
        }
      }

      if (states.length >= 2) {
        // Look for transitions in all files referencing this enum or state
        const transitions = findTransitionsForStates(states, input.files, enumName);
        machines.push({
          name: enumName,
          sourceFile: filePath,
          states,
          transitions,
        });
      }
    }

    // 2. State constant maps: const TaskStatus = { TODO: 'todo', DONE: 'done' } (as const)?
    const stateObjRegex = /(?:export\s+)?const\s+([A-Za-z0-9_$]*(?:Status|State|Phase|Stage|Step)[A-Za-z0-9_$]*)\s*=\s*(?:Object\.freeze\s*\(\s*)?\{([^}]+)\}/g;
    while ((match = stateObjRegex.exec(content)) !== null) {
      const name = match[1];
      const body = match[2];
      const startLine = content.slice(0, match.index).split('\n').length;

      // Avoid duplicate machine if enum was already caught
      if (machines.some((m) => m.name === name && m.sourceFile === filePath)) continue;

      const states: DetectedState[] = [];
      const rawPairs = body.split(',');
      for (const pair of rawPairs) {
        const trimmed = pair.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        const [k, v] = trimmed.split(':').map((s) => s.trim().replace(/['"]/g, ''));
        if (k) {
          states.push({
            id: `${name}.${k}`,
            label: k,
            value: v || k,
            sourceFile: filePath,
            line: startLine,
          });
        }
      }

      if (states.length >= 2) {
        const transitions = findTransitionsForStates(states, input.files, name);
        machines.push({
          name,
          sourceFile: filePath,
          states,
          transitions,
        });
      }
    }

    // 3. String Union Types: type TaskStatus = 'todo' | 'in_progress' | 'done'
    const unionRegex = /(?:export\s+)?type\s+([A-Za-z0-9_$]*(?:Status|State|Phase|Stage)[A-Za-z0-9_$]*)\s*=\s*['"]([^'"]+)['"](?:\s*\|\s*['"]([^'"]+)['"])+/g;
    while ((match = unionRegex.exec(content)) !== null) {
      const name = match[1];
      if (machines.some((m) => m.name === name && m.sourceFile === filePath)) continue;
      const startLine = content.slice(0, match.index).split('\n').length;

      // Extract all union string literals from full match line
      const lineText = lines[startLine - 1] || '';
      const literals = [...lineText.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

      if (literals.length >= 2) {
        const states: DetectedState[] = literals.map((val) => ({
          id: `${name}.${val}`,
          label: val,
          value: val,
          sourceFile: filePath,
          line: startLine,
        }));

        const transitions = findTransitionsForStates(states, input.files, name);
        machines.push({
          name,
          sourceFile: filePath,
          states,
          transitions,
        });
      }
    }
  }

  const totalStates = machines.reduce((acc, m) => acc + m.states.length, 0);
  const totalTransitions = machines.reduce((acc, m) => acc + m.transitions.length, 0);

  const hasSufficientEvidence = machines.length > 0 && totalStates >= 2;

  return {
    viewMode: 'state_transitions',
    title: 'State Transition View',
    hasSufficientEvidence,
    reasonIfUnsupported: hasSufficientEvidence
      ? undefined
      : 'No explicit enums, state constants, or recognizable state transitions detected in inspected source code.',
    model: hasSufficientEvidence
      ? {
          machines,
          totalStates,
          totalTransitions,
        }
      : null,
    stats: {
      machinesCount: machines.length,
      totalStates,
      totalTransitions,
    },
  };
}

/**
 * Searches code files for explicit state transition statements matching known state values.
 * Show transitions only when supported by code.
 */
function findTransitionsForStates(
  states: DetectedState[],
  files: Record<string, string>,
  machineName: string
): DetectedStateTransition[] {
  const transitions: DetectedStateTransition[] = [];
  const stateByToken = new Map<string, DetectedState>();
  for (const s of states) {
    if (s.label) stateByToken.set(s.label.toLowerCase(), s);
    if (s.value) stateByToken.set(s.value.toLowerCase(), s);
  }

  const allTokens = [...new Set(states.flatMap((s) => [s.label, s.value].filter(Boolean) as string[]))];
  if (allTokens.length === 0) return transitions;

  const tokenRegexStr = allTokens
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
    .join('|');

  for (const [filePath, content] of Object.entries(files)) {
    const lines = content.split('\n');

    // Pattern A: Explicit state machine transition maps:
    // transitions = { draft: ['in_review'], in_review: ['approved', 'rejected'] }
    const transMapRegex = /([A-Za-z0-9_]+)\s*:\s*\[([^\]]+)\]/g;
    let mMap: RegExpExecArray | null;
    while ((mMap = transMapRegex.exec(content)) !== null) {
      const fromKey = mMap[1].replace(/['"]/g, '').trim().toLowerCase();
      const fromState = stateByToken.get(fromKey);
      if (fromState) {
        const targets = mMap[2].split(',').map((t) => t.replace(/['"]/g, '').trim().toLowerCase()).filter(Boolean);
        const line = content.slice(0, mMap.index).split('\n').length;
        for (const tgt of targets) {
          const toState = stateByToken.get(tgt);
          if (toState && toState.label !== fromState.label) {
            const fromVal = fromState.value || fromState.label;
            const toVal = toState.value || toState.label;
            transitions.push({
              id: `trans-${fromVal}-${toVal}-${line}`,
              from: fromVal,
              to: toVal,
              sourceFile: filePath,
              line,
              evidence: `Explicit transition map definition: ${fromVal} -> ${toVal}`,
              confidence: 'observed',
            });
          }
        }
      }
    }

    // Pattern B: Switch-case / if-condition transition:
    // case 'TODO': task.status = 'IN_PROGRESS';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Look for: case 'X': or case MachineName.X: ... next: 'Y' or MachineName.Y or status = 'Y'
      const caseMatch = line.match(new RegExp(`case\\s+(?:${machineName}\\.)?['"]?(${tokenRegexStr})['"]?\\s*:`, 'i'));
      if (caseMatch) {
        const fromState = stateByToken.get(caseMatch[1].toLowerCase());
        if (fromState) {
          // Scan next 10 lines for target assignment
          const nextLines = lines.slice(i, Math.min(lines.length, i + 10)).join('\n');
          const targetAssign = nextLines.match(new RegExp(`(?:status|state|phase)\\s*=\\s*(?:${machineName}\\.)?['"]?(${tokenRegexStr})['"]?`, 'i'));
          if (targetAssign) {
            const toState = stateByToken.get(targetAssign[1].toLowerCase());
            if (toState && toState.label !== fromState.label) {
              const fromVal = fromState.value || fromState.label;
              const toVal = toState.value || toState.label;
              transitions.push({
                id: `trans-case-${fromVal}-${toVal}-${lineNum}`,
                from: fromVal,
                to: toVal,
                trigger: `case '${caseMatch[1]}'`,
                sourceFile: filePath,
                line: lineNum,
                evidence: `Case branch transitions state from "${fromVal}" to "${toVal}"`,
                confidence: 'observed',
              });
            }
          }
        }
      }

      // Pattern C: Function transition:
      // function completeTask(...) { task.status = 'done'; } or startTask() -> 'in_progress'
      const funcMatch = line.match(/(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/) ||
        line.match(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)?\s*=>/) ||
        line.match(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?function/);
      if (funcMatch) {
        const funcName = funcMatch[1];
        const bodyLines = lines.slice(i, Math.min(lines.length, i + 25)).join('\n');
        const assignMatch = bodyLines.match(new RegExp(`(?:status|state|phase|statusId)\\s*=\\s*(?:${machineName}\\.)?['"]?(${tokenRegexStr})['"]?`, 'i'));
        if (assignMatch) {
          const toState = stateByToken.get(assignMatch[1].toLowerCase());
          if (toState) {
            // Approximate origin if named "complete" -> from active, "start" -> from todo
            let fromState: DetectedState | undefined;
            if (/complete|finish|resolve|done/i.test(funcName)) {
              fromState = states.find((s) => /progress|active|pending|doing/i.test(s.value || s.label)) || states[0];
            } else if (/start|begin|activate/i.test(funcName)) {
              fromState = states.find((s) => /todo|draft|new|init|created/i.test(s.value || s.label)) || states[0];
            } else if (/cancel|reject|abort/i.test(funcName)) {
              fromState = states.find((s) => /progress|active|pending|draft/i.test(s.value || s.label)) || states[0];
            }

            if (fromState && fromState.label !== toState.label) {
              const fromVal = fromState.value || fromState.label;
              const toVal = toState.value || toState.label;
              transitions.push({
                id: `trans-func-${funcName}-${fromVal}-${toVal}-${lineNum}`,
                from: fromVal,
                to: toVal,
                trigger: `${funcName}()`,
                sourceFile: filePath,
                line: lineNum,
                evidence: `Function "${funcName}" updates state to "${toVal}"`,
                confidence: 'observed',
              });
            }
          }
        }
      }
    }
  }

  // Deduplicate transitions
  const uniqueTransitions: DetectedStateTransition[] = [];
  const seenKey = new Set<string>();
  for (const t of transitions) {
    const k = `${t.from}->${t.to}`;
    if (!seenKey.has(k)) {
      seenKey.add(k);
      uniqueTransitions.push(t);
    }
  }

  return uniqueTransitions;
}
