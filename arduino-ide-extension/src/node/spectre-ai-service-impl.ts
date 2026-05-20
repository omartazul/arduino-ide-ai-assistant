/**
 * Backend implementation of the Spectre AI service.
 *
 * This service manages Google Gemini API interactions with sophisticated quota management,
 * request queuing, and rate limiting to ensure reliable operation within API constraints.
 *
 * Key features:
 * - Token-based quota tracking (250k INPUT tokens per minute)
 * - Rate limiting with RPM management (10 RPM for flash, 15 RPM for flash-lite)
 * - Request queuing with dynamic scheduling
 * - Streaming response support with retry logic
 * - Conversation context memory for multi-turn chats
 * - Thinking mode with configurable levels
 *
 * @author Tazul Islam
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
  SpectreAiClient,
  SpectreAiRequest,
  SpectreAiResponse,
  SpectreAiService,
  SpectreQuotaUpdate,
} from '../common/protocol/spectre-ai-service';
import { SpectreSecretsService } from '../common/protocol/spectre-secrets-service';
import {
  TIMING_CONSTANTS,
  spectreWarn,
  spectreError,
} from '../common/protocol/spectre-types';
import { AGENT_FUNCTIONS } from './spectre-agent-functions';
import {
  AGENT_MODE_INSTRUCTION,
  BASIC_MODE_INSTRUCTION,
} from './spectre-ai-instructions';
import { sanitizeForLogging } from './spectre-ai-error-utils';
import {
  buildPrompt,
  clampOutputTokens,
  delay,
  estimateTotalInputTokens,
  mapModel,
  resolveSupportedModel,
  supportsFunctionCalling,
} from './spectre-ai-request-utils';
import {
  applyThoughtSummary,
  buildStandardGenConfig,
  decideStandardGenerationRetry,
} from './spectre-ai-generation-utils';
import {
  buildConversationContents,
  buildStreamingResponse,
  buildStreamingTools,
  consumeStream,
  startStreamInactivityMonitor,
} from './spectre-ai-streaming-utils';
import { SpectreAiQuotaTracker } from './spectre-ai-quota-tracker';

/**
 * Context for standard (non-agent) generation execution.
 */
interface StandardGenerationContext {
  request: SpectreAiRequest;
  controller: AbortController;
  reservationTokens: number;
  abortKey: string;
  generationConfig: any;
  safetySettings: any;
  thinkingLevel: string | undefined;
  includeThoughts: boolean | undefined;
}

/**
 * Context for streaming API call.
 */
interface StreamingCallContext {
  sdk: GoogleGenAIType;
  apiKey: string;
  endpointModel: string;
  userInput: string;
  genConfig: any;
  safetySettings: any;
  controller: AbortController;
  key: string;
  context?: any;
  request?: SpectreAiRequest;
}

/**
 * Parameters for pacing to avoid primitive obsession by grouping related
 * primitive values into a single small object.
 */
interface PacingParams {
  model: string;
  key: string;
}

/**
 * Named parameter object for checking if a request can start immediately.
 */
interface StartNowParams {
  model: string;
  reservationTokens: number;
}

/**
 * Parameters for performGenerateContentStream helper.
 */
interface GenerateContentStreamParams {
  ai: any;
  endpointModel: string;
  contents: any[];
  systemInstruction: string;
  restGen: any;
  thinkingConfig?: any;
  tools: any[];
  safetySettings: any;
  controller: AbortController;
}

/**
 * Parameters for the generation retry helper.
 */
interface GenerationRetryParams {
  sdk: GoogleGenAIType;
  apiKey: string;
  model: string;
  userInput: string;
  genConfig: any;
  safetySettings: any;
  controller: AbortController;
  abortKey: string;
  context?: any;
  request?: SpectreAiRequest;
  reservationTokens: number;
  includeThoughts?: boolean;
}

/**
 * Extended params for the runGenerationRetryLoop method.
 */
interface RunGenerationRetryLoopParams extends GenerationRetryParams {
  maxRetries: number;
  state: RetryState;
}

/**
 * Parameters for processRetryDecision helper.
 */
interface ProcessRetryActionParams {
  decision: any;
  state: RetryState;
  abortKey: string;
}

/**
 * Parameters for logging standard generation failure events.
 */
interface LogFailureParams {
  attempt: number;
  msg: string;
  err: unknown;
}

// NOTE: Mode instructions moved to `spectre-ai-instructions.ts`.

// SDK type will be determined at runtime via dynamic import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GoogleGenAIType = any;

