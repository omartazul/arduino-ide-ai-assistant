/**
 * Conversation history and context building helpers.
 * Handles building prompts and managing conversation state.
 *
 * @author Tazul Islam
 */

export interface ConversationMessage {
  role: 'user' | 'model' | 'function';
  text?: string;
  name?: string;
  response?: any;
}

/**
 * Builds basic mode context with sketch files.
 */
export function buildBasicModeContext(
  sketchFiles: Array<{ path: string; content: string }>
): string {
  if (!sketchFiles || sketchFiles.length === 0) {
    return '';
  }

  return sketchFiles
    .map((file) => `File: ${file.path}\n\`\`\`cpp\n${file.content}\n\`\`\``)
    .join('\n\n');
}

/**
 * Builds conversation history for API request.
 */
export function buildConversationHistory(
  memory: any,
  isBasicMode: boolean,
  sketchContext: string
): Array<{ role: 'user' | 'model'; text: string }> {
  const history: Array<{ role: 'user' | 'model'; text: string }> = [];

  // Add sketch context as first user message in basic mode
  if (isBasicMode && sketchContext) {
    history.push({
      role: 'user',
      text: `Current sketch context:\n${sketchContext}`,
    });
    history.push({
      role: 'model',
      text: 'I understand the sketch context. How can I help?',
    });
  }

  // Add conversation memory
  if (memory && memory.messages) {
    for (const msg of memory.messages) {
      if (msg.role === 'user' || msg.role === 'model') {
        history.push({
          role: msg.role,
          text: msg.text || '',
        });
      }
    }
  }

  return history;
}

/**
 * Builds conversation context object for API.
 */
export function buildConversationContext(
  conversationHistory: Array<{ role: 'user' | 'model'; text: string }>
) {
  return {
    history: conversationHistory.map((msg) => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }],
    })),
  };
}

/**
 * Creates generation config for API request.
 */
export function createGenerationConfig(
  isBasicMode: boolean,
  characterLimit: number
) {
  return {
    maxOutputTokens: characterLimit,
    temperature: 0.7,
    topP: 0.95,
    topK: isBasicMode ? 40 : 64,
  };
}

/**
 * Gets model-specific generation config.
 */
export function getModelGenerationConfig(model: string) {
  if (model === 'gemini-2.0-flash-exp') {
    return {
      temperature: 0.7,
      topP: 0.95,
      topK: 64,
    };
  }
  return {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
  };
}

/**
 * Checks if model requires thoughts inclusion.
 */
export function shouldIncludeThoughts(model: string): boolean {
  return model === 'gemini-2.5-flash-lite';
}

/**
 * Adds response to conversation history.
 */
export function addResponseToHistory(
  response: any,
  conversationHistory: ConversationMessage[],
  responseText?: string
): void {
  if (response.functionCalls && response.functionCalls.length > 0) {
    conversationHistory.push({
      role: 'model',
      text: responseText,
      response: {
        functionCalls: response.functionCalls,
      },
    });
  } else if (responseText) {
    conversationHistory.push({
      role: 'model',
      text: responseText,
    });
  }
}

/**
 * Builds iteration prompt for ReAct loop.
 */
export function buildIterationPrompt(iteration: number, originalText: string): string {
  if (iteration === 0) {
    return originalText;
  }
  return `Continue with the task. Previous iteration: ${iteration}`;
}

/**
 * Formats function execution result.
 */
export function formatFunctionExecution(
  functionName: string,
  args: any,
  result: string
): string {
  const argsStr = JSON.stringify(args, null, 2);
  return `Function: ${functionName}\nArguments: ${argsStr}\nResult: ${result}`;
}

/**
 * Cleans agent response by removing redundant information.
 */
export function cleanAgentResponse(
  responseText: string | undefined,
  functionCalls: any[] | undefined
): string {
  if (!responseText) {
    return '';
  }

  let cleaned = responseText;

  // Remove function call echoes if agent executed functions
  if (functionCalls && functionCalls.length > 0) {
    // Remove lines that just echo function names
    const functionNames = functionCalls.map((fc) => fc.name).join('|');
    const echoPattern = new RegExp(
      `\\b(${functionNames})\\s*\\([^)]*\\)`,
      'gi'
    );
    cleaned = cleaned.replace(echoPattern, '');

    // Remove "calling function X" announcements
    cleaned = cleaned.replace(
      /(?:calling|executing|running)\s+(?:function\s+)?[\w_]+/gi,
      ''
    );
  }

  // Remove excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}
