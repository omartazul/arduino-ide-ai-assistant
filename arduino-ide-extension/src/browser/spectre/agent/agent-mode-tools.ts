/**
 * Agent-mode orchestration helpers (function-calling, ReAct loop, loop detection).
 *
 * @author Tazul Islam
 */

import type { SpectreAiService } from '../../../common/protocol/spectre-ai-service';
import { spectreError, spectreWarn } from '../../../common/protocol/spectre-types';
import type { MemoryManager } from '../memory/memory-manager';
import type { ChatSession } from '../ui/widget-rendering';
import * as AgentTools from './agent-tools';
import * as FunctionCallRunner from './function-call-runner';
import * as ReactLoop from './react-loop';
import { createLoopDetector } from './loop-detector';
import { buildSketchContext, type SketchFile } from '../feature/sketch-utilities';

export interface FunctionCallingParams {
  text: string;
  requestSeq: number;
  abortKey: string;
  model: string;
  sketchFiles: SketchFile[];
}

export interface ProcessFunctionCallsParams {
  functionCalls: Array<{ name: string; args: any }>;
  detectLoop: (calls: Array<{ name: string; args: any }>) => any;
  actionHistory: Array<{
    signature: string;
    normalizedSignature: string;
    timestamp: number;
    functionName: string;
    args: any;
    result?: { success: boolean; error?: string };
  }>;
  conversationHistory: Array<{
    role: 'user' | 'model' | 'function';
    text?: string;
    name?: string;
    response?: any;
  }>;
  requestSeq: number;
}

export interface AgentModeStateData {
  sessions: ChatSession[];
  active: number;
  requestSeq: number;
  tasks: any[];
  tasksExpanded: boolean;
  tasksClosed: boolean;
}

export interface AgentModeDeps {
  ai: SpectreAiService;
  memoryManager: MemoryManager;
  stateData: AgentModeStateData;

  // UI/state hooks
  setStateData: (patch: Partial<any>) => void;
  appendAssistant: (text: string, requestSeq: number) => Promise<void>;
  mutateLastAssistant: (mutator: (text: string) => string, requestSeq: number) => Promise<void>;
  focusInput: () => void;
  persist: () => void;
  deferScroll: () => void;

  // memory persistence/stats
  saveSessionMemory: (sessionId: number) => void;
  updateMemoryStats: () => void;

  // function call execution
  executeFunctionCall: (functionCall: { name: string; args: Record<string, any> }) => Promise<{ success: boolean; result?: string; error?: string }>;
}

export async function sendMessageWithFunctionCalling(params: {
  deps: AgentModeDeps;
  input: FunctionCallingParams;
}): Promise<void> {
  const { deps, input } = params;
  const { text, requestSeq, abortKey, model, sketchFiles } = input;
  const MAX_ITERATIONS = 10;

  const context = await setupReActLoop({ deps, text, sketchFiles, model, requestSeq });
  let agentError: any = null;

  try {
    const result = await ReactLoop.executeReActLoop({
      text,
      requestSeq,
      abortKey,
      model,
      maxIterations: MAX_ITERATIONS,
      conversationHistory: context.conversationHistory,
      detectLoop: context.detectLoop,
      actionHistory: context.actionHistory,
      shouldAbort: () => requestSeq !== deps.stateData.requestSeq,
      aiGenerate: (genParams) => deps.ai.generate(genParams),
      addResponseToHistory: (response) => addResponseToHistory({ deps, response, conversationHistory: context.conversationHistory, requestSeq }),
      processFunctionCalls: (callParams) => processFunctionCalls({ deps, params: callParams }),
      handleAgentCompletion: ({ iteration, actionHistory, responseText }) =>
        handleAgentCompletion({ deps, iteration, actionHistory, responseText, requestSeq }),
      handleIterationError: ({ iteration, error }) =>
        handleIterationError({ deps, iteration, error, requestSeq }),
      displayMaxIterationsWarning: ({ maxIterations }) =>
        displayMaxIterationsWarning({ deps, maxIterations, requestSeq }),
    });
    agentError = result.error;
  } catch (outerError: any) {
    spectreError('Agent mode outer error:', outerError);
    await deps.mutateLastAssistant(
      (prev) => prev + `\n\n❌ **Error:** ${outerError?.message || String(outerError)}\n`,
      requestSeq
    );
    agentError = outerError;
  } finally {
    finalizeAgent({ deps, agentError });
  }
}

