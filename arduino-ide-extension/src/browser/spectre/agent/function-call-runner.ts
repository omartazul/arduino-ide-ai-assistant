import * as RenderingHelpers from '../ui/rendering-helpers';

export type AgentFunctionCall = { name: string; args: Record<string, any> };

export type AgentActionHistoryRecord = {
  functionName: string;
  result?: { success: boolean; error?: string };
};

export type AgentLoopDetected = {
  signature: string;
  functionName: string;
  args: any;
};

export type MutateLastAssistant = (
  mutator: (prev: string) => string,
  requestSeq: number
) => void;

export async function processFunctionCalls(params: {
  functionCalls: AgentFunctionCall[];
  detectLoop: (calls: AgentFunctionCall[]) => AgentLoopDetected | null;
  actionHistory: AgentActionHistoryRecord[];
  conversationHistory: Array<any>;
  requestSeq: number;
  shouldAbort: () => boolean;
  mutateLastAssistant: MutateLastAssistant;
  executeFunctionCall: (
    functionCall: AgentFunctionCall
  ) => Promise<{ success: boolean; result?: string; error?: string }>;
  logError: (...args: any[]) => void;
}): Promise<boolean> {
  const {
    functionCalls,
    detectLoop,
    actionHistory,
    conversationHistory,
    requestSeq,
    shouldAbort,
    mutateLastAssistant,
    executeFunctionCall,
    logError,
  } = params;

  const loopDetected = detectLoop(functionCalls);
  if (handleLoopDetection(loopDetected, requestSeq, mutateLastAssistant, logError)) {
    return true;
  }

  await executeFunctionCallsSequence({
    functionCalls,
    actionHistory,
    conversationHistory,
    requestSeq,
    shouldAbort,
    mutateLastAssistant,
    executeFunctionCall,
    logError,
  });

  return false;
}

function handleLoopDetection(
  loopDetected: AgentLoopDetected | null,
  requestSeq: number,
  mutateLastAssistant: MutateLastAssistant,
  logError: (...args: any[]) => void
): boolean {
  if (!loopDetected) return false;

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

async function executeFunctionCallsSequence(params: {
  functionCalls: AgentFunctionCall[];
  actionHistory: AgentActionHistoryRecord[];
  conversationHistory: Array<any>;
  requestSeq: number;
  shouldAbort: () => boolean;
  mutateLastAssistant: MutateLastAssistant;
  executeFunctionCall: (
    functionCall: AgentFunctionCall
  ) => Promise<{ success: boolean; result?: string; error?: string }>;
  logError: (...args: any[]) => void;
}): Promise<void> {
  const {
    functionCalls,
    actionHistory,
    conversationHistory,
    requestSeq,
    shouldAbort,
    mutateLastAssistant,
    executeFunctionCall,
    logError,
  } = params;

  const multipleActions = functionCalls.length > 1;

  if (multipleActions) {
    showMultipleActionsHeader(functionCalls.length, requestSeq, mutateLastAssistant);
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

    const result = await executeWithErrorHandling(functionCall, executeFunctionCall, logError);
    updateActionHistory(actionHistory, functionCall.name, result);
    displayExecutionResult(result, requestSeq, mutateLastAssistant);
    addToConversationHistory(conversationHistory, functionCall.name, result);
  }
}

function showMultipleActionsHeader(
  count: number,
  requestSeq: number,
  mutateLastAssistant: MutateLastAssistant
): void {
  const functionSection = `\n**Executing ${count} actions...**\n\n`;
  mutateLastAssistant(
    (prev) => {
      const separator = prev.trim() ? '\n\n' : '';
      return prev + separator + functionSection;
    },
    requestSeq
  );
}

function showFunctionExecution(
  functionName: string,
  multipleActions: boolean,
  requestSeq: number,
  mutateLastAssistant: MutateLastAssistant
): void {
  const functionDisplay = formatFunctionExecution(functionName, multipleActions);
  mutateLastAssistant(
    (prev) => {
      const separator = prev.trim() && !prev.endsWith('\n\n') ? '\n' : '';
      return prev + separator + functionDisplay;
    },
    requestSeq
  );
}

function formatFunctionExecution(functionName: string, multipleActions: boolean): string {
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
  logError: (...args: any[]) => void
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
  result: any
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
  conversationHistory: Array<{ role: string; name?: string; response?: any }>,
  functionName: string,
  result: { success: boolean; result?: string; error?: string }
): void {
  const functionResponse = {
    success: result.success,
    result: result.result,
    error: result.error,
    status: result.success
      ? `✅ SUCCESS: Function ${functionName} completed successfully.`
      : `❌ FAILED: Function ${functionName} failed. Error: ${result.error || 'Unknown error'}`,
    instruction: result.success
      ? `This function succeeded. DO NOT call it again. Move to the next step or finish.`
      : `This function failed. Analyze the error and try a DIFFERENT approach. DO NOT retry the same function with the same arguments.`,
  };

  conversationHistory.push({
    role: 'function',
    name: functionName,
    response: functionResponse,
  });
}
