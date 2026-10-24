/**
 * testRunner.ts — Runs the observed test command as a visible VS Code task (P2-13).
 *
 * The caller must already have confirmed the exact command with the user.
 * The real exit code comes from onDidEndTaskProcess. The task is terminated
 * after the timeout. AI provider credential variables are blanked in the task
 * environment so the test process never receives them.
 */

import * as vscode from 'vscode';
import type { ExecutionOutcome } from './core/localEvidence.ts';

const PROVIDER_ENV_NAMES = [
  'GEMINI_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'AI_API_KEY',
  'GROQ_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'OMNIROUTE_API_KEY',
];

export function executeTestTask(
  folder: vscode.WorkspaceFolder,
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<ExecutionOutcome> {
  const env = Object.fromEntries(PROVIDER_ENV_NAMES.map((name) => [name, '']));
  const task = new vscode.Task(
    { type: 'shell' },
    folder,
    'Run Project Tests',
    'Living Blueprint',
    new vscode.ShellExecution(command, { cwd, env })
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };

  const isOurs = (e: { execution: vscode.TaskExecution }) =>
    e.execution.task.name === task.name && e.execution.task.source === task.source;

  return new Promise((resolve) => {
    let execution: vscode.TaskExecution | undefined;
    let settled = false;
    let timedOut = false;

    const finish = (outcome: ExecutionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      procSub.dispose();
      endSub.dispose();
      resolve(outcome);
    };

    const procSub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (!isOurs(e)) return;
      if (timedOut) finish({ kind: 'timeout' });
      else if (typeof e.exitCode === 'number') finish({ kind: 'exited', exitCode: e.exitCode });
      else finish({ kind: 'cancelled' });
    });
    // If the task ends without a process exit (e.g. terminated before start), it proves nothing.
    const endSub = vscode.tasks.onDidEndTask((e) => {
      if (!isOurs(e)) return;
      setTimeout(() => finish(timedOut ? { kind: 'timeout' } : { kind: 'cancelled' }), 500);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      execution?.terminate();
      // Fallback in case the end events never arrive.
      setTimeout(() => finish({ kind: 'timeout' }), 2000);
    }, timeoutMs);

    vscode.tasks.executeTask(task).then(
      (exec) => {
        execution = exec;
      },
      () => finish({ kind: 'cancelled' })
    );
  });
}