/**
 * Encapsulates retry state for generation attempts to avoid primitive obsession.
 * This groups related primitive flags/counts behind a simple API.
 */
class RetryState {
  attempt = 0;

  increment(): void {
    this.attempt++;
  }
}

/**
 * Context grouping for a single generation attempt to avoid primitive obsession.
 * Consolidates SDK, API key, model, user input, generation config, safety settings,
 * controller and other related parameters into a single structured object.
 */
interface GenerationAttemptContext {
  sdk: GoogleGenAIType;
  apiKey: string;
  model: string;
  userInput: string;
  genConfig: any;
  safetySettings: any;
  controller: AbortController;
  abortKey: string;
  context?: any;
  request?: SpectreAiRequest;
  reservationTokens: number;
  includeThoughts?: boolean;
}

/**
 * Grouped params for after-response processing to avoid primitive obsession.
 */
interface AfterResponseParams {
  model: string;
  reservationTokens: number;
  res: SpectreAiResponse;
}

/**
 * Polyfill fetch API for Node.js environments.
 * Ensures cross-fetch is available for Gemini SDK network requests.
 */
const maybeCrossFetch = require('cross-fetch');
/* eslint-disable @typescript-eslint/no-explicit-any */
const fetchPoly: any =
  (maybeCrossFetch && (maybeCrossFetch.default || maybeCrossFetch)) ||
  undefined;
