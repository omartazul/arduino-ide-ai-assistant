/**
 * Completion/termination helpers for Spectre agent mode.
 *
 * @author Tazul Islam
 */

export interface AgentActionHistoryEntry {
  result?: { success: boolean };
}

import type { AgentTask } from './agent-tools';

export function taskCompletedSuccessfully(params: {
  responseText: string | undefined;
  actionHistory: Array<AgentActionHistoryEntry>;
}): boolean {
  const { responseText, actionHistory } = params;

  const hasCompletionIndicators = hasCompletionKeywords(responseText);
  const hadSuccessfulActions = actionHistory.some(
    (action) => action.result?.success === true
  );

  return hasCompletionIndicators && hadSuccessfulActions;
}

export function hasCompletionKeywords(responseText: string | undefined): boolean {
  if (!responseText) {
    return false;
  }

  const text = responseText.toLowerCase();
  const keywords = ['created', 'completed', 'done', 'ready', 'finished'];
  return keywords.some((keyword) => text.includes(keyword));
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
  return `\n\n---\n\n### ✅ Task Completed\n\nCompleted in **${iteration}** iteration${
    iteration > 1 ? 's' : ''
  }.\n`;
}
