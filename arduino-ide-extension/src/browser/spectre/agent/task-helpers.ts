/**
 * Task management helpers for agent mode.
 * Handles parsing and tracking of agent tasks.
 *
 * @author Tazul Islam
 */

export interface AgentTask {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  error?: string;
  actionType: string;
}

/**
 * Parses tasks from agent response text.
 */
export function parseTasksFromResponse(text: string): AgentTask[] {
  const tasks: AgentTask[] = [];
  const lines = text.split('\n');
  let taskId = 1;

  for (const line of lines) {
    // Match markdown checkbox patterns: - [ ], - [x], - [X], - [o], etc.
    const checkboxMatch = line.match(/^\s*[-*]\s*\[([^\]]*)\]\s*(.+)/);

    if (checkboxMatch) {
      const checkbox = checkboxMatch[1].toLowerCase().trim();
      const description = checkboxMatch[2].trim();

      // Determine status from checkbox character
      let status: 'pending' | 'in-progress' | 'completed' | 'failed' = 'pending';

      if (isCompletedCheckbox(checkbox)) {
        status = 'completed';
      } else if (isInProgressCheckbox(checkbox)) {
        status = 'in-progress';
      } else if (isFailedCheckbox(checkbox, description)) {
        status = 'failed';
      }

      tasks.push({
        id: `task-${taskId++}`,
        description,
        status,
        actionType: 'task', // Generic action type for parsed tasks
      });
    }
  }

  return tasks;
}

function isCompletedCheckbox(checkbox: string): boolean {
  return checkbox === 'x' || checkbox === '✓' || checkbox === '✔';
}

function isInProgressCheckbox(checkbox: string): boolean {
  return checkbox === 'o' || checkbox === '~' || checkbox === '⏳';
}

function isFailedCheckbox(checkbox: string, description: string): boolean {
  return (
    checkbox === '!' ||
    (checkbox === 'x' && description.toLowerCase().includes('failed'))
  );
}
