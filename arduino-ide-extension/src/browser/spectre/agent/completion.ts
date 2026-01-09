/**
 * Completion/termination helpers for Spectre agent mode.
 *
 * @author Tazul Islam
 */

import { AgentTask, AgentActionHistoryRecord } from './agent-utils';

export function taskCompletedSuccessfully(params: {
  responseText: string | undefined;
  actionHistory: Array<AgentActionHistoryRecord>;
}): boolean {
  const { responseText, actionHistory } = params;

  const hasCompletionIndicators = hasCompletionKeywords(responseText);
  const hadSuccessfulActions = actionHistory.some(
    (action) => action.result?.success === true
  );

  return hasCompletionIndicators && hadSuccessfulActions;
}

export function hasCompletionKeywords(
  responseText: string | undefined
): boolean {
  if (!responseText) {
    return false;
  }

  const text = responseText.toLowerCase();
  // Keep this conservative: broad words like "done"/"ready" appear in normal
  // explanations and can cause false positives.
  const phrases = [
    'all tasks complete',
    'all tasks completed',
    'task completed',
    'tasks completed',
    'completed successfully',
    'work completed',
  ];
  return phrases.some((phrase) => text.includes(phrase));
}

export function markAllTasksCompleted(
  tasks: AgentTask[] | undefined
): AgentTask[] | undefined {
  if (!tasks || tasks.length === 0) {
    return tasks;
  }

  return tasks.map((task) => ({
    ...task,
    status: 'completed' as const,
  }));
}

export function formatCompletionMessage(iteration: number): string {
  return `\n\n---\n\n### ✅ Agent Finished\n\nFinished in **${iteration}** iteration${
    iteration > 1 ? 's' : ''
  }.\n`;
}
