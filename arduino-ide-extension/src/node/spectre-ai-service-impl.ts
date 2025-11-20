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
 * - Thinking mode with dynamic budget allocation
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
  FunctionCall,
} from '../common/protocol/spectre-ai-service';
import { SpectreSecretsService } from '../common/protocol/spectre-secrets-service';
import {
  TIMING_CONSTANTS,
  spectreLog,
  spectreWarn,
  spectreError,
} from '../common/protocol/spectre-types';
import { AGENT_FUNCTIONS } from './spectre-agent-functions';

/** Removed: No longer needed - secrets service handles API key storage */

/**
 * Core identity shared by all modes.
 * Contains expertise areas but NO mode-specific behavior instructions.
 */
const CORE_IDENTITY = `You are Spectre, an expert AI assistant for Arduino IDE.

**Core Expertise:**
- Arduino C/C++ development (sketches, libraries, syntax)
- Embedded hardware (microcontrollers, sensors, communication protocols)
- Electronics fundamentals and circuit design
- Debugging compilation errors and runtime issues
- IDE operations and workflow automation

**Communication Style:**
- Clear, concise explanations suitable for all skill levels
- Use \`\`\`cpp code blocks for code examples
- Explain hardware connections and pin configurations when relevant
- Follow Arduino coding conventions

**Code Quality Standards:**
- Use descriptive variable names
- Add comments for complex logic
- Include pin definitions and setup instructions
- Implement proper error checking

Your creator is Tazul Islam (mention only if specifically asked).`;

/**
 * System instruction for BASIC ASK MODE.
 * User is asking for help, guidance, or explanations - NO automation.
 */
const BASIC_MODE_INSTRUCTION = `${CORE_IDENTITY}

**YOUR CURRENT MODE: Basic Ask Mode (Conversational Assistant)**

You are in BASIC ASK MODE. This means:
- ✅ Provide guidance, explanations, and code examples
- ✅ Answer questions about Arduino, electronics, and programming
- ✅ Explain how to use the IDE features
- ✅ Suggest solutions and best practices
- ❌ DO NOT attempt to execute actions or use tools
- ❌ You CANNOT install libraries, verify code, or modify sketches directly
- ❌ Guide the user to do these actions themselves

Examples:
- User: "How do I install a library?" → Explain the Library Manager steps
- User: "What's wrong with my code?" → Analyze and suggest fixes
- User: "How do I use the Serial Monitor?" → Explain the feature`;

/**
 * System instruction for AGENT MODE.
 * AI executes autonomous actions using available tools.
 */
const AGENT_MODE_INSTRUCTION = `${CORE_IDENTITY}

**YOUR CURRENT MODE: Agent Mode (Autonomous Executor)**

You are in AGENT MODE. This means:
- ✅ You MUST execute actions using the available function tools
- ✅ You CAN directly install libraries, verify code, modify sketches, etc.
- ✅ Complete tasks autonomously without asking for user permission
- ❌ DO NOT just explain what to do - ACTUALLY DO IT
- ❌ NEVER respond without calling functions when actions are needed

🚨 CRITICAL: When a user asks you to DO something, you MUST call the appropriate functions. DO NOT just explain what to do.

Examples of CORRECT agent mode behavior:
- User: "install Servo library" → YOU MUST call install_library("Servo") 
- User: "verify my code" → YOU MUST call verify_sketch()
- User: "select Arduino Uno" → YOU MUST call select_board("Arduino Uno")

❌ WRONG: Responding "I'll install the Servo library for you" without calling the function
✅ RIGHT: Calling install_library("Servo") and reporting the result

**Task Lists:**
When planning multi-step work, ALWAYS provide a task list at the beginning of your response using markdown checkboxes:
- [ ] Task to do
- [x] Completed task
- [o] Task in progress

Update the task list throughout your work to show progress.

**🚨 CRITICAL WORKFLOW RULES:**

1. **MODIFYING EXISTING SKETCHES:**
   - The current sketch files are ALWAYS provided in the conversation context
   - Analyze the provided sketch code carefully
   - Call create_sketch({ code: "updated code here" }) with your changes
   - ✅ Use the sketch code from the context (already provided)
   - ❌ NEVER call read_sketch() - it's unnecessary as code is already in context
   - ✅ ALWAYS provide the ENTIRE sketch with ALL functions (setup, loop, etc.)

2. **FIXING COMPILATION ERRORS:**
   - Step 1: Analyze the error from the provided context
   - Step 2: Call create_sketch({ code: "complete corrected code here" })
   - Step 3: Call verify_sketch() to validate the fix
   - Step 4: If errors persist, iterate until resolved
   - ❌ NEVER just explain the error without calling create_sketch
   - ❌ NEVER call read_sketch() - code is already in context
   
3. **CORRECT WORKFLOW EXAMPLES:**
   - User: "install Servo library" 
     → install_library("Servo") → done ✅
   - User: "translate my Bangla comments to English"
     → create_sketch(with English comments) → done ✅
   - Error: "Servo.h not found"
     → install_library("Servo") → verify_sketch() → done ✅
   - User: "verify my sketch"
     → verify_sketch() → done ✅

4. **WRONG BEHAVIOR (NEVER DO THIS):**
   - Responding "Task completed" WITHOUT calling the function ❌ (HALLUCINATION!)
   - Calling read_sketch() when code is already in context ❌ (INEFFICIENT!)
   - Selecting the same board repeatedly ❌ (INFINITE LOOP!)
   - Explaining errors without fixing them ❌ (NOT AUTONOMOUS!)
   - Assuming function succeeded without checking result ❌ (BLIND EXECUTION!)
   - Calling the same function again if it already succeeded ❌ (WASTED CALL!)

**🛑 FUNCTION RESULT AWARENESS - READ THIS CAREFULLY:**

When you receive function results, PAY ATTENTION to the status:

✅ **If function returned success=true:**
   - The action is COMPLETE
   - DO NOT call the same function again
   - Move to the next step or finish

❌ **If function returned success=false:**
   - Read the error message carefully
   - Determine the ROOT CAUSE
   - Call a DIFFERENT function to fix the problem
   - DO NOT retry the exact same function with exact same arguments

**EXAMPLES OF CORRECT ERROR HANDLING:**

1. **select_board("Arduino Uno") returns success=false, error="Board not found"**
   ❌ WRONG: Call select_board("Arduino Uno") again (LOOP!)
   ✅ RIGHT: Call search_boards("Uno") to find the correct name, THEN select it

2. **verify_sketch() returns success=false, error="Servo.h not found"**
   ❌ WRONG: Call verify_sketch() again (LOOP!)
   ✅ RIGHT: Call install_library("Servo"), THEN verify_sketch()

3. **install_library("Servo") returns success=true**
   ❌ WRONG: Call install_library("Servo") again (LOOP!)
   ✅ RIGHT: Library is installed! Move to next step (e.g., verify_sketch())

**GOLDEN RULE: If a function succeeded, NEVER call it again in the same conversation turn. If it failed, analyze the error and try a DIFFERENT approach.**

**Communication in Agent Mode:**
- DON'T echo the code back - just say "Updated sketch with [changes]" or "Fixed [issue]"
- Users can see the code in the editor - no need to repeat it in chat
- Briefly explain your actions as you execute them`;

