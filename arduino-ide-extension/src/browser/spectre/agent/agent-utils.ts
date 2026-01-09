/**
 * Generic utility functions for the Spectre Agent.
 * Handles action execution wrappers, error formatting, and response parsing.
 *
 * @author Tazul Islam
 */

import { spectreError } from '../../../common/protocol/spectre-types';
import * as RenderingHelpers from '../ui/message-rendering';

/**
 * Shared types for Spectre Agent.
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

export interface AgentActionHistoryRecord {
  functionName: string;
  result?: { success: boolean; result?: string; error?: string };
}

export interface CleanAgentResponseResult {
  cleanText: string;
  tasks: AgentTask[];
}

function inferActionTypeFromDescription(description: string): string {
  const d = description.toLowerCase();

  // Sketch
  if (d.includes('verify') && (d.includes('sketch') || d.includes('compile'))) {
    return 'verify_sketch';
  }
  if ((d.includes('upload') || d.includes('flash')) && d.includes('sketch')) {
    return 'upload_sketch';
  }
  if ((d.includes('create') || d.includes('write') || d.includes('generate')) &&
      (d.includes('sketch') || d.includes('code'))) {
    return 'create_sketch';
  }

  // Board / port
  if ((d.includes('select') || d.includes('choose')) && d.includes('board')) {
    return 'select_board';
  }
  if (d.includes('search') && d.includes('board')) {
    return 'search_boards';
  }
  if ((d.includes('select') || d.includes('choose')) && d.includes('port')) {
    return 'select_port';
  }

  // Library
  if (d.includes('install') && d.includes('library')) {
    return 'install_library';
  }
  if (d.includes('uninstall') && d.includes('library')) {
    return 'uninstall_library';
  }

  return 'task';
}

function parseExplicitActionType(description: string): {
  actionType?: string;
  description: string;
} {
  // Expected format: "(action_type) Description..."
  const m = description.match(/^\(([^)]+)\)\s*(.*)$/);
  if (!m) {
    return { description };
  }

  const raw = (m[1] || '').trim();
  const remainder = (m[2] || '').trim();

  // Accept "manual" as a special non-tool task.
  const normalized = raw.toLowerCase();
  if (!normalized) {
    return { description };
  }

  return {
    actionType: normalized,
    description: remainder || description,
  };
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function executeAgentAction(
  params: {
    logPrefix: string;
    actionDesc: string;
    getErrorMessage?: (err: unknown) => string;
    logError?: (msg: string, err: unknown) => void;
    errorHandler?: (err: unknown) => string;
  },
  action: () => Promise<string>
): Promise<string> {
  const {
    logPrefix,
    actionDesc,
    getErrorMessage = formatUnknownError,
    logError = spectreError,
    errorHandler,
  } = params;
  try {
    return await action();
  } catch (error: unknown) {
    if (logPrefix) {
      logError(`❌ ${logPrefix} error:`, error);
    }
    if (errorHandler) {
      return errorHandler(error);
    }
    return `❌ Failed to ${actionDesc}: ${getErrorMessage(error)}`;
  }
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
      const rawDescription = checkboxMatch[2].trim();
      const parsed = parseExplicitActionType(rawDescription);
      const description = parsed.description;
      const explicitActionType = parsed.actionType;

      // Determine status from checkbox character
      let status: 'pending' | 'in-progress' | 'completed' | 'failed' =
        'pending';

      // Failure has priority over completed/in-progress when the content indicates failure.
      if (isFailedCheckbox(checkbox, description)) {
        status = 'failed';
      } else if (isCompletedCheckbox(checkbox)) {
        status = 'completed';
      } else if (isInProgressCheckbox(checkbox)) {
        status = 'in-progress';
      }

      tasks.push({
        id: `task-${taskId++}`,
        description,
        status,
        actionType: explicitActionType || inferActionTypeFromDescription(description),
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

/**
 * Cleans agent response text by removing internal markers and extracting tasks.
 */
export function cleanAgentResponse(params: {
  responseText: string;
  thoughtsTokens?: number;
}): CleanAgentResponseResult {
  const { responseText, thoughtsTokens } = params;

  let cleanText = responseText;

  // Remove agent mode headers
  cleanText = cleanText.replace(/^##?\s*🤖\s*Agent Mode\s*\n*/gim, '');

  // Remove iteration markers
  cleanText = cleanText.replace(
    /^###?\s*🔄\s*Iteration\s+\d+\/\d+\s*\n*/gim,
    ''
  );

  // Remove analyzing messages
  cleanText = cleanText.replace(/^\*Analyzing your request.*?\*\s*\n*/gim, '');

  // Remove redundant code blocks
  cleanText = RenderingHelpers.suppressRedundantCodeBlocks(cleanText);

  // Parse tasks from the full original text, then remove task list(s) from the visible message.
  const tasks = parseTasksFromResponse(responseText);
  cleanText = stripTasksFromMessageText(cleanText);

  // Add thinking badge if available
  if (thoughtsTokens && thoughtsTokens > 0) {
    const thinkingBadge = `*💭 Used ${thoughtsTokens} thinking tokens*\n\n`;
    cleanText = thinkingBadge + cleanText;
  }

  // Remove excessive line breaks and trim
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
  cleanText = cleanText.trim();

  return { cleanText, tasks };
}

/**
 * Strips task list markers from message text.
 */
function stripTasksFromMessageText(text: string): string {
  let cleanText = text;

  // Remove the entire task list section
  cleanText = cleanText.replace(
    /(?:Here's the plan:|Plan:|Tasks?:)?\s*\n(?:- \[[xo ]\] [^\n]+\n?)+/gim,
    ''
  );

  // Also remove standalone task lines scattered in text
  cleanText = cleanText.replace(/^- \[[xo ]\] [^\n]+\n?/gim, '');

  return cleanText;
}
