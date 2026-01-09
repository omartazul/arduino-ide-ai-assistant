/**
 * ReAct loop runner for Spectre agent mode.
 *
 * @author Tazul Islam
 */

import { DetectLoopFn, LoopDetectorActionRecord } from './loop-detector';
import { AgentFunctionCall } from './function-call-runner';

export type AgentConversationMessage =
  | {
      role: 'user' | 'model';
      text: string;
      name?: undefined;
      response?: undefined;
    }
  | { role: 'function'; name: string; response: unknown; text?: undefined };

export type AiGenerateFn = (params: {
  prompt: string;
  model: string | undefined;
  enableAgentMode: true;
  context: { conversation: unknown[] };
  generationConfig: { maxOutputTokens: number; topP: number };
  abortKey: string | undefined;
}) => Promise<{
  text?: string;
  functionCalls?: AgentFunctionCall[];
}>;

export async function executeReActLoop(params: {
  text: string;
  requestSeq: number;
  abortKey: string | undefined;
  model: string | undefined;
  maxIterations: number;
  conversationHistory: Array<AgentConversationMessage>;
  detectLoop: DetectLoopFn;
  actionHistory: Array<LoopDetectorActionRecord>;
  shouldAbort: () => boolean;
  aiGenerate: AiGenerateFn;
  addResponseToHistory: (response: unknown) => void;
  processFunctionCalls: (args: {
    functionCalls: Array<AgentFunctionCall>;
    detectLoop: DetectLoopFn;
    actionHistory: Array<LoopDetectorActionRecord>;
    conversationHistory: Array<AgentConversationMessage>;
    requestSeq: number;
  }) => Promise<boolean>;
  handleAgentCompletion: (args: {
    iteration: number;
    actionHistory: Array<LoopDetectorActionRecord>;
    responseText: string | undefined;
  }) => void;
  handleIterationError: (args: { iteration: number; error: unknown }) => void;
  displayMaxIterationsWarning: (args: { maxIterations: number }) => void;
}): Promise<{ error: unknown | null }> {
  const {
    text,
    requestSeq,
    abortKey,
    model,
    maxIterations,
    conversationHistory,
    detectLoop,
    actionHistory,
    shouldAbort,
    aiGenerate,
    addResponseToHistory,
    processFunctionCalls,
    handleAgentCompletion,
    handleIterationError,
    displayMaxIterationsWarning,
  } = params;

  let iteration = 0;
  let capturedError: unknown = null;

  while (iteration < maxIterations) {
    iteration++;

    if (shouldAbort()) {
      break;
    }

    try {
      const shouldStop = await executeReActIteration({
        iteration,
        text,
        requestSeq,
        abortKey,
        model,
        conversationHistory,
        detectLoop,
        actionHistory,
        aiGenerate,
        addResponseToHistory,
        processFunctionCalls,
        handleAgentCompletion,
      });

      if (shouldStop) {
        break;
      }
    } catch (iterationError) {
      handleIterationError({ iteration, error: iterationError });
      capturedError = iterationError;
      break;
    }
  }

  if (iteration >= maxIterations) {
    displayMaxIterationsWarning({ maxIterations });
  }

  return { error: capturedError };
}

async function executeReActIteration(params: {
  iteration: number;
  text: string;
  requestSeq: number;
  abortKey: string | undefined;
  model: string | undefined;
  conversationHistory: Array<AgentConversationMessage>;
  detectLoop: DetectLoopFn;
  actionHistory: Array<LoopDetectorActionRecord>;
  aiGenerate: AiGenerateFn;
  addResponseToHistory: (response: unknown) => void;
  processFunctionCalls: (args: {
    functionCalls: Array<AgentFunctionCall>;
    detectLoop: DetectLoopFn;
    actionHistory: Array<LoopDetectorActionRecord>;
    conversationHistory: Array<AgentConversationMessage>;
    requestSeq: number;
  }) => Promise<boolean>;
  handleAgentCompletion: (args: {
    iteration: number;
    actionHistory: Array<LoopDetectorActionRecord>;
    responseText: string | undefined;
  }) => void;
}): Promise<boolean> {
  const {
    iteration,
    text,
    requestSeq,
    abortKey,
    model,
    conversationHistory,
    detectLoop,
    actionHistory,
    aiGenerate,
    addResponseToHistory,
    processFunctionCalls,
    handleAgentCompletion,
  } = params;

  const currentPrompt = buildIterationPrompt(iteration, text);

  const response = await aiGenerate({
    prompt: currentPrompt,
    model: model,
    enableAgentMode: true,
    context: {
      conversation: conversationHistory.map((m) => {
        if (m.role === 'function') {
          return {
            role: 'function' as const,
            parts: [
              {
                functionResponse: {
                  name: m.name,
                  response: m.response,
                },
              },
            ],
          };
        }

        return {
          role: m.role as 'user' | 'model',
          text: m.text || '',
        };
      }),
    },
    generationConfig: { maxOutputTokens: 65536, topP: 0.9 },
    abortKey,
  });

  addResponseToHistory(response);

  if (requiresFunctionCalling(response)) {
    return await processFunctionCalls({
      functionCalls: response.functionCalls,
      detectLoop,
      actionHistory,
      conversationHistory,
      requestSeq,
    });
  }

  handleAgentCompletion({
    iteration,
    actionHistory,
    responseText: response.text,
  });

  return true;
}

function buildIterationPrompt(iteration: number, originalText: string): string {
  return iteration === 1
    ? originalText
    : 'Continue with the next step based on the function results above. If all tasks are complete, respond with a brief completion message and no function calls.';
}

function requiresFunctionCalling(response: {
  text?: string;
  functionCalls?: AgentFunctionCall[];
}): response is { text?: string; functionCalls: AgentFunctionCall[] } {
  return !!(response.functionCalls && response.functionCalls.length > 0);
}