async function setupReActLoop(params: {
  deps: AgentModeDeps;
  text: string;
  sketchFiles: SketchFile[] | undefined;
  model: string | undefined;
  requestSeq: number;
}): Promise<{
  conversationHistory: Array<any>;
  detectLoop: (functionCalls: Array<{ name: string; args: any }>) => any;
  actionHistory: Array<any>;
  contextualPrompt: string;
}> {
  const { deps, text, sketchFiles, model, requestSeq } = params;
  const files = sketchFiles || [];
  const sketchContext = buildSketchContext(files);
  const contextualPrompt = `Here are my current Arduino sketch files:\n\n${sketchContext}\n\n**User request:** ${text}`;

  const conversationHistory = await initializeConversationMemory({
    deps,
    text,
    sketchFiles: files,
    model: model || 'gemini-2.0-flash-exp',
    contextualPrompt,
  });

  await deps.appendAssistant('', requestSeq);
  const { detectLoop, actionHistory } = createLoopDetector({ warn: spectreWarn });

  return { conversationHistory, detectLoop, actionHistory, contextualPrompt };
}

async function initializeConversationMemory(params: {
  deps: AgentModeDeps;
  text: string;
  sketchFiles: SketchFile[];
  model: string;
  contextualPrompt: string;
}): Promise<
  Array<{
    role: 'user' | 'model' | 'function';
    text?: string;
    name?: string;
    response?: any;
  }>
> {
  const { deps, text, sketchFiles, model, contextualPrompt } = params;

  const conversationHistory: Array<{
    role: 'user' | 'model' | 'function';
    text?: string;
    name?: string;
    response?: any;
  }> = [];

  const session = deps.stateData.sessions[deps.stateData.active];
  if (!session) {
    conversationHistory.push({ role: 'user', text: contextualPrompt });
    return conversationHistory;
  }

  if (!session.memory) {
    session.memory = deps.memoryManager.createConversation(session.id.toString());
  }

  await deps.memoryManager.addMessage(session.memory, 'user', contextualPrompt);
  deps.saveSessionMemory(session.id);
  deps.updateMemoryStats();

  const isFlashLite = model === 'gemini-2.5-flash-lite';
  const targetBudget = isFlashLite ? 30_000 : 50_000;

  const sketchContext = sketchFiles.length > 0 ? buildSketchContext(sketchFiles) : '';

  deps.memoryManager.assemblePrompt(session.memory, {
    currentPrompt: text,
    additionalContext: sketchContext,
    targetTokenBudget: targetBudget,
  });

  if (session.memory.memoryBank.summaries.length > 0) {
    const historicalContext = session.memory.memoryBank.summaries.map((s) => s.summary).join('\n\n---\n\n');

    conversationHistory.push({
      role: 'user',
      text: `[HISTORICAL CONTEXT FROM PREVIOUS CONVERSATION]:\n${historicalContext}\n\n---\n\n[CURRENT SESSION CONTINUES BELOW]`,
    });

    conversationHistory.push({
      role: 'model',
      text: 'I understand the historical context. Ready to continue our conversation.',
    });
  }

  const recentMessages = session.memory.recentMessages.slice(0, -1);
  for (const msg of recentMessages) {
    conversationHistory.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      text: msg.text,
    });
  }

  conversationHistory.push({ role: 'user', text: contextualPrompt });
  return conversationHistory;
}

