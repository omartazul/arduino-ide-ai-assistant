import {
  FunctionCall,
  SpectreAiRequest,
  SpectreAiResponse,
} from '../common/protocol/spectre-ai-service';
import { TIMING_CONSTANTS, spectreWarn } from '../common/protocol/spectre-types';

export function buildStreamingTools(
  request: SpectreAiRequest | undefined,
  disableGoogleSearch: boolean | undefined
): any[] {
  const tools: any[] = [];

  if (request?.enableAgentMode === true && request.functionDeclarations) {
    const functionDeclarations = request.functionDeclarations.map((fn) => ({
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    }));

    tools.push({ functionDeclarations });
    return tools;
  }

  if (!disableGoogleSearch && request?.enableGoogleSearch !== false) {
    tools.push({ googleSearch: {} });
  }

  return tools;
}

export function buildConversationContents(context: any, userInput: string): any[] {
  const rawContents = getRawConversationContents(context);
  appendUserInput(rawContents, userInput);
  return normalizeContents(rawContents);
}

function getRawConversationContents(context: any): any[] {
  const rawContents: any[] = [];
  if (!context?.conversation || context.conversation.length === 0) {
    return rawContents;
  }

  for (const msg of context.conversation) {
    const converted = convertMessageToRaw(msg);
    if (converted) {
      rawContents.push(converted);
    }
  }

  return rawContents;
}

function convertMessageToRaw(msg: any): any | undefined {
  if ('text' in msg) {
    return { role: msg.role, parts: [{ text: msg.text }] };
  }

  if ('parts' in msg && Array.isArray(msg.parts)) {
    return { role: msg.role, parts: msg.parts };
  }

  return undefined;
}

function appendUserInput(rawContents: any[], userInput: string): void {
  if (userInput && userInput.trim().length > 0) {
    rawContents.push({ role: 'user', parts: [{ text: userInput }] });
  }
}

export function normalizeContents(rawContents: any[]): any[] {
  const contents: any[] = [];
  for (const msg of rawContents) {
    if (contents.length === 0 && msg.role !== 'user') {
      continue;
    }

    if (contents.length === 0) {
      contents.push(msg);
      continue;
    }

    const last = contents[contents.length - 1];
    if (last.role === msg.role) {
      last.parts = [...last.parts, ...msg.parts];
    } else {
      contents.push(msg);
    }
  }
  return contents;
}

export function startStreamInactivityMonitor(
  controller: AbortController,
  key: string,
  getLastChunkTime: () => number
): () => void {
  const handle = setInterval(() => {
    const inactiveMs = Date.now() - getLastChunkTime();
    if (inactiveMs <= TIMING_CONSTANTS.STREAM_INACTIVITY_TIMEOUT) {
      return;
    }
    spectreWarn(`[Spectre AI] Stream inactive for ${inactiveMs}ms, aborting request`);
    controller.abort();
    clearInterval(handle);
  }, 5000);

  return () => {
    clearInterval(handle);
  };
}

export async function consumeStream(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: AsyncIterable<any>;
  controller: AbortController;
  onChunk: () => void;
  onDelta: (delta: string) => void;
}): Promise<{ full: string; lastChunk: any; hasFunctionCalls: boolean }> {
  const { response, controller, onChunk, onDelta } = params;

  let full = '';
  let lastChunk: any;
  let hasFunctionCalls = false;

  for await (const chunk of response) {
    if (controller.signal.aborted) break;
    lastChunk = chunk;
    onChunk();

    const parts = getPartsFromChunk(chunk);
    hasFunctionCalls = updateHasFunctionCalls(hasFunctionCalls, parts);

    const textDelta = getTextDeltaForChunk(chunk, parts, hasFunctionCalls);
    if (!textDelta) {
      continue;
    }

    full += textDelta;
    onDelta(textDelta);
  }

  return { full, lastChunk, hasFunctionCalls };
}

function getPartsFromChunk(chunk: any): any[] {
  return chunk?.candidates?.[0]?.content?.parts || [];
}

function updateHasFunctionCalls(prev: boolean, parts: any[]): boolean {
  return prev || hasAnyFunctionCalls(parts);
}

function getTextDeltaForChunk(chunk: any, parts: any[], hasFunctionCalls: boolean): string {
  return extractTextDelta(chunk, parts, hasFunctionCalls);
}

export function buildStreamingResponse(
  endpointModel: string,
  full: string,
  lastChunk: any
): SpectreAiResponse {
  const candidate = lastChunk?.candidates?.[0];
  const usage = lastChunk?.usageMetadata;
  const parts = candidate?.content?.parts || [];

  const functionCalls = extractFunctionCalls(parts);
  const meta = buildStreamingMeta(endpointModel, usage, candidate);

  return {
    text: full,
    functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
    parts,
    requiresAction: functionCalls.length > 0,
    meta,
  };
}

function buildStreamingMeta(endpointModel: string, usage: any, candidate: any) {
  return {
    model: endpointModel,
    promptTokens: getUsageToken(usage, 'promptTokenCount'),
    candidatesTokens: getUsageToken(usage, 'candidatesTokenCount'),
    totalTokens: getUsageToken(usage, 'totalTokenCount'),
    finishReason: candidate?.finishReason,
    thoughtsTokens: getThinkingTokens(usage),
    usage,
    groundingMetadata: candidate?.groundingMetadata,
  };
}

function getThinkingTokens(usage: any): number | undefined {
  return (usage as any)?.thinkingTokenCount ?? (usage as any)?.thinkingTokens;
}

function getUsageToken(usage: any, key: string): number | undefined {
  return usage?.[key];
}

function hasAnyFunctionCalls(parts: any[]): boolean {
  for (const part of parts) {
    if (part.functionCall) {
      return true;
    }
  }
  return false;
}

function extractTextDelta(chunk: any, parts: any[], hasFunctionCalls: boolean): string {
  if (!hasFunctionCalls) {
    return chunk.text || '';
  }

  let delta = '';
  for (const part of parts) {
    if (part.text) {
      delta += part.text;
    }
  }
  return delta;
}

function extractFunctionCalls(parts: any[]): FunctionCall[] {
  const out: FunctionCall[] = [];
  for (const part of parts) {
    if (!part.functionCall) {
      continue;
    }
    out.push({
      name: part.functionCall.name,
      args: part.functionCall.args || {},
    });
  }
  return out;
}
