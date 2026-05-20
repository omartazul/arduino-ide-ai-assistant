/**
 * Orchestration utilities for agent function-calling and execution.
 *
 * Provides helpers to detect ReAct loops, render execution progress,
 * and record function results into the conversation history.
 *
 * @author Tazul Islam
 */

import * as RenderingHelpers from '../ui/message-rendering';
import { AgentActionHistoryRecord } from './agent-utils';

export type AgentFunctionCall = {
  name: string;
  args: Record<string, unknown>;
  id?: string;
  thoughtSignature?: string;
  thought_signature?: string;
};

export type AgentLoopDetected = {
  signature: string;
  functionName: string;
  args: unknown;
};

export type MutateLastAssistant = (
  mutator: (prev: string) => string,
  requestSeq: number
) => void;

interface FunctionResponse {
  success: boolean;
  result?: string;
  error?: string;
  status: string;
  instruction: string;
}

export type ConversationHistoryItem = {
  role: string;
  name?: string;
  callId?: string;
  response?: unknown;
  content?: string;
};

export interface ProcessFunctionCallsParams {
  functionCalls: AgentFunctionCall[];
  detectLoop: (calls: AgentFunctionCall[]) => AgentLoopDetected | null;
  actionHistory: AgentActionHistoryRecord[];
  conversationHistory: ConversationHistoryItem[];
  requestSeq: number;
  shouldAbort: () => boolean;
  mutateLastAssistant: MutateLastAssistant;
  executeFunctionCall: (
    functionCall: AgentFunctionCall
  ) => Promise<{ success: boolean; result?: string; error?: string }>;
  onFunctionCallResult?: (args: {
    functionCall: AgentFunctionCall;
    result: { success: boolean; result?: string; error?: string };
  }) => void;
  logError: (...args: unknown[]) => void;
}

export async function processFunctionCalls(
  params: ProcessFunctionCallsParams
): Promise<boolean> {
  const { functionCalls, detectLoop } = params;

  const loopDetected = detectLoop(functionCalls);
  if (handleLoopDetection(loopDetected, params)) {
    return true;
  }

  await executeFunctionCallsSequence(params);

  return false;
}

function handleLoopDetection(
  loopDetected: AgentLoopDetected | null,
  context: Pick<
    ProcessFunctionCallsParams,
    'requestSeq' | 'mutateLastAssistant' | 'logError'
  >
): boolean {
  if (!loopDetected) return false;

  const { requestSeq, mutateLastAssistant, logError } = context;

  const prettyArgs = JSON.stringify(loopDetected.args, null, 2);
  logError(`🔴 Infinite loop detected: ${loopDetected.signature}`);

  mutateLastAssistant(
    (prev) =>
      prev +
      `\n\n---\n\n### ⚠️ Infinite Loop Detected\n\n` +
      `The agent is stuck repeating the same action:\n\n` +
      `**Function:** \`${loopDetected.functionName}\`\n` +
      `**Arguments:**\n\`\`\`json\n${prettyArgs}\n\`\`\`\n\n` +
      `**Root Causes:**\n` +
      `- The previous function result was not understood correctly\n` +
      `- The function succeeded but the agent misinterpreted the output\n` +
      `- The error requires a different action (e.g., code fix instead of library search)\n` +
      `- A prerequisite step is missing\n\n` +
      `**Action Taken:** Stopped to prevent wasted API calls.\n\n` +
      `**Recommendation:** Rephrase your request or manually perform the action.\n`,
    requestSeq
  );

  return true;
}

