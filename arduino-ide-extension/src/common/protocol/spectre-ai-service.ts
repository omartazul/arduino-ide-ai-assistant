/**
 * Protocol definitions for Spectre AI service.
 * Defines request/response contracts and RPC interfaces.
 *
 * @author Tazul Islam
 */

import { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

/**
 * Service path for JSON-RPC communication between frontend and backend.
 */
export const SpectreAiServicePath = '/services/spectre-ai';

/**
 * DI token for the Spectre AI service.
 */
export const SpectreAiService = Symbol('SpectreAiService');

/**
 * Function parameter schema for Gemini function calling.
 */
export interface FunctionParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: FunctionParameter;
  properties?: Record<string, FunctionParameter>;
  required?: string[];
}

/**
 * Function declaration for Gemini function calling.
 * Defines an available tool/action that the AI can invoke.
 */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: FunctionParameter;
}

/**
 * Function call made by the AI during generation.
 */
export interface FunctionCall {
  name: string;
  args: Record<string, any>;
  id?: string;
  thoughtSignature?: string;
  thought_signature?: string;
}

/**
 * Request contract for Spectre AI generation.
 *
 * @property prompt - The user's input text or question
 * @property model - Gemini/Gemma model selection
 * @property includeThoughts - Whether to include AI's thinking process in response
 * @property context - Additional context for the AI (files, conversation history)
 * @property abortKey - Unique key to cancel this specific request
 * @property generationConfig - Advanced generation parameters (temperature, tokens, etc.)
 * @property thinkingLevel - Requested thinking level for supported models
 * @property safetySettings - Content safety filters
 * @property enableGoogleSearch - Enable Google Search grounding for real-time information
 * @property enableAgentMode - Enable autonomous agent mode with function calling
 * @property functionDeclarations - Available functions for agent mode (if not provided, backend uses defaults)
 */
export type SpectreThinkingLevel = 'OFF' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface SpectreAiRequest {
  prompt: string;
  model?: 'gemini-3.1-flash-lite' | 'gemma-4-31b' | 'gemma-4-26b';
  includeThoughts?: boolean;
  context?: {
    files?: Array<{ path: string; content: string }>;
    conversation?: Array<
      | { role: 'user' | 'model'; text?: string; parts?: any[] }
      | {
          role: 'function';
          parts: Array<{ functionResponse: { name: string; response: any } }>;
        }
    >;
  };
  abortKey?: string;
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
  };
  thinkingLevel?: SpectreThinkingLevel;
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
  enableGoogleSearch?: boolean;
  enableAgentMode?: boolean;
  enforceFunctionCalling?: boolean;
  functionDeclarations?: FunctionDeclaration[];
}

/**
 * Response from Spectre AI generation.
 *
 * @property text - The generated text response
 * @property functionCalls - Function calls requested by the AI (agent mode only)
 * @property requiresAction - True if AI wants to execute functions and continue
 * @property meta - Optional metadata about the generation (tokens, timing, etc.)
 */
export interface SpectreAiResponse {
  text: string;
  parts?: any[];
  functionCalls?: FunctionCall[];
  requiresAction?: boolean;
  meta?: {
    model?: string;
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
    finishReason?: string;
    thoughtSummary?: string;
    thoughtsTokens?: number;
    usage?: unknown;
    queuedMs?: number;
    usedReservation?: number;
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{
        web: { uri: string; title: string };
      }>;
      groundingSupports?: Array<{
        segment: {
          startIndex: number;
          endIndex: number;
          text: string;
        };
        groundingChunkIndices: number[];
      }>;
    };
  };
}

/**
 * Rolling quota and rate limit status update pushed from backend.
 * Provides real-time tracking of API usage and availability.
 *
 * @property usedTokens - Total tokens used in current rolling window
 * @property capacity - Maximum token capacity for the rolling window
 * @property rpmUsed - Requests per minute used
 * @property rpmLimit - Maximum requests per minute allowed
 * @property queued - Number of requests currently queued
 * @property nextAvailableMs - Timestamp when next request slot becomes available
 */
export interface SpectreQuotaUpdate {
  usedTokens: number;
  capacity: number;
  rpmUsed: number;
  rpmLimit: number;
  queued: number;
  nextAvailableMs: number;
}

/**
 * Backend service interface for Spectre AI operations.
 * Handles AI generation, streaming, quota management, and client lifecycle.
 * Extends RpcServer to enable bidirectional communication with frontend clients.
 */
export interface SpectreAiService extends RpcServer<SpectreAiClient> {
  /**
   * Generates AI response for the given request.
   * Supports streaming responses via registered clients.
   * In agent mode, returns function calls for frontend to execute.
   *
   * @param request - Generation parameters and context
   * @returns Promise resolving to the complete AI response
   */
  generate(request: SpectreAiRequest): Promise<SpectreAiResponse>;

  /**
   * Registers a client to receive streaming updates and quota notifications.
   * Called automatically when frontend establishes connection.
   *
   * @param client - Frontend client implementation
   */
  setClient(client: SpectreAiClient): void;

  /**
   * Unregisters a client when connection is closed.
   * Ensures proper cleanup of resources.
   *
   * @param client - Frontend client to remove
   */
  disposeClient(client: SpectreAiClient): void;

  /**
   * Cancels an ongoing generation request.
   *
   * @param abortKey - Unique key identifying the request to cancel
   */
  cancel(abortKey: string): Promise<void>;

  /**
   * Fetches current quota and rate limit status.
   *
   * @param model - Optional model to query (defaults to active queue or flash)
   * @returns Promise resolving to current quota state
   */
  getQuota(model?: string): Promise<SpectreQuotaUpdate>;
}

/**
 * Frontend client interface for receiving backend notifications.
 * Implements callback methods for streaming responses and quota updates.
 */
export interface SpectreAiClient {
  /**
   * Callback invoked for each streaming response chunk.
   *
   * @param event - Stream event containing text delta, completion status, or error
   * @param event.key - Unique request identifier
   * @param event.delta - Text chunk (if streaming)
   * @param event.done - True when generation completes
   * @param event.error - Error message (if generation fails)
   */
  onStream(event: {
    key: string;
    delta?: string;
    done?: boolean;
    error?: string;
  }): void;

  /**
   * Callback invoked when quota or rate limit status changes.
   *
   * @param update - Updated quota and rate limit information
   */
  onQuota(update: SpectreQuotaUpdate): void;
}
