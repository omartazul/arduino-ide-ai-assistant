/**
 * Agent-mode orchestration helpers (function-calling, ReAct loop, loop detection).
 *
 * @author Tazul Islam
 */

import type {
  SpectreAiService,
  SpectreAiResponse,
} from '../../../common/protocol/spectre-ai-service';
import {
  spectreError,
  spectreWarn,
} from '../../../common/protocol/spectre-types';
import type { MemoryManager } from '../memory/memory-manager';
import type { ChatSession } from '../ui/widget-rendering';
import { cleanAgentResponse } from './agent-utils';
import { AgentTask } from './agent-utils';
import { formatCompletionMessage } from './completion';
import * as FunctionCallRunner from './function-call-runner';
import * as ReactLoop from './react-loop';
import { createLoopDetector, LoopDetectorActionRecord } from './loop-detector';
import {
  buildSketchContext,
  type SketchFile,
} from '../feature/sketch-utilities';
import { AgentActionHistoryRecord } from './agent-utils';

type TaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed';

function rankStatus(status: TaskStatus): number {
  switch (status) {
    case 'pending':
      return 0;
    case 'in-progress':
      return 1;
    case 'completed':
      return 2;
    case 'failed':
      return 3;
  }
}

function buildActionTypeMap(existingTasks: AgentTask[] | undefined): Map<string, AgentTask> {
  const byActionType = new Map<string, AgentTask>();
  const list = existingTasks || [];
  for (const task of list) {
    const key = (task.actionType || '').toLowerCase();
    if (!key || key === 'task') {
      continue;
    }
    byActionType.set(key, task);
  }
  return byActionType;
}

function mergeTaskWithPrior(task: AgentTask, prior: AgentTask | undefined): AgentTask {
  if (!prior) {
    return task;
  }

  const chosenStatus =
    rankStatus(prior.status) >= rankStatus(task.status) ? prior.status : task.status;

  return {
    ...task,
    status: chosenStatus,
    error: prior.error || task.error,
    startTime: prior.startTime || task.startTime,
    endTime: prior.endTime || task.endTime,
  };
}

function mergeTasksByActionType(params: {
  existing: AgentTask[] | undefined;
  incoming: AgentTask[];
}): AgentTask[] {
  const { existing, incoming } = params;
  const byActionType = buildActionTypeMap(existing);

  return incoming.map((task) => {
    const key = (task.actionType || '').toLowerCase();
    if (!key) {
      return task;
    }
    const prior = byActionType.get(key);
    if (!prior) {
      return task;
    }
    return mergeTaskWithPrior(task, prior);
  });
}

function updateTasksAfterFunctionCall(params: {
  tasks: AgentTask[] | undefined;
  functionName: string;
  result: { success: boolean; error?: string };
}): AgentTask[] | undefined {
  const { tasks, functionName, result } = params;
  if (!tasks || tasks.length === 0) {
    return tasks;
  }

  const fn = functionName.toLowerCase();
  const errorMessage = result.error || 'Unknown error';

  let changed = false;
  const updated = tasks.map((task) => {
    const actionType = (task.actionType || '').toLowerCase();

    // Deterministic matching only: tasks must declare their actionType.
    // (Older sessions still work because parsing falls back to an inferred actionType.)
    const matches = actionType && actionType !== 'task' && actionType !== 'manual' && actionType === fn;
    if (!matches) {
      return task;
    }

    changed = true;

    if (result.success) {
      return {
        ...task,
        status: 'completed' as const,
        error: undefined,
        endTime: Date.now(),
      };
    }

    return {
      ...task,
      status: 'failed' as const,
      error: errorMessage,
      endTime: Date.now(),
    };
  });

  return changed ? updated : tasks;
}
function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function appendToAssistant(params: {
  deps: AgentModeDeps;
  requestSeq: number;
  text: string;
  withSeparator?: boolean;
}): Promise<void> {
  const { deps, requestSeq, text, withSeparator = true } = params;
  await deps.mutateLastAssistant((prev) => {
    if (!withSeparator) {
      return prev + text;
    }
    const separator = prev.trim() ? '\n\n' : '';
    return prev + separator + text;
  }, requestSeq);
}

export interface FunctionCallingParams {
  text: string;
  requestSeq: number;
  abortKey: string;
  model: string;
  sketchFiles: SketchFile[];
  thinkingLevel?: string;
  enableGoogleSearch?: boolean;
}

