/**
 * ReAct loop runner for Spectre agent mode.
 *
 * @author Tazul Islam
 */

export type AgentConversationMessage =
  | { role: 'user' | 'model'; text: string }
  | { role: 'function'; name: string; response: any };

export type DetectLoopFn = (
  functionCalls: Array<{ name: string; args: any }>
) => any;

export type AiGenerateFn = (params: {
  prompt: string;
  model: any;
  enableAgentMode: true;
  context: any;
  generationConfig: { maxOutputTokens: number; topP: number };
  abortKey: string | undefined;
}) => Promise<any>;

export async function executeReActLoop(params: {
    text: string;
    requestSeq: number;
    abortKey: string | undefined;
    model: string | undefined;
    maxIterations: number;
    conversationHistory: Array<AgentConversationMessage>;
    detectLoop: DetectLoopFn;
    actionHistory: Array<any>;
    shouldAbort: () => boolean;
    aiGenerate: AiGenerateFn;
    addResponseToHistory: (response: any) => void;
    processFunctionCalls: (args: {
      functionCalls: Array<{ name: string; args: any }>;
      detectLoop: DetectLoopFn;
      actionHistory: Array<any>;
      conversationHistory: Array<AgentConversationMessage>;
      requestSeq: number;
    }) => Promise<boolean>;
    handleAgentCompletion: (args: {
      iteration: number;
      actionHistory: Array<any>;
      responseText: string | undefined;
    }) => void;
    handleIterationError: (args: {
      iteration: number;
      error: any;
    }) => void;
    displayMaxIterationsWarning: (args: { maxIterations: number }) => void;
}): Promise<{ error: any | null }> {
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
    let capturedError: any = null;

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
    actionHistory: Array<any>;
    aiGenerate: AiGenerateFn;
    addResponseToHistory: (response: any) => void;
    processFunctionCalls: (args: {
      functionCalls: Array<{ name: string; args: any }>;
      detectLoop: DetectLoopFn;
      actionHistory: Array<any>;
      conversationHistory: Array<AgentConversationMessage>;
      requestSeq: number;
    }) => Promise<boolean>;
    handleAgentCompletion: (args: {
      iteration: number;
      actionHistory: Array<any>;
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
      model: model as any,
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
        }) as any,
      },
      generationConfig: { maxOutputTokens: 65536, topP: 0.9 },
      abortKey,
    });

    addResponseToHistory(response);

    if (requiresFunctionCalling(response)) {
      return await processFunctionCalls({
        functionCalls: response.functionCalls!,
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
      : 'Continue with the next step based on the function results above. If all tasks are complete, respond with confirmation and no function calls.';
}

function requiresFunctionCalling(response: any): boolean {
    return !!(response.functionCalls && response.functionCalls.length > 0);
}