async function executeFunctionCallsSequence(
  params: ProcessFunctionCallsParams
): Promise<void> {
  const {
    functionCalls,
    actionHistory,
    conversationHistory,
    requestSeq,
    shouldAbort,
    mutateLastAssistant,
    executeFunctionCall,
    onFunctionCallResult,
    logError,
  } = params;

  const multipleActions = functionCalls.length > 1;

  if (multipleActions) {
    showMultipleActionsHeader(
      functionCalls.length,
      requestSeq,
      mutateLastAssistant
    );
  }

  for (const functionCall of functionCalls) {
    if (shouldAbort()) {
      return;
    }

    showFunctionExecution(
      functionCall.name,
      multipleActions,
      requestSeq,
      mutateLastAssistant
    );

    const result = await executeWithErrorHandling(
      functionCall,
      executeFunctionCall,
      logError
    );
    updateActionHistory(actionHistory, functionCall.name, result);
    displayExecutionResult(result, requestSeq, mutateLastAssistant);
    addToConversationHistory(conversationHistory, functionCall, result);
    onFunctionCallResult?.({ functionCall, result });
  }
}

function showMultipleActionsHeader(
  count: number,
  requestSeq: number,
  mutateLastAssistant: MutateLastAssistant
): void {
  const functionSection = `\n**Executing ${count} actions...**\n\n`;
  mutateLastAssistant((prev) => {
    const separator = prev.trim() ? '\n\n' : '';
    return prev + separator + functionSection;
  }, requestSeq);
}

function showFunctionExecution(
  functionName: string,
  multipleActions: boolean,
  requestSeq: number,
  mutateLastAssistant: MutateLastAssistant
): void {
  const functionDisplay = formatFunctionExecution(
    functionName,
    multipleActions
  );
  mutateLastAssistant((prev) => {
    const separator = prev.trim() && !prev.endsWith('\n\n') ? '\n' : '';
    return prev + separator + functionDisplay;
  }, requestSeq);
}

function formatFunctionExecution(
  functionName: string,
  multipleActions: boolean
): string {
  const funcIcon = RenderingHelpers.getFunctionIcon(functionName);
  const funcLabel = RenderingHelpers.getFunctionLabel(functionName);
  const prefix = multipleActions ? '' : '\n';
  return `${prefix}${funcIcon} ${funcLabel}...`;
}

async function executeWithErrorHandling(
  functionCall: AgentFunctionCall,
  executeFunctionCall: (
    functionCall: AgentFunctionCall
  ) => Promise<{ success: boolean; result?: string; error?: string }>,
  logError: (...args: unknown[]) => void
): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    return await executeFunctionCall(functionCall);
  } catch (funcError) {
    logError(`Function ${functionCall.name} threw error:`, funcError);
    return {
      success: false,
      error: funcError instanceof Error ? funcError.message : String(funcError),
    };
  }
}

function updateActionHistory(
  actionHistory: AgentActionHistoryRecord[],
  functionName: string,
  result: { success: boolean; result?: string; error?: string }
): void {
  const lastAction = actionHistory[actionHistory.length - 1];
  if (lastAction && lastAction.functionName === functionName) {
    lastAction.result = result;
  }
}

function displayExecutionResult(
  result: { success: boolean; error?: string },
  requestSeq: number,
  mutateLastAssistant: MutateLastAssistant
): void {
  if (result.success) {
    mutateLastAssistant((prev) => prev + ' ✓\n', requestSeq);
  } else {
    const errorMsg = result.error || 'Unknown error';
    const shortError =
      errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg;
    mutateLastAssistant((prev) => prev + ` ✗ (${shortError})\n`, requestSeq);
  }
}

function addToConversationHistory(
  conversationHistory: ConversationHistoryItem[],
  functionCall: AgentFunctionCall,
  result: { success: boolean; result?: string; error?: string }
): void {
  const { name: functionName, id: callId } = functionCall;
  const functionResponse: FunctionResponse = {
    success: result.success,
    result: result.result,
    error: result.error,
    status: result.success
      ? `✅ SUCCESS: Function ${functionName} completed successfully.`
      : `❌ FAILED: Function ${functionName} failed. Error: ${
          result.error || 'Unknown error'
        }`,
    instruction: result.success
      ? `This function succeeded. DO NOT call it again. Move to the next step or finish.`
      : `This function failed. Analyze the error and try a DIFFERENT approach. DO NOT retry the same function with the same arguments.`,
  };

  conversationHistory.push({
    role: 'function',
    name: functionName,
    callId,
    response: functionResponse,
  });
}