export interface ProcessFunctionCallsParams {
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
  detectLoop: (
    calls: Array<{ name: string; args: Record<string, unknown> }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => any;
  actionHistory: Array<LoopDetectorActionRecord>;
  conversationHistory: Array<{
    role: 'user' | 'model' | 'function';
    text?: string;
    name?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response?: any;
  }>;
  requestSeq: number;
}

export interface AgentModeStateData {
  sessions: ChatSession[];
  active: number;
  requestSeq: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: any[];
  tasksExpanded: boolean;
  tasksClosed: boolean;
  busy?: boolean;
  currentAbortKey?: string;
  error?: string;
}

export interface AgentModeDeps {
  ai: SpectreAiService;
  memoryManager: MemoryManager;
  stateData: AgentModeStateData;
  getStateData: () => AgentModeStateData;

  // UI/state hooks
  setStateData: (patch: Partial<AgentModeStateData>) => void;
  appendAssistant: (text: string, requestSeq: number) => Promise<void>;
  mutateLastAssistant: (
    mutator: (text: string) => string,
    requestSeq: number
  ) => Promise<void>;
  focusInput: () => void;
  persist: () => void;
  deferScroll: () => void;

  // memory persistence/stats
  saveSessionMemory: (sessionId: number) => void;
  updateMemoryStats: () => void;

  // function call execution
  executeFunctionCall: (functionCall: {
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: Record<string, any>;
  }) => Promise<{ success: boolean; result?: string; error?: string }>;
}

export async function sendMessageWithFunctionCalling(params: {
  deps: AgentModeDeps;
  input: FunctionCallingParams;
}): Promise<void> {
  const { deps, input } = params;
  const { text, requestSeq, abortKey, model, sketchFiles, thinkingLevel, enableGoogleSearch } = input;
  const MAX_ITERATIONS = 10;

  const context = await setupReActLoop({
    deps,
    text,
    sketchFiles,
    model,
    requestSeq,
  });
  let agentError: unknown = null;

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiGenerate: (genParams) =>
        deps.ai.generate({
          ...(genParams as any),
          thinkingLevel,
          enableGoogleSearch,
          includeThoughts: thinkingLevel ? thinkingLevel !== 'OFF' : false,
        } as any),
      addResponseToHistory: (response) =>
        addResponseToHistory({
          deps,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          response: response as any,
          conversationHistory: context.conversationHistory,
          requestSeq,
        }),
      processFunctionCalls: (callParams) =>
        processFunctionCalls({ deps, params: callParams }),
      handleAgentCompletion: ({ iteration, actionHistory, responseText }) =>
        handleAgentCompletion({
          deps,
          iteration,
          actionHistory,
          responseText,
          requestSeq,
        }),
      handleIterationError: ({ iteration, error }) =>
        handleIterationError({ deps, iteration, error, requestSeq }),
      displayMaxIterationsWarning: ({ maxIterations }) =>
        displayMaxIterationsWarning({ deps, maxIterations, requestSeq }),
    });
    agentError = result.error;
  } catch (outerError: unknown) {
    spectreError('Agent mode outer error:', outerError);
    const errorMessage =
      outerError instanceof Error ? outerError.message : String(outerError);
    await appendToAssistant({
      deps,
      requestSeq,
      text: `❌ **Error:** ${errorMessage}\n`,
    });
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
  conversationHistory: Array<ReactLoop.AgentConversationMessage>;
  detectLoop: (
    functionCalls: Array<{ name: string; args: Record<string, unknown> }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actionHistory: Array<any>;
}> {
  const { deps, text, sketchFiles, model, requestSeq } = params;
  const files = sketchFiles || [];
  const sketchContext = buildSketchContext(files);
  const contextualPrompt = `Here are my current Arduino sketch files:\n\n${sketchContext}\n\n**User request:** ${text}`;

  const conversationHistory = await initializeConversationMemory({
    deps,
    text,
    model: model || 'gemini-3.1-flash-lite',
    contextualPrompt,
    sketchContext,
  });

  await deps.appendAssistant('', requestSeq);
  const { detectLoop, actionHistory } = createLoopDetector({
    warn: spectreWarn,
    loopDetectionWindow: 10,
    maxIdenticalActions: 2,
  });

  return { conversationHistory, detectLoop, actionHistory };
}

async function initializeConversationMemory(params: {
  deps: AgentModeDeps;
  text: string;
  model: string;
  contextualPrompt: string;
  sketchContext: string;
}): Promise<Array<ReactLoop.AgentConversationMessage>> {
  const { deps, text, model, contextualPrompt, sketchContext } = params;

  const conversationHistory: Array<ReactLoop.AgentConversationMessage> = [];

  const session = deps.stateData.sessions[deps.stateData.active];
  if (!session) {
    conversationHistory.push({ role: 'user', text: contextualPrompt });
    return conversationHistory;
  }

  if (!session.memory) {
    session.memory = deps.memoryManager.createConversation(
      session.id.toString()
    );
  }

  await deps.memoryManager.addMessage(session.memory, 'user', contextualPrompt);
  deps.saveSessionMemory(session.id);
  deps.updateMemoryStats();

  const isFlashLite = model.includes('flash-lite');
  const targetBudget = isFlashLite ? 30_000 : 50_000;

  deps.memoryManager.assemblePrompt(session.memory, {
    currentPrompt: text,
    additionalContext: sketchContext,
    targetTokenBudget: targetBudget,
  });

  if (session.memory.memoryBank.summaries.length > 0) {
    const historicalContext = session.memory.memoryBank.summaries
      .map((s) => s.summary)
      .join('\n\n---\n\n');

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
    mutateLastAssistant: (mutator, seq) =>
      deps.mutateLastAssistant(mutator, seq),
    executeFunctionCall: (functionCall) =>
      deps.executeFunctionCall(functionCall),
    onFunctionCallResult: ({ functionCall, result }) => {
      const latest = deps.getStateData();
      const updated = updateTasksAfterFunctionCall({
        tasks: latest.tasks as AgentTask[] | undefined,
        functionName: functionCall.name,
        result,
      });
      if (updated && updated !== latest.tasks) {
        deps.setStateData({ tasks: updated as any });
      }
    },
    logError: spectreError,
  });
}