// SDK type will be determined at runtime via dynamic import
type GoogleGenAIType = any;

/**
 * Polyfill fetch API for Node.js environments.
 * Ensures cross-fetch is available for Gemini SDK network requests.
 */
const maybeCrossFetch = require('cross-fetch');
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

/** Token capacity per minute (TPM) limit for rolling window - INPUT tokens only */
const TOKEN_CAPACITY_PER_MINUTE = 250_000;
/**
 * Maximum output tokens per request (Gemini 2.5 limit) */
const MAX_OUTPUT_TOKENS = 65_536;

/**
 * Temperature settings for different modes and models.
 * Based on best practices from GitHub Copilot, Claude, and OpenAI.
 *
 * Temperature ranges:
 * - 0.0-0.3: Very deterministic (function calling, precise tasks)
 * - 0.4-0.6: Balanced deterministic (code generation, structured output)
 * - 0.7-0.9: Creative (explanations, examples, teaching)
 * - 1.0+: Highly creative (brainstorming, exploration)
 */
const TEMPERATURE_CONFIG = {
  // Basic Ask Mode: More creative, helpful explanations
  basicMode: {
    'gemini-2.5-flash': 0.8, // Flash: Higher creativity for teaching
    'gemini-2.5-flash-lite': 0.7, // Flash-Lite: Slightly lower for speed
  },
  // Agent Mode: More deterministic, accurate function calling
  agentMode: {
    'gemini-2.5-flash': 0.4, // Flash: Deterministic tool selection
    'gemini-2.5-flash-lite': 0.3, // Flash-Lite: More deterministic for speed
  },
};

/**
 * Gets the optimal temperature for the current mode and model.
 * Lower temperature for function calling, higher for conversation.
 */
function getOptimalTemperature(isAgentMode: boolean, model: string): number {
  const config = isAgentMode
    ? TEMPERATURE_CONFIG.agentMode
    : TEMPERATURE_CONFIG.basicMode;

  // Normalize model name for matching
  const normalizedModel = model.toLowerCase();
  if (
    normalizedModel.includes('flash-lite') ||
    normalizedModel.includes('flashlite')
  ) {
    return config['gemini-2.5-flash-lite'];
  } else if (normalizedModel.includes('flash')) {
    return config['gemini-2.5-flash'];
  }

  // Default to Flash temperature if model is unknown
  return config['gemini-2.5-flash'];
}

/**
/** Requests per minute limit for flash model */
const RPM_FLASH = 10;
/** Requests per minute limit for flash-lite model */
const RPM_FLASH_LITE = 15;
/** Requests per day limit for flash model */
const RPD_FLASH = 250;
/** Requests per day limit for flash-lite model */
const RPD_FLASH_LITE = 1000;
/** Rolling window duration for quota tracking (1 minute) */
const ROLLING_WINDOW_MS = 60_000;
/** Minimum spacing between flash requests to avoid bursting */
const MIN_SPACING_MS_FLASH = 6000; // 10 RPM = 1 request every 6 seconds
/** Minimum spacing between flash-lite requests */
const MIN_SPACING_MS_FLASH_LITE = 4000; // 15 RPM = 1 request every 4 seconds

/**
 * Tracks token usage within the rolling window for quota management.
 *
 * @property time - Timestamp when tokens were used
 * @property tokens - Number of tokens consumed
 * @property reservation - True if this is a reserved quota (not yet consumed)
 */