async function processFunctionCalls(params: {
  deps: AgentModeDeps;
  params: ProcessFunctionCallsParams;
}): Promise<boolean> {
  const { deps, params: callParams } = params;

  return FunctionCallRunner.processFunctionCalls({
    functionCalls: callParams.functionCalls,
    detectLoop: callParams.detectLoop,
    actionHistory: callParams.actionHistory,
    conversationHistory: callParams.conversationHistory,
    requestSeq: callParams.requestSeq,
    shouldAbort: () => callParams.requestSeq !== deps.stateData.requestSeq,
    mutateLastAssistant: (mutator, seq) => deps.mutateLastAssistant(mutator, seq),
    executeFunctionCall: (functionCall) => deps.executeFunctionCall(functionCall),
    logError: spectreError,
  });
}

function handleAgentCompletion(params: {
  deps: AgentModeDeps;
  iteration: number;
  actionHistory: Array<{ result?: { success: boolean } }>;
  responseText: string | undefined;
  requestSeq: number;
}): void {
  const { deps, iteration, actionHistory, responseText, requestSeq } = params;

  if (AgentTools.taskCompletedSuccessfully({ responseText, actionHistory })) {
    const completedTasks = AgentTools.markAllTasksCompleted(deps.stateData.tasks as any);
    if (completedTasks) {
      deps.setStateData({ tasks: completedTasks });
    }
  }

  const completionMessage = AgentTools.formatCompletionMessage(iteration);
  void deps.mutateLastAssistant((prev) => prev + completionMessage, requestSeq);
}

function addResponseToHistory(params: {
  deps: AgentModeDeps;
  response: any;
  conversationHistory: Array<any>;
  requestSeq: number;
}): void {
  const { deps, response, conversationHistory, requestSeq } = params;
  if (!response.text) {
    return;
  }

  conversationHistory.push({ role: 'model', text: response.text });
  const { cleanText, tasks } = AgentTools.cleanAgentResponse({
    responseText: response.text,
    thoughtsTokens: response.meta?.thoughtsTokens,
  });

  if (tasks.length > 0) {
    deps.setStateData({ tasks, tasksExpanded: false, tasksClosed: false });
  }

  if (cleanText.trim()) {
    void deps.mutateLastAssistant(
      (prev) => {
        const separator = prev.trim() ? '\n\n' : '';
        return prev + separator + cleanText;
      },
      requestSeq
    );
  }
}

function handleIterationError(params: {
  deps: AgentModeDeps;
  iteration: number;
  error: any;
  requestSeq: number;
}): void {
  const { deps, iteration, error, requestSeq } = params;
  spectreError(`Agent iteration ${iteration} error:`, error);
  void deps.mutateLastAssistant(
    (prev) =>
      prev +
      `\n\n⚠️ **Error in iteration ${iteration}:** ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    requestSeq
  );
}

function displayMaxIterationsWarning(params: {
  deps: AgentModeDeps;
  maxIterations: number;
  requestSeq: number;
}): void {
  const { deps, maxIterations, requestSeq } = params;
  void deps.mutateLastAssistant(
    (prev) =>
      prev +
      `\n\n---\n\n### ⚠️ Maximum Iterations Reached\n\nStopped after **${maxIterations}** iterations for safety.\n`,
    requestSeq
  );
}

function finalizeAgent(params: { deps: AgentModeDeps; agentError: any }): void {
  const { deps, agentError } = params;
  try {
    deps.setStateData({
      busy: false,
      currentAbortKey: undefined,
      error: agentError ? agentError.message || String(agentError) : undefined,
    });
    deps.persist();
    deps.deferScroll();
    deps.focusInput();
  } catch (cleanupError) {
    spectreError('Agent cleanup error:', cleanupError);
    try {
      deps.setStateData({ busy: false, currentAbortKey: undefined });
    } catch {
      spectreError('Critical: Failed to reset busy state');
    }
  }
}