function handleAgentCompletion(params: {
  deps: AgentModeDeps;
  iteration: number;
  actionHistory: Array<AgentActionHistoryRecord>;
  responseText: string | undefined;
  requestSeq: number;
}): void {
  const { deps, iteration, requestSeq } = params;

  const completionMessage = formatCompletionMessage(iteration);

  // Idempotent: avoid appending multiple completion blocks into the same
  // assistant message if completion is triggered more than once.
  void deps.mutateLastAssistant((prev) => {
    if (prev.includes('### ✅ Agent Finished') || prev.includes('### ✅ Task Completed')) {
      return prev;
    }
    return prev + completionMessage;
  }, requestSeq);
}

function addResponseToHistory(params: {
  deps: AgentModeDeps;
  response: SpectreAiResponse;
  conversationHistory: Array<ReactLoop.AgentConversationMessage>;
  requestSeq: number;
}): void {
  const { deps, response, conversationHistory, requestSeq } = params;
  
  if (response.functionCalls && response.functionCalls.length > 0) {
    if (response.text) {
      conversationHistory.push({ role: 'model', text: response.text, functionCalls: response.functionCalls });
    } else {
      conversationHistory.push({ role: 'model', functionCalls: response.functionCalls });
    }
  } else if (response.text) {
    conversationHistory.push({ role: 'model', text: response.text });
  }

  if (!response.text) {
    return;
  }

  const { cleanText, tasks } = cleanAgentResponse({
    responseText: response.text,
    thoughtsTokens: response.meta?.thoughtsTokens,
  });

  if (tasks.length > 0) {
    const latest = deps.getStateData();
    const merged = mergeTasksByActionType({
      existing: latest.tasks as AgentTask[] | undefined,
      incoming: tasks,
    });
    deps.setStateData({
      tasks: merged as any,
      tasksExpanded: false,
      tasksClosed: false,
    });
  }

  if (cleanText.trim()) {
    void appendToAssistant({ deps, requestSeq, text: cleanText });
  }
}

function handleIterationError(params: {
  deps: AgentModeDeps;
  iteration: number;
  error: unknown;
  requestSeq: number;
}): void {
  const { deps, iteration, error, requestSeq } = params;
  spectreError(`Agent iteration ${iteration} error:`, error);
  void appendToAssistant({
    deps,
    requestSeq,
    text: `⚠️ **Error in iteration ${iteration}:** ${formatUnknownError(
      error
    )}\n`,
  });
}

function displayMaxIterationsWarning(params: {
  deps: AgentModeDeps;
  maxIterations: number;
  requestSeq: number;
}): void {
  const { deps, maxIterations, requestSeq } = params;
  void appendToAssistant({
    deps,
    requestSeq,
    text: `---\n\n### ⚠️ Maximum Iterations Reached\n\nStopped after **${maxIterations}** iterations for safety.\n`,
  });
}

function finalizeAgent(params: {
  deps: AgentModeDeps;
  agentError: unknown;
}): void {
  const { deps, agentError } = params;
  try {
    deps.setStateData({
      busy: false,
      currentAbortKey: undefined,
      error: agentError
        ? agentError instanceof Error
          ? agentError.message
          : String(agentError)
        : undefined,
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