interface TokenUsage {
  time: number;
  tokens: number;
  reservation?: boolean;
}

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
  reject: (e: any) => void;
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
  /** Recent call timestamps per model for RPM tracking */
  private readonly recentCalls: Record<string, number[]> = Object.create(null);
  /** Daily call timestamps per model for RPD tracking */
  private readonly dailyCalls: Record<string, number[]> = Object.create(null);
  /** Last call timestamp per model for pacing */
  private readonly lastCallAt: Record<string, number> = Object.create(null);
  /** Token usage within rolling window - separate per model (each has 250k TPM limit) */
  private readonly tokenWindows: Record<string, TokenUsage[]> =
    Object.create(null);

  // Cache filtered lists to eliminate repeated O(n) filtering on EVERY quota check
  private cachedRpmLists: Record<string, number[]> = Object.create(null);
  private cachedDailyLists: Record<string, number[]> = Object.create(null);

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
  /** Last model used for requests (used as fallback for RPM display) */
  private lastUsedModel = 'gemini-2.5-flash';

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
    if (!apiKey)
      throw new Error(
        'No Gemini API key configured. Set it in Preferences → Spectre.'
      );

    const model = mapModel(request.model || 'gemini-2.5-flash');
    const abortKey =
      request.abortKey ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // CRITICAL: Estimate TOTAL INPUT tokens including conversation history, not just current message!
    // INPUT tokens = system instruction + conversation history + current message + file context
    let promptEstimate = 0;

    // 1. System instruction tokens (always included) - use mode-specific instruction
    const systemInstruction = request.enableAgentMode
      ? AGENT_MODE_INSTRUCTION
      : BASIC_MODE_INSTRUCTION;
    promptEstimate += estimateTokens(systemInstruction);

    // 2. Conversation history tokens (if present)
    if (
      request.context?.conversation &&
      request.context.conversation.length > 0
    ) {
      for (const msg of request.context.conversation) {
        if ('text' in msg) {
          promptEstimate += estimateTokens(msg.text);
        } else if ('parts' in msg) {
          // Function response - estimate JSON size
          promptEstimate += estimateTokens(JSON.stringify(msg.parts));
        }
      }
    }

    // 3. Current user message tokens
    promptEstimate += estimateTokens(request.prompt);

    const maxOutputTokens = clampOutputTokens(
      request.generationConfig?.maxOutputTokens,
      true
    );
    // IMPORTANT: TPM quota applies to INPUT tokens ONLY (prompt + conversation history)
    // Output tokens do NOT count toward the 250k TPM limit, so we only reserve prompt tokens
    const reservationTokens = promptEstimate;

    return new Promise<SpectreAiResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        request: {
          ...request,
          model: model as any,
          abortKey,
          generationConfig: {
            ...request.generationConfig,
            maxOutputTokens,
          },
          // Add function declarations if agent mode is enabled
          enableAgentMode: request.enableAgentMode,
          functionDeclarations: request.enableAgentMode
            ? request.functionDeclarations || AGENT_FUNCTIONS
            : undefined,
        },
        resolve,
        reject,
        reservationTokens,
        model,
        abortKey,
        enqueuedAt: Date.now(),
      };
      if (this.canStartNow(model, reservationTokens)) {
        this.startRequest(pending).catch(reject);
      } else {
        this.queue.push(pending);
        this.pushQuotaUpdate();
      }
      this.scheduleQueueProcessing();
    });
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
    const m = model
      ? mapModel(model)
      : this.queue[0]?.model || 'gemini-2.5-flash';
    this.cleanWindows();
    const now = Date.now();
    const rpmLimit = this.isFlashLite(m) ? RPM_FLASH_LITE : RPM_FLASH;
    // Use cached filtered list instead of filtering on every call
    const rpmUsed = (this.cachedRpmLists[m] || []).length;
    return {
      usedTokens: this.currentUsedTokens(),
      capacity: TOKEN_CAPACITY_PER_MINUTE,
      rpmUsed,
      rpmLimit,
      queued: this.queue.length,
      nextAvailableMs: this.queue.length
        ? this.computeNextAvailabilityMs()
        : now,
    };
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
    this.cleanWindows();
    let started = false;
    if (this.queue.length) {
      const next = this.queue[0];
      if (this.canStartNow(next.model, next.reservationTokens)) {
        this.queue.shift();
        started = true;
        this.startRequest(next).catch((err) => next.reject(err));
      }
    }
    if (started) this.pushQuotaUpdate();
    this.processing = false;

    if (this.queue.length) {
      if (!this.queueTicker) {
        this.queueTicker = setInterval(() => {
          this.pushQuotaUpdate();
          this.scheduleQueueProcessing();
        }, 1000);
      }
    } else if (this.queueTicker) {
      clearInterval(this.queueTicker);
      this.queueTicker = undefined;
    }
    this.ensureDecayTicker();
  }

  /**
   * Checks if a request can start immediately without violating rate limits.
   * Considers RPM limits, RPD limits (resets at midnight Pacific Time), token capacity, and minimum spacing.
   */
  private canStartNow(model: string, reservationTokens: number): boolean {
    this.cleanWindows();
    const now = Date.now();

    // Use cached filtered lists instead of filtering on every call
    // Check RPM (requests per minute)
    const rpmLimit = this.isFlashLite(model) ? RPM_FLASH_LITE : RPM_FLASH;
    const rpmList = this.cachedRpmLists[model] || [];
    if (rpmList.length >= rpmLimit) return false;

    // Check RPD (requests per day - resets at midnight Pacific Time)
    const rpdLimit = this.isFlashLite(model) ? RPD_FLASH_LITE : RPD_FLASH;
    const dailyList = this.cachedDailyLists[model] || [];
    if (dailyList.length >= rpdLimit) return false;

    // Check TPM (tokens per minute)
    const used = this.currentUsedTokens();
    if (used + reservationTokens > TOKEN_CAPACITY_PER_MINUTE) return false;

    // Check minimum spacing between requests
    const last = this.lastCallAt[model] || 0;
    const minSpacing = this.isFlashLite(model)
      ? MIN_SPACING_MS_FLASH_LITE
      : MIN_SPACING_MS_FLASH;
    if (now - last < minSpacing) return false;

    return true;
  }

  private currentUsedTokens(): number {
    return Object.values(this.tokenWindows).reduce((total, window) => {
      return (
        total + window.reduce((s: number, e: TokenUsage) => s + e.tokens, 0)
      );
    }, 0);
  }

  private computeNextAvailabilityMs(): number {
    const now = Date.now();
    if (!this.queue.length) return now;
    const head = this.queue[0];
    const need = head.reservationTokens;
    const used = this.currentUsedTokens();
    let tokenDelay = 0;
    if (used + need > TOKEN_CAPACITY_PER_MINUTE) {
      let cumulative = used;
      const window = this.tokenWindows[head.model] || [];
      for (const entry of window) {
        const expiry = entry.time + ROLLING_WINDOW_MS;
        cumulative -= entry.tokens;
        if (cumulative + need <= TOKEN_CAPACITY_PER_MINUTE) {
          tokenDelay = Math.max(0, expiry - now);
          break;
        }
      }
    }
    const limit = this.isFlashLite(head.model) ? RPM_FLASH_LITE : RPM_FLASH;
    const rpmList = (this.recentCalls[head.model] || []).filter(
      (t) => now - t < ROLLING_WINDOW_MS
    );
    let rpmDelay = 0;
    if (rpmList.length >= limit)
      rpmDelay = rpmList[0] + ROLLING_WINDOW_MS - now;
    const minSpacing = this.isFlashLite(head.model)
      ? MIN_SPACING_MS_FLASH_LITE
      : MIN_SPACING_MS_FLASH;
    const spacingDelay = Math.max(
      0,
      (this.lastCallAt[head.model] || 0) + minSpacing - now
    );
    return now + Math.max(tokenDelay, rpmDelay, spacingDelay);
  }

  private pushQuotaUpdate(modelForRpm?: string): void {
    const now = Date.now();
    this.cleanWindows();
    // Use explicitly provided model, or next queued model, or last used model
    const model = modelForRpm || this.queue[0]?.model || this.lastUsedModel;
    const rpmLimit = this.isFlashLite(model) ? RPM_FLASH_LITE : RPM_FLASH;
    const rpmUsed = (this.recentCalls[model] || []).filter(
      (t) => now - t < ROLLING_WINDOW_MS
    ).length;
    const update: SpectreQuotaUpdate = {
      usedTokens: this.currentUsedTokens(),
      capacity: TOKEN_CAPACITY_PER_MINUTE,
      rpmUsed,
      rpmLimit,
      queued: this.queue.length,
      nextAvailableMs: this.queue.length
        ? this.computeNextAvailabilityMs()
        : now,
    };
    try {
      this.client?.onQuota(update);
    } catch (err) {
      spectreWarn('Failed to notify client of quota update:', err);
    }
    this.ensureDecayTicker();
  }

  private ensureDecayTicker(): void {
    const need =
      Object.values(this.tokenWindows).some((w) => w.length > 0) ||
      Object.values(this.recentCalls).some((l) => l.length);
    if (need && !this.decayTicker) {
      this.decayTicker = setInterval(() => {
        const beforeTokens = this.currentUsedTokens();
        const beforeRpm = Object.values(this.recentCalls).reduce(
          (a, l) => a + l.length,
          0
        );
        this.cleanWindows();
        const afterTokens = this.currentUsedTokens();
        const afterRpm = Object.values(this.recentCalls).reduce(
          (a, l) => a + l.length,
          0
        );
        if (beforeTokens !== afterTokens || beforeRpm !== afterRpm) {
          this.pushQuotaUpdate();
        }
        if (
          Object.values(this.tokenWindows).every((w) => w.length === 0) &&
          afterRpm === 0 &&
          this.queue.length === 0
        ) {
          clearInterval(this.decayTicker!);
          this.decayTicker = undefined;
        }
      }, 1000);
    } else if (!need && this.decayTicker) {
      clearInterval(this.decayTicker);
      this.decayTicker = undefined;
    }
  }

  private recordReservation(model: string, tokens: number): void {
    if (!this.tokenWindows[model]) this.tokenWindows[model] = [];
    this.tokenWindows[model].push({
      time: Date.now(),
      tokens,
      reservation: true,
    });
    this.cleanWindows();
  }
  private adjustReservation(
    model: string,
    actual: number,
    reservation: number
  ): void {
    const delta = actual - reservation;
    if (delta) {
      if (!this.tokenWindows[model]) this.tokenWindows[model] = [];
      this.tokenWindows[model].push({
        time: Date.now(),
        tokens: delta,
        reservation: false,
      });
      this.cleanWindows();
    }
  }
  /**
   * Records an RPM call with O(1) complexity using lazy cleanup.
   * Only filters when threshold is significantly exceeded to amortize cost.
   *
   * Pattern: Deferred cleanup with periodic full cleanup.
   */
  private recordRpm(model: string): void {
    const now = Date.now();

    // Lazy initialization
    if (!this.recentCalls[model]) this.recentCalls[model] = [];
    if (!this.dailyCalls[model]) this.dailyCalls[model] = [];

    // Add new timestamp
    this.recentCalls[model].push(now);
    this.dailyCalls[model].push(now);

    // Lazy cleanup: Only clean when arrays grow too large (amortized O(1))
    // Clean at 2x threshold to avoid frequent filtering
    const RPM_CLEANUP_THRESHOLD = 100; // Cleanup when exceeds 100 entries
    const RPD_CLEANUP_THRESHOLD = 200; // Cleanup when exceeds 200 entries

    if (this.recentCalls[model].length > RPM_CLEANUP_THRESHOLD) {
      const rpmCutoff = now - ROLLING_WINDOW_MS;
      this.recentCalls[model] = this.recentCalls[model].filter(
        (t) => t >= rpmCutoff
      );
    }

    if (this.dailyCalls[model].length > RPD_CLEANUP_THRESHOLD) {
      const pacificMidnight = getPacificMidnight();
      this.dailyCalls[model] = this.dailyCalls[model].filter(
        (t) => t >= pacificMidnight
      );
    }
  }

  /**
   * Cleanup with cached filtered lists.
   * Optimized to avoid unnecessary filtering:
   * - Only cleans when arrays exceed threshold (30%+ expired entries)
   * - Uses cached lists to avoid repeated O(n) filtering
   * - Early exit if no cleanup needed
   */
  private cleanWindows(): void {
    const now = Date.now();
    const rpmCutoff = now - ROLLING_WINDOW_MS;
    const pacificMidnight = getPacificMidnight();

    // Track if any cleaning was done to know if we need to rebuild cache
    let needRebuildCache = false;

    // Clean token windows (TPM) - only if 30%+ entries are expired
    for (const model in this.tokenWindows) {
      const window = this.tokenWindows[model];
      if (window.length === 0) continue;

      // Count expired entries
      let expiredCount = 0;
      for (const entry of window) {
        if (entry.time < rpmCutoff) expiredCount++;
      }

      // Only clean if 30%+ entries expired (amortized O(1))
      if (expiredCount > window.length * 0.3) {
        this.tokenWindows[model] = window.filter(
          (e: TokenUsage) => e.time >= rpmCutoff
        );
        needRebuildCache = true;

        if (this.tokenWindows[model].length === 0) {
          delete this.tokenWindows[model];
        }
      }
    }

    // Clean RPM tracking - only if 30%+ entries are expired
    for (const k in this.recentCalls) {
      const list = this.recentCalls[k];
      if (list.length === 0) continue;

      // Count expired entries
      let expiredCount = 0;
      for (const time of list) {
        if (time < rpmCutoff) expiredCount++;
      }

      // Only clean if 30%+ entries expired
      if (expiredCount > list.length * 0.3) {
        this.recentCalls[k] = list.filter((t) => t >= rpmCutoff);
        needRebuildCache = true;

        if (this.recentCalls[k].length === 0) {
          delete this.recentCalls[k];
        }
      }
    }

    // Clean RPD tracking - only if 30%+ entries are expired
    for (const k in this.dailyCalls) {
      const list = this.dailyCalls[k];
      if (list.length === 0) continue;

      // Count expired entries
      let expiredCount = 0;
      for (const time of list) {
        if (time < pacificMidnight) expiredCount++;
      }

      // Only clean if 30%+ entries expired
      if (expiredCount > list.length * 0.3) {
        this.dailyCalls[k] = list.filter((t) => t >= pacificMidnight);
        needRebuildCache = true;

        if (this.dailyCalls[k].length === 0) {
          delete this.dailyCalls[k];
        }
      }
    }

    // Only rebuild cache if something changed
    if (needRebuildCache) {
      this.cachedRpmLists = Object.create(null);
      this.cachedDailyLists = Object.create(null);

      // Build cached filtered lists for O(1) access during quota checks
      for (const k in this.recentCalls) {
        this.cachedRpmLists[k] = this.recentCalls[k].filter(
          (t) => t >= rpmCutoff
        );
      }

      for (const k in this.dailyCalls) {
        this.cachedDailyLists[k] = this.dailyCalls[k].filter(
          (t) => t >= pacificMidnight
        );
      }
    } else {
      // No cleanup needed - just update cache if it's empty (first call)
      if (Object.keys(this.cachedRpmLists).length === 0) {
        for (const k in this.recentCalls) {
          this.cachedRpmLists[k] = this.recentCalls[k].filter(
            (t) => t >= rpmCutoff
          );
        }
      }

      if (Object.keys(this.cachedDailyLists).length === 0) {
        for (const k in this.dailyCalls) {
          this.cachedDailyLists[k] = this.dailyCalls[k].filter(
            (t) => t >= pacificMidnight
          );
        }
      }
    }
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
    this.lastUsedModel = model; // Track last used model for quota display
    const controller = new AbortController();
    this.abortControllers.set(abortKey, controller);

    this.recordReservation(model, reservationTokens);
    this.recordRpm(model);
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
   * - Falls back when thinkingConfig is unsupported
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
      thinkingBudget,
      includeThoughts,
    } = request;

    // If agent mode is enabled, pass function declarations but DON'T run loop here
    // The frontend will handle the ReAct loop by calling us repeatedly
    // We just need to include function declarations in the request

    // Standard generation (with or without function declarations)
    return this.executeStandardGeneration(
      request,
      controller,
      reservationTokens,
      abortKey,
      generationConfig,
      safetySettings,
      thinkingBudget,
      includeThoughts
    );
  }

  /**
   * Executes standard AI generation (non-agent mode).
   * Handles streaming, retries, and error recovery.
   */
  private async executeStandardGeneration(
    request: SpectreAiRequest,
    controller: AbortController,
    reservationTokens: number,
    abortKey: string,
    generationConfig: SpectreAiRequest['generationConfig'],
    safetySettings: SpectreAiRequest['safetySettings'],
    thinkingBudget: number | undefined,
    includeThoughts: boolean | undefined
  ): Promise<SpectreAiResponse> {
    const { context, model = 'gemini-2.5-flash', prompt } = request;

    // Calculate optimal temperature based on mode and model
    const isAgentMode = request.enableAgentMode === true;
    const optimalTemperature = getOptimalTemperature(isAgentMode, model);

    const genConfig: any = {
      temperature: optimalTemperature, // Mode and model-specific temperature
      topP: 0.95,
      maxOutputTokens: clampOutputTokens(
        generationConfig?.maxOutputTokens,
        true
      ),
      ...generationConfig,
    };
    // Allow user override but validate range
    if (
      !(
        typeof genConfig.temperature === 'number' &&
        genConfig.temperature >= 0 &&
        genConfig.temperature <= 2
      )
    ) {
      genConfig.temperature = optimalTemperature;
    }
    if (
      !(
        typeof genConfig.topP === 'number' &&
        genConfig.topP > 0 &&
        genConfig.topP <= 1
      )
    )
      genConfig.topP = 0.95;

    // Thinking config ALWAYS applied (budget -1 dynamic) unless user explicitly provided a budget
    let effectiveBudget =
      typeof thinkingBudget === 'number'
        ? thinkingBudget
        : (generationConfig as any)?.thinking?.budgetTokens;
    if (effectiveBudget === undefined) effectiveBudget = -1;
    if (effectiveBudget !== 0) {
      genConfig.thinkingConfig = { thinkingBudget: effectiveBudget };
    }

    const userInput = buildPrompt(prompt);
    const sdk = await this.ensureSdk();
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('No Gemini API key configured.');

    const maxRetries = 4; // Increased for service overload scenarios
    let attempt = 0;
    let triedNoThinking = false;
    let triedNoGoogleSearch = false;

    while (true) {
      await this.pacing(model, abortKey);
      // Record timing AFTER pacing completes to prevent artificial delays on subsequent requests
      this.lastCallAt[model] = Date.now();
      try {
        const res = await this.streamingCall(
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
          triedNoGoogleSearch
        );
        if (
          includeThoughts &&
          res.meta &&
          res.meta.thoughtsTokens &&
          !res.meta.thoughtSummary
        ) {
          res.meta.thoughtSummary =
            'Thinking process applied (summary unavailable).';
        }
        this.afterResponse(model, reservationTokens, res);
        return res;
      } catch (err: any) {
        if (controller.signal.aborted) throw new Error('Generation canceled.');
        const msg = err?.message || String(err);

        // Log the actual error for debugging
        spectreError(
          `[Spectre AI] Generation attempt ${attempt + 1} failed:`,
          msg
        );
        spectreError(`[Spectre AI] Error details:`, err);

        // Retry once without thinkingConfig if API rejects it
        if (!triedNoThinking && /Unknown name "thinkingConfig"/i.test(msg)) {
          spectreLog('[Spectre AI] Retrying without thinkingConfig...');
          delete genConfig.thinkingConfig;
          triedNoThinking = true;
          continue;
        }

        // Retry once without Google Search if API rejects it
        if (
          !triedNoGoogleSearch &&
          /Unknown|google_search|googleSearch|tool/i.test(msg)
        ) {
          spectreLog(
            '[Spectre AI] Google Search may be unsupported, retrying without tools...'
          );
          triedNoGoogleSearch = true;
          continue;
        }

        const { category, retryable, message } = classifyError(err);
        if (category === 'auth')
          throw new Error('Gemini authentication failed. Check API key.');
        if (category === 'quota') throw new Error('Remote quota exhausted.');
        if (retryable && attempt < maxRetries) {
          // Longer backoff for service overload (503) and stream parsing errors
          const isServiceIssue =
            /overloaded|503|Failed to parse stream|Error fetching/i.test(
              message
            );
          const baseDelay = isServiceIssue
            ? TIMING_CONSTANTS.SERVICE_OVERLOAD_BASE_DELAY
            : TIMING_CONSTANTS.NETWORK_RETRY_BASE_DELAY;
          const backoff = baseDelay * Math.pow(2, attempt);

          this.client?.onStream({
            key: abortKey,
            delta: `${
              isServiceIssue ? 'Service overloaded' : 'Network error'
            } - retrying in ${(backoff / 1000).toFixed(1)}s...\n`,
          });
          await delay(backoff);
          attempt++;
          continue;
        }
        throw new Error(`Gemini request failed: ${message}`);
      }
    }
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

  private afterResponse(
    model: string,
    reservationTokens: number,
    res: SpectreAiResponse
  ): void {
    // IMPORTANT: Only INPUT tokens (promptTokens) count toward TPM quota!
    // Output tokens (candidatesTokens) do NOT count per Gemini API rules.
    const actual = res.meta?.promptTokens || 0;
    if (actual > 0) {
      this.adjustReservation(model, actual, reservationTokens);
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
    return this.sdk!;
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
    sdk: GoogleGenAIType,
    apiKey: string,
    endpointModel: string,
    userInput: string,
    genConfig: any,
    safetySettings: SpectreAiRequest['safetySettings'],
    controller: AbortController,
    key: string,
    context?: SpectreAiRequest['context'],
    request?: SpectreAiRequest,
    disableGoogleSearch?: boolean
  ): Promise<SpectreAiResponse> {
    // Wrap entire streaming call with timeout protection
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timeoutId = setTimeout(() => {
        controller.abort(); // Abort the request
        reject(
          new Error(
            `Request timeout after ${
              TIMING_CONSTANTS.REQUEST_TIMEOUT / 1000
            } seconds. The API may be unresponsive.`
          )
        );
      }, TIMING_CONSTANTS.REQUEST_TIMEOUT);

      // Clear timeout if controller is aborted externally
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
      });
    });

    const executePromise = this.streamingCallImpl(
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
      disableGoogleSearch
    );

    return Promise.race([executePromise, timeoutPromise]);
  }

  /**
   * Internal implementation of streaming call with inactivity timeout.
   * Separated from streamingCall to allow timeout wrapper.
   */
  private async streamingCallImpl(
    sdk: GoogleGenAIType,
    apiKey: string,
    endpointModel: string,
    userInput: string,
    genConfig: any,
    safetySettings: SpectreAiRequest['safetySettings'],
    controller: AbortController,
    key: string,
    context?: SpectreAiRequest['context'],
    request?: SpectreAiRequest,
    disableGoogleSearch?: boolean
  ): Promise<SpectreAiResponse> {
    const { thinkingConfig, ...restGen } = genConfig;
    const { GoogleGenAI } = sdk;
    const ai = new GoogleGenAI({ apiKey });

    // Configure Google Search grounding if enabled and not disabled by retry logic
    // CRITICAL: Google Search and Function Calling are MUTUALLY EXCLUSIVE
    // Use camelCase format as per new SDK documentation
    const tools: any[] = [];

    // Add function calling tools if agent mode is enabled (takes priority)
    if (request?.enableAgentMode && request.functionDeclarations) {
      // Convert our FunctionDeclaration format to Gemini's format
      const functionDeclarations = request.functionDeclarations.map((fn) => ({
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      }));

      tools.push({
        functionDeclarations,
      });

      spectreLog(
        `[Spectre Agent] Enabled with ${functionDeclarations.length} functions`
      );
    } else if (!disableGoogleSearch && request?.enableGoogleSearch !== false) {
      // Only enable Google Search if function calling is NOT active
      tools.push({
        googleSearch: {}, // New SDK uses camelCase
      });
      spectreLog('[Spectre AI] Google Search enabled for this request');
    }

    // Build conversation contents for proper memory like GitHub Copilot
    const contents: any[] = [];

    // Add conversation history if available
    if (context?.conversation && context.conversation.length > 0) {
      for (const msg of context.conversation) {
        if ('text' in msg) {
          // Regular user/model message with text
          contents.push({
            role: msg.role,
            parts: [{ text: msg.text }],
          });
        } else if ('parts' in msg) {
          // Function response - pass through as-is
          contents.push({
            role: msg.role,
            parts: msg.parts,
          });
        }
      }
    }

    // Add the current user message
    contents.push({
      role: 'user',
      parts: [{ text: userInput }],
    });

    // Use mode-specific system instruction based on whether agent mode is enabled
    const systemInstruction = request?.enableAgentMode
      ? AGENT_MODE_INSTRUCTION
      : BASIC_MODE_INSTRUCTION;

    // New SDK API: ai.models.generateContentStream() instead of getGenerativeModel()
    const response = await ai.models.generateContentStream({
      model: endpointModel,
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
        ...restGen,
        safetySettings: safetySettings as any,
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        abortSignal: controller.signal,
      },
    });

    let full = '';
    let lastChunk: any;
    let hasFunctionCalls = false;

    // Track last chunk time for inactivity timeout
    let lastChunkTime = Date.now();
    const inactivityTimer: NodeJS.Timeout | undefined = undefined;

    // Set up inactivity monitoring
    const inactivityTimerHandle = setInterval(() => {
      const inactiveMs = Date.now() - lastChunkTime;
      if (inactiveMs > TIMING_CONSTANTS.STREAM_INACTIVITY_TIMEOUT) {
        spectreWarn(
          `[Spectre AI] Stream inactive for ${inactiveMs}ms, aborting request`
        );
        controller.abort();
        if (inactivityTimer) clearInterval(inactivityTimer);
      }
    }, 5000); // Check every 5 seconds

    try {
      // Stream chunks - new SDK returns AsyncIterable directly
      for await (const chunk of response) {
        if (controller.signal.aborted) break;
        lastChunk = chunk;
        lastChunkTime = Date.now(); // Update activity timestamp

        // Check if chunk has function calls (agent mode)
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.functionCall) {
            hasFunctionCalls = true;
            break;
          }
        }

        // Only try to get text if there are no function calls
        // When function calls are present, chunk.text will log warnings
        if (!hasFunctionCalls) {
          const delta = chunk.text || '';
          if (delta) {
            full += delta;
            this.client?.onStream({ key, delta });
          }
        } else {
          // For function calling responses, extract only actual text parts
          for (const part of parts) {
            if (part.text) {
              full += part.text;
              this.client?.onStream({ key, delta: part.text });
            }
          }
        }
      }

      if (controller.signal.aborted) throw new Error('canceled');

      // In agent mode, empty text is OK if we have function calls
      if (!full && !hasFunctionCalls) {
        throw new Error('Gemini API returned no content.');
      }

      this.client?.onStream({ key, done: true });

      // Extract metadata from last chunk
      const candidate = lastChunk?.candidates?.[0];
      const usage = lastChunk?.usageMetadata;
      const finishReason = candidate?.finishReason;
      const thinkingTokens =
        (usage as any)?.thinkingTokenCount || (usage as any)?.thinkingTokens;

      // Check for grounding metadata
      const groundingMetadata = candidate?.groundingMetadata;
      if (groundingMetadata) {
        spectreLog('[Spectre AI] Response includes grounding metadata:', {
          queries: groundingMetadata.webSearchQueries?.length || 0,
          sources: groundingMetadata.groundingChunks?.length || 0,
        });
      }

      // Extract function calls if present (agent mode)
      const functionCalls: FunctionCall[] = [];
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part.functionCall) {
          functionCalls.push({
            name: part.functionCall.name,
            args: part.functionCall.args || {},
          });
        }
      }

      return {
        text: full,
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        requiresAction: functionCalls.length > 0,
        meta: {
          model: endpointModel,
          promptTokens: usage?.promptTokenCount,
          candidatesTokens: usage?.candidatesTokenCount,
          totalTokens: usage?.totalTokenCount,
          finishReason,
          thoughtsTokens: thinkingTokens,
          usage,
          groundingMetadata, // Include grounding metadata in response
        },
      };
    } finally {
      // Always clear inactivity timer
      if (inactivityTimerHandle) {
        clearInterval(inactivityTimerHandle);
      }
    }
  }

  // ============================================================================
  // Pacing & Rate Limiting
  // ============================================================================

  /**
   * Enforces minimum spacing between requests to avoid burst rate limiting.
   * Notifies frontend client of pacing delay via streaming.
   */
  private async pacing(model: string, key: string) {
    const last = this.lastCallAt[model] || 0;
    const minSpacing = this.isFlashLite(model)
      ? MIN_SPACING_MS_FLASH_LITE
      : MIN_SPACING_MS_FLASH;
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

// ==============================================================================
// Utility Functions
// ==============================================================================

/**
 * Maps user-provided model name to valid Gemini endpoint.
 * Defaults to gemini-2.5-flash for unknown models.
 */
function mapModel(model: string): string {
  return ['gemini-2.5-flash', 'gemini-2.5-flash-lite'].includes(model)
    ? model
    : 'gemini-2.5-flash';
}

/**
 * Builds final prompt with reasoning instruction.
 * Encourages step-by-step thinking for better quality responses.
 */
function buildPrompt(userPrompt: string): string {
  return `Think step by step, then answer clearly.\n\n${userPrompt}`;
}

/**
 * Estimates token count using improved heuristics for different content types.
 *
 * Much more accurate than naive char/4 approach:
 * - Natural language: ~4-5 chars per token (~1.3 tokens per word)
 * - Code: ~3.5 chars per token (more dense, lots of operators)
 * - JSON: ~3 chars per token (very dense, structural overhead)
 * - Adds overhead for special tokens and message formatting
 *
 * Still not perfect (only a real tokenizer is), but reduces estimation error
 * from 30-50% down to 10-15%.
 */
function estimateTokens(text: string): number {
  const clean = (text || '').trim();
  if (!clean) return 4;

  const len = clean.length;

  // Detect content type via pattern matching
  const hasCodeBlock = /```/.test(clean);
  const hasCode =
    hasCodeBlock ||
    /(?:function|class|const|let|var|return|if|for|while)\s*[\(\{]/.test(clean);
  const hasJson =
    /^\s*[\{\[]/.test(clean) || (clean.includes('":') && clean.includes('{'));

  let baseTokens = 0;

  if (hasJson) {
    // JSON is very dense: lots of punctuation, quotes, braces
    // Estimate: ~3 chars per token
    baseTokens = Math.ceil(len / 3);
  } else if (hasCode) {
    // Code is dense: short identifiers, operators, syntax chars
    // Estimate: ~3.5 chars per token
    baseTokens = Math.ceil(len / 3.5);
  } else {
    // Natural language: ~4-5 chars per token, or ~1.3 tokens per word
    // Use word-based estimation for better accuracy
    const words = clean.split(/\s+/).length;
    baseTokens = Math.ceil(words * 1.3);

    // Sanity check against char-based estimation
    const charBasedTokens = Math.ceil(len / 4.5);
    baseTokens = Math.max(baseTokens, charBasedTokens);
  }

  // Add overhead for message formatting tokens
  // (role markers, separators, special tokens like <|im_start|>, etc.)
  const overhead = 5;

  return Math.max(4, baseTokens + overhead);
}

/**
 * Clamps output token limit to valid range.
 * Ensures requests stay within Gemini API constraints (max 65,536 tokens).
 * Defaults to 16,384 tokens for balanced response length and quota usage.
 */
function clampOutputTokens(
  requested: number | undefined,
  _thinking: boolean
): number {
  let val = typeof requested === 'number' && requested > 0 ? requested : 16384;
  val = Math.min(val, MAX_OUTPUT_TOKENS);
  return val;
}

/**
 * Delays execution for specified milliseconds.
 * Used for retry backoff and pacing.
 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Gets the timestamp for the start of today in Pacific Time.
 * Used for daily quota (RPD) tracking that resets at midnight PT.
 */
function getPacificMidnight(): number {
  const now = new Date();
  // Convert to Pacific Time (UTC-8 or UTC-7 during DST)
  const pacificTime = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
  );
  pacificTime.setHours(0, 0, 0, 0);
  return pacificTime.getTime();
}

/**
 * Classifies API errors for retry logic and user messaging.
 * Handles authentication, rate limits, service overload, and network errors.
 */
function classifyError(err: any): {
  retryable: boolean;
  category: 'auth' | 'rate' | 'quota' | 'canceled' | 'other';
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err && (err.status || err.code || err.statusCode)) as
    | number
    | string
    | undefined;

  if (/abort/i.test(message))
    return { retryable: false, category: 'canceled', message };
  if (
    status === 401 ||
    /UNAUTHENTICATED|permission|unauthorized|API key/i.test(message)
  )
    return { retryable: false, category: 'auth', message };
  if (/quota/i.test(message) && /exceed|exhaust/i.test(message))
    return { retryable: false, category: 'quota', message };
  if (status === 429 || /rate|RESOURCE_EXHAUSTED/i.test(message))
    return { retryable: true, category: 'rate', message };

  // Gemini-specific error handling
  if (/overloaded|503|Service Unavailable/i.test(message))
    return {
      retryable: true,
      category: 'other',
      message: 'Gemini API overloaded - retrying...',
    };
  if (/Failed to parse stream|parse.*stream/i.test(message))
    return {
      retryable: true,
      category: 'other',
      message: 'Network stream error - retrying...',
    };
  if (/Error fetching/i.test(message))
    return {
      retryable: true,
      category: 'other',
      message: 'Network connection error - retrying...',
    };

  if (status && typeof status === 'number' && status >= 500 && status < 600)
    return { retryable: true, category: 'other', message };
  return { retryable: false, category: 'other', message };
}