if (
  typeof (globalThis as any).fetch !== 'function' &&
  typeof fetchPoly === 'function'
) {
  (globalThis as any).fetch = fetchPoly;
  if (!(globalThis as any).Headers && maybeCrossFetch.Headers)
    (globalThis as any).Headers = maybeCrossFetch.Headers;
  if (!(globalThis as any).Request && maybeCrossFetch.Request)
    (globalThis as any).Request = maybeCrossFetch.Request;
  if (!(globalThis as any).Response && maybeCrossFetch.Response)
    (globalThis as any).Response = maybeCrossFetch.Response;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Rate limit constants for Gemini API quota management.
 * These match the Gemini 2.5 free tier limits for Arduino IDE.
 *
 * IMPORTANT: TPM (Tokens Per Minute) quota applies to INPUT tokens ONLY.
 * Output tokens do NOT count toward the TPM limit.
 *
 * Gemini 2.5 Flash:      RPM=10,  TPM=250k (input), RPD=250
 * Gemini 2.5 Flash-Lite: RPM=15,  TPM=250k (input), RPD=1000
 * Maximum output tokens per response: 65,536
 */

/** Grouped configuration to avoid primitive obsession when working with quotas/pacing */
interface QuotaConfig {
  tokenCapacityPerMinute: number;
  maxOutputTokens: number;
  rpmFlash: number;
  rpmFlashLite: number;
  rpdFlash: number;
  rpdFlashLite: number;
  rollingWindowMs: number;
  minSpacingMsFlash: number;
  minSpacingMsFlashLite: number;
}

const QUOTA_CONFIG: QuotaConfig = {
  tokenCapacityPerMinute: 250_000,
  maxOutputTokens: 65_536,
  rpmFlash: 15,
  rpmFlashLite: 15,
  rpdFlash: 1500,
  rpdFlashLite: 500,
  rollingWindowMs: 60_000,
  minSpacingMsFlash: 4000, // 15 RPM = 1 request every 4 seconds
  minSpacingMsFlashLite: 4000, // 15 RPM = 1 request every 4 seconds
};

/** Consolidated quota limits object used to initialize quota tracker */
const QUOTA_LIMITS = {
  tokenCapacityPerMinute: QUOTA_CONFIG.tokenCapacityPerMinute,
  rpmFlash: QUOTA_CONFIG.rpmFlash,
  rpmFlashLite: QUOTA_CONFIG.rpmFlashLite,
  rpdFlash: QUOTA_CONFIG.rpdFlash,
  rpdFlashLite: QUOTA_CONFIG.rpdFlashLite,
  rollingWindowMs: QUOTA_CONFIG.rollingWindowMs,
  minSpacingMsFlash: QUOTA_CONFIG.minSpacingMsFlash,
  minSpacingMsFlashLite: QUOTA_CONFIG.minSpacingMsFlashLite,
};

/**
 * Tracks token usage within the rolling window for quota management.
 *
 * @property time - Timestamp when tokens were used
 * @property tokens - Number of tokens consumed
 * @property reservation - True if this is a reserved quota (not yet consumed)
 */
/**
 * Represents a queued generation request waiting for quota availability.
 *
 * @property request - The AI generation request parameters
 * @property resolve - Promise resolver for successful completion
 * @property reject - Promise rejector for errors
 * @property reservationTokens - Estimated tokens reserved for this request
 * @property model - Model identifier (flash or flash-lite)
 * @property abortKey - Unique key for cancellation
 * @property enqueuedAt - Timestamp when request was queued
 */
interface PendingRequest {
  request: SpectreAiRequest;
  resolve: (r: SpectreAiResponse) => void;
  reject: (e: unknown) => void;
  reservationTokens: number;
  model: string;
  abortKey: string;
  enqueuedAt: number;
}

/**
 * Backend implementation of SpectreAiService with advanced quota management.
 *
 * This class orchestrates all Gemini API interactions with intelligent request scheduling:
 * - Maintains token budget tracking within 60-second rolling windows
 * - Enforces RPM limits per model (10 for flash, 15 for flash-lite)
 * - Queues requests when quota is exhausted
 * - Streams responses to frontend clients in real-time
 * - Retries transient failures with exponential backoff
 * - Supports conversation context for multi-turn chat sessions
 *
 * The service uses reservation-based quota management: tokens are reserved when
 * a request starts, then adjusted to actual usage after completion.
 */
@injectable()
export class SpectreAiServiceImpl implements SpectreAiService {
  /** Frontend client for streaming callbacks */
  protected client?: SpectreAiClient;

  /** Secrets service for API key retrieval */
  @inject(SpectreSecretsService)
  private readonly secretsService!: SpectreSecretsService;

  /** Active abort controllers for in-flight requests */
  private readonly abortControllers = new Map<string, AbortController>();

  /** Last request start time per model (for pacing) */
  private readonly lastCallAt: Record<string, number> = {};

  private readonly quota = new SpectreAiQuotaTracker(
    {
      tokenCapacityPerMinute: QUOTA_LIMITS.tokenCapacityPerMinute,
      rpmFlash: QUOTA_LIMITS.rpmFlash,
      rpmFlashLite: QUOTA_LIMITS.rpmFlashLite,
      rpdFlash: QUOTA_LIMITS.rpdFlash,
      rpdFlashLite: QUOTA_LIMITS.rpdFlashLite,
      rollingWindowMs: QUOTA_LIMITS.rollingWindowMs,
      minSpacingMsFlash: QUOTA_LIMITS.minSpacingMsFlash,
      minSpacingMsFlashLite: QUOTA_LIMITS.minSpacingMsFlashLite,
    },
    (model) => this.isFlashLite(model)
  );

  /** Pending requests waiting for quota */
  private queue: PendingRequest[] = [];
  /** Flag indicating queue processing is active */
  private processing = false;

  /** Lazy-loaded Google Generative AI SDK */
  private sdk?: GoogleGenAIType;
  /** Promise for SDK loading in progress */
  private loadingSdk?: Promise<void>;

  /** Interval for queue processing */
  private queueTicker?: NodeJS.Timeout;
  /** Interval for quota decay updates */
  private decayTicker?: NodeJS.Timeout;

  /**
   * Registers frontend client for streaming callbacks.
   * Immediately sends current quota status to the client.
   */
  setClient(client: SpectreAiClient): void {
    this.client = client;
    this.pushQuotaUpdate();
  }

  /**
   * Unregisters frontend client when connection closes.
   */
  disposeClient(client: SpectreAiClient): void {
    if (this.client === client) this.client = undefined;
  }

  /**
   * Cleans up service resources on shutdown.
   * Stops all timers and clears client references.
   */
  dispose(): void {
    this.client = undefined;
    if (this.queueTicker) clearInterval(this.queueTicker);
    if (this.decayTicker) clearInterval(this.decayTicker);
  }

  /**
   * Determines if a model is the flash-lite variant.
   * Centralizes model type checking to eliminate magic string repetition.
   *
   * @param model - Model name to check
   * @returns true if model is flash-lite variant
   */
  private isFlashLite(model: string): boolean {
    return model.includes('flash-lite');
  }

  /**
   * Generates AI response with quota-aware queuing.
   *
   * This method implements sophisticated request management:
   * 1. Validates API key availability
   * 2. Estimates token requirements and reserves quota
   * 3. Either starts immediately if quota available, or queues
   * 4. Streams response chunks to frontend client
   * 5. Adjusts quota based on actual token usage
   *
   * @param request - Generation parameters including prompt, model, and config
   * @returns Promise resolving to complete AI response with metadata
   * @throws Error if API key is not configured or generation fails
   */
  async generate(request: SpectreAiRequest): Promise<SpectreAiResponse> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'No Gemini API key configured. Set it in Preferences → Spectre.'
      );
    }

    const requestedModel = resolveSupportedModel(request.model);
    const model = mapModel(requestedModel);
    const abortKey =
      request.abortKey ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const reservationTokens = estimateTotalInputTokens(request);
    const maxOutputTokens = clampOutputTokens(
      request.generationConfig?.maxOutputTokens,
      QUOTA_CONFIG.maxOutputTokens
    );

    const preparedRequest = {
      ...request,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      abortKey,
      generationConfig: {
         ...request.generationConfig,
         maxOutputTokens,
      },
      enableAgentMode: request.enableAgentMode === true,
      functionDeclarations:
        request.enableAgentMode === true
          ? request.functionDeclarations || AGENT_FUNCTIONS
          : undefined,
    };

    return new Promise<SpectreAiResponse>((resolve, reject) => {
      this.enqueueRequest({
        request: preparedRequest,
        resolve,
        reject,
        reservationTokens,
        model,
        abortKey,
        enqueuedAt: Date.now(),
      });
    });
  }

  private enqueueRequest(pending: PendingRequest): void {
    if (this.canStartNow({ model: pending.model, reservationTokens: pending.reservationTokens })) {
      this.startRequest(pending).catch(pending.reject);
    } else {
      this.queue.push(pending);
      this.pushQuotaUpdate();
    }
    this.scheduleQueueProcessing();
  }

  /**
   * Cancels an in-flight or queued generation request.
   * Aborts active requests and removes queued ones.
   *
   * @param abortKey - Unique identifier for the request to cancel
   */
  async cancel(abortKey: string): Promise<void> {
    const controller = this.abortControllers.get(abortKey);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(abortKey);
      this.client?.onStream({ key: abortKey, error: 'Canceled' });
    }
    const idx = this.queue.findIndex((q) => q.abortKey === abortKey);
    if (idx >= 0) {
      const [entry] = this.queue.splice(idx, 1);
      entry.reject(new Error('Generation canceled.'));
      this.pushQuotaUpdate();
    }
  }

  /**
   * Retrieves current quota and rate limit status.
   *
   * @param model - Optional model to query (defaults to active queue or flash)
   * @returns Current quota state including tokens, RPM, and queue info
   */
  async getQuota(model?: string): Promise<SpectreQuotaUpdate> {
    const modelForRpm = model
      ? mapModel(resolveSupportedModel(model))
      : this.queue[0]?.model || 'gemini-3.1-flash-lite';

    this.quota.cleanWindows();
    const head = this.queue[0]
      ? {
          model: this.queue[0].model,
          reservationTokens: this.queue[0].reservationTokens,
        }
      : undefined;

    return this.quota.buildQuotaUpdate({
      now: Date.now(),
      modelForRpm,
      queueLength: this.queue.length,
      head,
    });
  }

  // ============================================================================
  // Queue Management & Scheduling
  // ============================================================================

  /**
   * Schedules asynchronous queue processing cycle.
   * Prevents concurrent processing with flag check.
   */
  private scheduleQueueProcessing(): void {
    if (this.processing) return;
    this.processing = true;
    setTimeout(
      () => this.runQueueCycle(),
      TIMING_CONSTANTS.QUEUE_PROCESSING_INTERVAL
    );
  }

  /**
   * Processes queue to start pending requests when quota becomes available.
   * Sets up interval timers for continuous monitoring when queue is active.
   */
  private runQueueCycle(): void {
    this.quota.cleanWindows();
    const started = this.tryStartNextQueuedRequest();
    if (started) {
      this.pushQuotaUpdate();
    }

    this.processing = false;
    this.updateQueueTicker();
    this.ensureDecayTicker();
  }

  private tryStartNextQueuedRequest(): boolean {
    if (!this.queue.length) {
      return false;
    }

    const next = this.queue[0];
    if (!this.canStartNow({ model: next.model, reservationTokens: next.reservationTokens })) {
      return false;
    }

    this.queue.shift();
    this.startRequest(next).catch((err) => next.reject(err));
    return true;
  }

  private updateQueueTicker(): void {
    if (this.queue.length) {
      if (!this.queueTicker) {
        this.queueTicker = setInterval(() => {
          this.pushQuotaUpdate();
          this.scheduleQueueProcessing();
        }, 1000);
      }
      return;
    }

    if (this.queueTicker) {
      clearInterval(this.queueTicker);
      this.queueTicker = undefined;
    }
  }

  /**
   * Checks if a request can start immediately without violating rate limits.
   * Considers RPM limits, RPD limits (resets at midnight Pacific Time), token capacity, and minimum spacing.
   */
  private canStartNow(params: StartNowParams): boolean {
    return this.quota.canStartNow(params.model, params.reservationTokens);
  }

  private pushQuotaUpdate(modelForRpm?: string): void {
    this.quota.cleanWindows();
    const head = this.queue[0]
      ? { model: this.queue[0].model, reservationTokens: this.queue[0].reservationTokens }
      : undefined;
    const update = this.quota.buildQuotaUpdate({
      now: Date.now(),
      modelForRpm,
      queueLength: this.queue.length,
      head,
    });
    this.notifyQuotaUpdate(update);
    this.ensureDecayTicker();
  }

  private notifyQuotaUpdate(update: SpectreQuotaUpdate): void {
    try {
      this.client?.onQuota(update);
    } catch (err) {
      spectreWarn('Failed to notify client of quota update:', err);
    }
  }

  private ensureDecayTicker(): void {
    const need = this.quota.hasActiveTracking();

    if (need && !this.decayTicker) {
      this.decayTicker = setInterval(() => {
        this.decayTick();
      }, 1000);
    } else if (!need && this.decayTicker) {
      clearInterval(this.decayTicker);
      this.decayTicker = undefined;
    }
  }

  private decayTick(): void {
    const beforeTokens = this.quota.currentUsedTokens();
    const beforeRpm = this.quota.totalRecentCallsCount();

    this.quota.cleanWindows();

    const afterTokens = this.quota.currentUsedTokens();
    const afterRpm = this.quota.totalRecentCallsCount();

    if (beforeTokens !== afterTokens || beforeRpm !== afterRpm) {
      this.pushQuotaUpdate();
    }

    if (!this.quota.isAllTrackingEmpty(this.queue.length)) {
      return;
    }

    if (this.decayTicker) {
      clearInterval(this.decayTicker);
    }
    this.decayTicker = undefined;
  }

  // ============================================================================
  // Request Execution
  // ============================================================================

  /**
   * Starts execution of a pending request.
   * Records quota reservation, executes with streaming, then adjusts actual usage.
   */
  private async startRequest(p: PendingRequest): Promise<void> {
    const {
      request,
      resolve,
      reject,
      reservationTokens,
      model,
      abortKey,
      enqueuedAt,
    } = p;
    const controller = new AbortController();
    this.abortControllers.set(abortKey, controller);

    this.quota.recordReservation(model, reservationTokens);
    this.quota.recordRpm(model);
    this.pushQuotaUpdate(model);

    const queuedMs = Date.now() - enqueuedAt;

    try {
      const response = await this.execute(
        request,
        controller,
        reservationTokens
      );
      if (!response.meta) response.meta = {};
      response.meta.queuedMs = queuedMs;
      resolve(response);
    } catch (err) {
      reject(err);
    } finally {
      this.abortControllers.delete(abortKey);
      this.pushQuotaUpdate(model);
      this.scheduleQueueProcessing();
    }
  }

  /**
   * Executes AI generation request with retry logic and streaming.
   *
   * This method handles the complete request lifecycle:
   * - Waits for frontend client to be ready for streaming
   * - Configures generation parameters with thinking mode
   * - Builds conversation context from history
   * - Streams response chunks to frontend
   * - Retries transient failures with exponential backoff
   * - Handles service overload (503) with longer backoffs
  * - Applies thinking configuration when enabled
   * - Implements ReAct loop for agent mode (Think → Act → Observe → Repeat)
   *
   * @param request - Generation request parameters
   * @param controller - AbortController for cancellation
   * @param reservationTokens - Reserved token quota for this request
   * @returns Complete AI response with usage metadata
   * @throws Error for authentication failures, quota exhaustion, or non-retryable errors
   */
  private async execute(
    request: SpectreAiRequest,
    controller: AbortController,
    reservationTokens: number
  ): Promise<SpectreAiResponse> {
    // Ensure the RPC client is registered before attempting to stream.
    await this.waitForClientReady(TIMING_CONSTANTS.CLIENT_READY_WAIT);
    const {
      abortKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      generationConfig,
      safetySettings,
      thinkingLevel,
      includeThoughts,
    } = request;

    // If agent mode is enabled, pass function declarations but DON'T run loop here
    // The frontend will handle the ReAct loop by calling us repeatedly
    // We just need to include function declarations in the request

    // Standard generation (with or without function declarations)
    return this.executeStandardGeneration({
      request,
      controller,
      reservationTokens,
      abortKey,
      generationConfig,
      safetySettings,
      thinkingLevel,
      includeThoughts,
    });
  }

  /**
   * Executes standard AI generation (non-agent mode).
   * Handles streaming, retries, and error recovery.
   */
  private async executeStandardGeneration(
    ctx: StandardGenerationContext
  ): Promise<SpectreAiResponse> {
    const {
      request,
      controller,
      reservationTokens,
      abortKey,
      generationConfig,
      safetySettings,
      thinkingLevel,
      includeThoughts,
    } = ctx;
    const { context, model = 'gemini-3.1-flash-lite', prompt } = request;
    if (request.enableAgentMode === true && !supportsFunctionCalling(model)) {
      throw new Error(
        'Agent mode requires gemini-3.1-flash-lite. Select that model in Preferences.'
      );
    }

    const isAgentMode = request.enableAgentMode === true;
    const genConfig = buildStandardGenConfig({
      model,
      isAgentMode,
      generationConfig,
      thinkingLevel,
      maxOutputTokensCap: QUOTA_CONFIG.maxOutputTokens,
    });

    const userInput = buildPrompt(prompt, thinkingLevel);
    const sdk = await this.ensureSdk();
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('No Gemini API key configured.');

    return this.attemptGenerationWithRetries({
      sdk,
      apiKey,
      model,
      userInput,
      genConfig,
      safetySettings,
      controller,
      abortKey,
      context,
      request,
      reservationTokens,
      includeThoughts,
    });
  }

  /**
   * Internal helper that runs the retry loop for standard generation attempts.
   */
  private async attemptGenerationWithRetries(params: GenerationRetryParams): Promise<SpectreAiResponse> {
    const {
      sdk,
      apiKey,
      model,
      userInput,
      genConfig,
      safetySettings,
      controller,
      abortKey,
      context,
      request,
      reservationTokens,
      includeThoughts,
    } = params;

    const maxRetries = 4; // Increased for service overload scenarios
    const state = new RetryState();

    return this.runGenerationRetryLoop({
      sdk,
      apiKey,
      model,
      userInput,
      genConfig,
      safetySettings,
      controller,
      abortKey,
      context,
      request,
      reservationTokens,
      includeThoughts,
      maxRetries,
      state,
    });
  }

  private async runGenerationRetryLoop(opts: RunGenerationRetryLoopParams): Promise<SpectreAiResponse> {
    const {
      sdk,
      apiKey,
      model,
      userInput,
      genConfig,
      safetySettings,
      controller,
      abortKey,
      context,
      request,
      reservationTokens,
      includeThoughts,
      maxRetries,
      state,
    } = opts;

    while (true) {
      try {
        return await this.performGenerationAttempt({
          sdk,
          apiKey,
          model,
          userInput,
          genConfig,
          safetySettings,
          controller,
          abortKey,
          context,
          request,
          reservationTokens,
          includeThoughts,
        });
      } catch (err: any) {
        if (controller.signal.aborted) throw new Error('Generation canceled.');
        const msg = err?.message || String(err);
        this.logStandardGenerationFailure({ attempt: state.attempt, msg, err });

        const decision = decideStandardGenerationRetry({
          err,
          attempt: state.attempt,
          maxRetries,
        });

        await this.processRetryDecision({ decision, state, abortKey });
      }
    }
  }

  private async performGenerationAttempt(ctx: GenerationAttemptContext): Promise<SpectreAiResponse> {
    const {
      sdk,
      apiKey,
      model,
      userInput,
      genConfig,
      safetySettings,
      controller,
      abortKey,
      context,
      request,
      reservationTokens,
      includeThoughts,
    } = ctx;

    const res = await this.tryStreamingAttempt({
      sdk,
      apiKey,
      endpointModel: model,
      userInput,
      genConfig,
      safetySettings,
      controller,
      key: abortKey,
      context,
      request,
    });

    applyThoughtSummary(res, includeThoughts);
    this.afterResponse({ model, reservationTokens, res });
    return res;
  }

  /**
   * Performs a single streaming attempt: pacing, record last-call timestamp, then call streamingCall.
   */
  private async tryStreamingAttempt(
    ctx: StreamingCallContext
  ): Promise<SpectreAiResponse> {
    const model = ctx.endpointModel;
    const key = ctx.key;
    await this.pacing({ model, key });
    // Record timing AFTER pacing completes to prevent artificial delays on subsequent requests
    this.lastCallAt[model] = Date.now();
    return this.streamingCall(ctx);
  }

  /**
   * Handles retry decision actions returned by decideStandardGenerationRetry.
   * Mutates genConfig/state as needed and performs appropriate backoff/wait.
   */
  private async processRetryDecision(params: ProcessRetryActionParams): Promise<void> {
    const { decision, state, abortKey } = params;

    if (decision.action === 'retry') {
      this.client?.onStream({ key: abortKey, delta: decision.delta });
      await delay(decision.backoffMs);
      state.increment();
      return;
    }

    throw new Error(decision.message);
  }

  private logStandardGenerationFailure(params: LogFailureParams): void {
    const { attempt, msg, err } = params;
    spectreError(
      `[Spectre AI] Generation attempt ${attempt + 1} failed:`,
      msg
    );
    spectreError(`[Spectre AI] Error details:`, sanitizeForLogging(err));
  }


  /**
   * Wait briefly for the frontend RPC client to be registered to avoid a race
   * where the first streaming chunks are emitted before setClient occurs.
   */
  private async waitForClientReady(
    timeoutMs: number = TIMING_CONSTANTS.NETWORK_RETRY_BASE_DELAY
  ): Promise<void> {
    const start = Date.now();
    while (!this.client && Date.now() - start < timeoutMs) {
      await delay(TIMING_CONSTANTS.QUEUE_PROCESSING_INTERVAL);
    }
  }

  private afterResponse(params: AfterResponseParams): void {
    const { model, reservationTokens, res } = params;
    // IMPORTANT: Only INPUT tokens (promptTokens) count toward TPM quota!
    // Output tokens (candidatesTokens) do NOT count per Gemini API rules.
    const actual = res.meta?.promptTokens || 0;
    if (actual > 0) {
      this.quota.adjustReservation(model, actual, reservationTokens);
      if (res.meta) res.meta.usedReservation = reservationTokens;
    }
    // NOTE: lastCallAt is set in execute() after pacing completes, not here at response END
    // This ensures pacing uses the previous request's timestamp, not the current one

    // Push quota update after response completes so UI reflects actual token usage
    this.pushQuotaUpdate(model);
  }

  // ============================================================================
  // Networking & SDK Management
  // ============================================================================

  /**
   * Lazy-loads Google Generative AI SDK.
   * Ensures SDK is loaded only once via promise caching.
   */
  private async ensureSdk(): Promise<GoogleGenAIType> {
    if (!this.sdk) {
      if (!this.loadingSdk) {
        this.loadingSdk = (async () => {
          const mod = (await import('@google/genai')) as GoogleGenAIType;
          this.sdk = mod;
        })();
      }
      await this.loadingSdk;
    }
    if (!this.sdk) {
      throw new Error('Spectre AI SDK failed to load');
    }
    return this.sdk;
  }

  /**
   * Executes streaming generation call to Gemini API.
   *
   * Implements conversation context memory by building proper message history:
   * - Includes previous conversation turns from context
   * - Appends current user message
   * - Streams response chunks to frontend via onStream callback
   * - Extracts usage metadata and thinking tokens
   *
   * @param sdk - Google Generative AI SDK instance
   * @param apiKey - Gemini API key
   * @param endpointModel - Model identifier (flash or flash-lite)
   * @param userInput - User's prompt text
   * @param genConfig - Generation configuration
   * @param safetySettings - Content safety settings
   * @param controller - AbortController for cancellation
   * @param key - Unique request key for streaming
   * @param context - Optional conversation context with history
   * @returns Complete AI response with metadata
   */
  private async streamingCall(
    ctx: StreamingCallContext
  ): Promise<SpectreAiResponse> {
    const { controller } = ctx;
    // Wrap entire streaming call with timeout protection.
    // Important: ensure timers/listeners are always cleaned up to avoid leaks.
    let timeoutId: NodeJS.Timeout | undefined;
    let timedOut = false;
    const onAbort = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new Error(
            `Request timeout after ${
              TIMING_CONSTANTS.REQUEST_TIMEOUT / 1000
            } seconds. The API may be unresponsive.`
          )
        );
      }, TIMING_CONSTANTS.REQUEST_TIMEOUT);
    });

    // Clear timeout if controller is aborted externally
    controller.signal.addEventListener('abort', onAbort);

    const executePromise = this.streamingCallImpl(ctx);

    try {
      return await Promise.race([executePromise, timeoutPromise]);
    } finally {
      onAbort();
      controller.signal.removeEventListener('abort', onAbort);
      if (timedOut) {
        void executePromise.catch(() => undefined);
      }
    }
  }

  /**
   * Internal implementation of streaming call with inactivity timeout.
   * Separated from streamingCall to allow timeout wrapper.
   */
  private async streamingCallImpl(
    ctx: StreamingCallContext
  ): Promise<SpectreAiResponse> {
    const {
      sdk,
      apiKey,
      endpointModel,
      userInput,
      genConfig,
      safetySettings,
      controller,
      key,
      context,
      request,
    } = ctx;

    const { thinkingConfig, ...restGen } = genConfig;
    const ai = this.createAiClient({ sdk, apiKey });

    const tools = buildStreamingTools(request);
    const contents = buildConversationContents(context, userInput);
    const systemInstruction =
      request?.enableAgentMode === true
        ? AGENT_MODE_INSTRUCTION
        : BASIC_MODE_INSTRUCTION;

    const response = await this.performGenerateContentStream({
      ai,
      endpointModel,
      contents,
      systemInstruction,
      restGen,
      thinkingConfig,
      tools,
      safetySettings,
      controller,
    });

    return this.consumeResponseStream(response, controller, key, endpointModel);
  }

  // Helper: create AI client instance
  private createAiClient(params: { sdk: GoogleGenAIType; apiKey: string }) {
    const { sdk, apiKey } = params;
    const { GoogleGenAI } = sdk;
    return new GoogleGenAI({ apiKey });
  }

  // Helper: wrap ai.models.generateContentStream call and build config
  private async performGenerateContentStream(params: GenerateContentStreamParams) {
    const {
      ai,
      endpointModel,
      contents,
      systemInstruction,
      restGen,
      thinkingConfig,
      tools,
      safetySettings,
      controller,
    } = params;

    const config: any = {
      systemInstruction,
      ...restGen,
      safetySettings: safetySettings as any,
      ...(thinkingConfig ? { thinkingConfig } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      abortSignal: controller.signal,
    };

    return ai.models.generateContentStream({
      model: endpointModel,
      contents,
      config,
    });
  }

  // Helper: consume stream, enforce inactivity and validate content
  private async consumeResponseStream(
    response: any,
    controller: AbortController,
    key: string,
    endpointModel: string
  ): Promise<SpectreAiResponse> {
    let lastChunkTime = Date.now();
    const stopInactivity = startStreamInactivityMonitor(
      controller,
      key,
      () => lastChunkTime
    );

    try {
      const { full, lastChunk, hasFunctionCalls, allParts } = await consumeStream({
        response,
        controller,
        onChunk: () => {
          lastChunkTime = Date.now();
        },
        onDelta: (delta) => {
          this.client?.onStream({ key, delta });
        },
      });

      if (controller.signal.aborted) throw new Error('canceled');
      if (!full && !hasFunctionCalls) {
        throw new Error('Gemini API returned no content.');
      }

      this.client?.onStream({ key, done: true });
      return buildStreamingResponse(endpointModel, full, lastChunk, allParts);
    } finally {
      stopInactivity();
    }
  }

  // ============================================================================
  // Pacing & Rate Limiting
  // ============================================================================

  /**
   * Enforces minimum spacing between requests to avoid burst rate limiting.
   * Notifies frontend client of pacing delay via streaming.
   */
  private async pacing(params: PacingParams) {
    const { model, key } = params;
    const last = this.lastCallAt[model] || 0;
    const minSpacing = this.isFlashLite(model)
      ? QUOTA_CONFIG.minSpacingMsFlashLite
      : QUOTA_CONFIG.minSpacingMsFlash;
    const since = Date.now() - last;
    if (since < minSpacing) {
      const wait = minSpacing - since;
      this.client?.onStream({
        key,
        delta: `Pacing ${(wait / 1000).toFixed(2)}s...\n`,
      });
      await delay(wait);
    }
  }

  /**
   * Retrieves Gemini API key from secrets service.
   * Environment variable ARDUINO_GEMINI_API_KEY takes precedence for development/testing.
   */
  private async getApiKey(): Promise<string | undefined> {
    return this.secretsService.getApiKey();
  }
}
