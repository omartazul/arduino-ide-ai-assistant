/**
 * Main widget for Spectre AI assistant.
 * Provides chat interface with basic Q&A and autonomous agent mode.
 *
 * @author Tazul Islam
 */

import React, { ChangeEvent } from '@theia/core/shared/react';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import {
  injectable,
  inject,
  postConstruct,
} from '@theia/core/shared/inversify';
import {
  SpectreAiService,
  SpectreAiClient,
  SpectreQuotaUpdate,
} from '../../common/protocol/spectre-ai-service';
import { SpectreAiFrontendClient } from './spectre-ai-frontend-client';
import {
  spectreLog,
  spectreWarn,
  spectreError,
  SKETCH_CONSTANTS,
  ValidationResult,
} from '../../common/protocol/spectre-types';

/**
 * Parameters for function calling mode.
 */
interface FunctionCallingParams {
  text: string;
  requestSeq: number;
  abortKey: string;
  model: string;
  sketchFiles: Array<{ path: string; content: string }>;
}

/**
 * Parameters for generation success handling.
 */
interface GenerationSuccessParams {
  res: any;
  requestSeq: number;
  abortKey: string;
  text: string;
  model: string;
  estTokens: number;
  current: ChatSession;
}

/**
 * Parameters for processing function calls.
 */
interface ProcessFunctionCallsParams {
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

/**
 * Parameters for finding line matches in diff computation.
 */
interface FindLineMatchParams {
  oldLines: string[];
  newLines: string[];
  oldIdx: number;
  newIdx: number;
  decorations: any[];
  contentWidgets: any[];
}

/**
 * Widget-specific timing constants.
 * Centralized for easy tuning and consistency across operations.
 */
const WIDGET_TIMING = {
  // Sketch/Board operation delays
  SKETCH_SAVE_DELAY: 500, // Wait for file save to complete
  BOARD_SELECTION_DELAY: 500, // Wait for board selection to propagate
  PORT_SELECTION_DELAY: 300, // Wait for port selection to propagate

  // Compilation and upload timeouts
  COMPILATION_CHECK_DELAY: 600, // Initial wait before checking compilation output
  COMPILATION_TIMEOUT: 4000, // Wait for compilation to complete
  UPLOAD_PREPARATION_DELAY: 2000, // Wait before upload starts
  UPLOAD_START_DELAY: 3000, // Wait for upload to start
  UPLOAD_PROCESS_DELAY: 1000, // Wait for upload process to begin

  // Agent mode operation delays
  AGENT_ERROR_DELAY: 3000, // Wait after agent encounters error

  // UI interaction delays
  FOCUS_INPUT_DELAY: 50, // Delay before focusing input (allow DOM updates)
  COPY_FEEDBACK_DURATION: 1500, // Duration to show copy/paste success feedback
  DECORATION_AUTO_REMOVE: 30000, // Auto-remove code decorations after 30 seconds

  // Service readiness delays
  SERVICE_READY_WAIT: 2000, // Wait for backend service to be ready

  // Streaming and polling
  STREAM_FALLBACK_TIMEOUT: 5000, // Force complete stream if ticker hangs
  PACKAGE_INDEX_POLL_INTERVAL: 500, // Poll interval for package index updates
} as const;

import { ArduinoPreferences } from '../arduino-preferences';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import {
  SketchesServiceClientImpl,
  CurrentSketch,
} from '../sketches-service-client-impl';
import { CommandService } from '@theia/core/lib/common/command';
import { OutputChannelManager } from '../theia/output/output-channel';
import { EditorManager } from '../theia/editor/editor-manager';
import { URI } from '@theia/core/lib/common/uri';
import { BoardsServiceProvider } from '../boards/boards-service-provider';
import { BoardsDataStore } from '../boards/boards-data-store';
import { BoardsService } from '../../common/protocol/boards-service';
import { DetectedPort } from '../../common/protocol/boards-service';
import { MonitorManagerProxyClient } from '../../common/protocol';
import { LibraryService } from '../../common/protocol/library-service';
import { ConfigService } from '../../common/protocol/config-service';
import { MemoryManager } from './memory-manager';
import { ConversationMemory, RawMessage } from './memory-types';
import { TokenCounter } from './token-counter';

let ReactMarkdownLazy: any;

/**
 * Represents a single message in a chat conversation.
 * @deprecated Use RawMessage from memory-types.ts instead.
 * Kept for backwards compatibility during migration.
 */
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Represents a complete chat session with the AI assistant.
 * Now includes dynamic memory management with rolling buffer and summarization.
 */
interface ChatSession {
  id: number;
  title: string;
  messages: ChatMessage[]; // Legacy field, migrated to ConversationMemory
  memory?: ConversationMemory; // New memory system
}

/**
 * Tracks individual API requests for quota and rate limit monitoring.
 */
interface RequestLog {
  timestamp: number;
  tokensUsed: number;
  model: string;
  success: boolean;
}

/**
 * Aggregates daily API usage statistics for quota tracking.
 */
interface DailyTracker {
  date: string; // YYYY-MM-DD in Pacific Time
  requestCount: number;
  tokenCount: number;
}

/**
 * Task tracking for agent mode workflow (inspired by GitHub Copilot).
 * Tracks individual autonomous actions the AI performs like creating sketches,
 * verifying code, uploading to boards, etc.
 */
interface AgentTask {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  error?: string;
  actionType: string; // 'create_sketch', 'verify_sketch', etc.
}

/**
 * Main widget for the Spectre AI assistant.
 *
 * Provides a chat interface for interacting with Google's Gemini AI models.
 * Supports two modes:
 * - Basic Mode: Simple Q&A with the AI about Arduino development
 * - Agent Mode: Autonomous task execution where AI can create sketches, verify code,
 *   upload to boards, and perform other IDE actions
 *
 * Features:
 * - Multiple chat sessions
 * - Code block extraction and "Use Code" functionality
 * - Real-time streaming responses
 * - Quota and rate limit tracking
 * - Sketch-specific context awareness
 * - Task tracking for agent mode
 */
@injectable()
export class SpectreWidget extends ReactWidget implements SpectreAiClient {
  static readonly ID = 'arduino-spectre-widget';
  static readonly LABEL = 'Spectre';

  @inject(SpectreAiService) private readonly ai: SpectreAiService;
  @inject(SpectreAiFrontendClient)
  private readonly aiClient: SpectreAiFrontendClient;
  @inject(ArduinoPreferences) private readonly prefs: ArduinoPreferences;
  @inject(StorageService) private readonly storage: StorageService;
  @inject(SketchesServiceClientImpl)
  private readonly sketchesClient: SketchesServiceClientImpl;
  @inject(CommandService) private readonly commands: CommandService;
  @inject(OutputChannelManager)
  private readonly outputChannels: OutputChannelManager;
  @inject(EditorManager) private readonly editorManager: EditorManager;
  @inject(BoardsServiceProvider)
  private readonly boardsServiceProvider: BoardsServiceProvider;
  @inject(BoardsService) private readonly boardsService!: BoardsService;
  @inject(BoardsDataStore) private readonly boardsDataStore: BoardsDataStore;
  @inject(MonitorManagerProxyClient)
  private readonly monitorManagerProxy!: MonitorManagerProxyClient;
  @inject(LibraryService) private readonly libraryService!: LibraryService;
  @inject(ConfigService) private readonly configService!: ConfigService;
  @inject(MemoryManager) private readonly memoryManager!: MemoryManager;

  // Cache normalized board data for O(1) lookups
  private boardSearchCache: Map<
    string,
    {
      board: any;
      normalizedName: string;
      normalizedWords: string[];
      lastUpdated: number;
    }
  > | null = null;

  private readonly BOARD_CACHE_TTL_MS = 60000; // 1 minute cache TTL

  private stateData: {
    sessions: ChatSession[];
    active: number;
    input: string;
    busy: boolean;
    error?: string;
    retryable?: boolean;
    requestSeq: number;
    sketchKey?: string;
    currentAbortKey?: string;
    quotaUsed: number;
    quotaCapacity: number;
    rpmUsed: number;
    rpmLimit: number;
    queueSize: number;
    nextAvailableMs: number;
    now: number;
    // Request tracking
    requestLogs: RequestLog[];
    dailyTracker: DailyTracker;
    // Agent task tracking
    tasks: AgentTask[];
    tasksExpanded: boolean;
    tasksClosed: boolean;
    // Code diff tracking for showing changes
    codeDiff?: {
      oldCode: string;
      newCode: string;
      timestamp: number;
      expanded: boolean;
    };
    // Memory system stats for UI display
    memoryStats?: {
      recentMessages: number;
      summaries: number;
      totalTokens: number;
      memoryBankTokens: number;
      compressionRatio: string;
      isSummarizing?: boolean; // Show loading indicator
    };
  } = {
    sessions: [{ id: Date.now(), title: 'New Chat', messages: [] }],
    active: 0,
    input: '',
    busy: false,
    requestSeq: 0,
    quotaUsed: 0,
    quotaCapacity: 250000,
    rpmUsed: 0,
    rpmLimit: 10, // Placeholder, set correctly in postConstruct
    queueSize: 0,
    nextAvailableMs: Date.now(),
    now: Date.now(),
    requestLogs: [],
    dailyTracker: {
      date: this.getPacificDate(),
      requestCount: 0,
      tokenCount: 0,
    },
    tasks: [],
    tasksExpanded: false,
    tasksClosed: false,
    codeDiff: undefined,
  };

  private sending = false;
  private lastSendAt = 0;
  private clockTicker?: number;
  // Focus target for activation
  private inputRef?: HTMLTextAreaElement | null;

  // Current streaming state
  private currentAbortKey?: string;
  private currentRequestSeq?: number;
  // Buffered streaming reveal
  private streamBuffer = '';
  private streamTicker?: number;
  private streamDone = false;
  private streamStarted = false;
  private streamFallbackTimer?: number;

  // Timer tracking for proper cleanup and memory leak prevention
  private readonly feedbackTimers: Set<number> = new Set(); // Button feedback animations
  private readonly decorationTimers: Set<number> = new Set(); // Editor decoration auto-remove

  /**
   * Handles stream error events.
   */
  private handleStreamError(error: string, requestSeq: number): void {
    this.stopStreamTicker();
    this.mutateLastAssistant(
      (prev) => prev + `\n\nError: ${error}`,
      requestSeq
    );
    this.setStateData({ busy: false, currentAbortKey: undefined });
    this.focusInput();
  }

  /**
   * Handles stream completion with immediate flush.
   */
  private handleStreamImmediateCompletion(requestSeq: number): void {
    if (this.streamBuffer.length > 0) {
      const remaining = this.streamBuffer;
      this.streamBuffer = '';
      this.mutateLastAssistant((prev) => prev + remaining, requestSeq);
    }
    this.setStateData({ busy: false, currentAbortKey: undefined });
    this.focusInput();
  }

  /**
   * Sets up fallback timer for stream completion.
   */
  private setupStreamFallbackTimer(): void {
    this.streamDone = true;
    // Cancel any existing fallback timer to prevent leaks
    if (this.streamFallbackTimer) {
      clearTimeout(this.streamFallbackTimer);
    }
    // Fallback: if ticker doesn't complete within 5 seconds, force completion
    this.streamFallbackTimer = window.setTimeout(() => {
      if (this.streamDone && this.streamTicker) {
        spectreWarn('Stream ticker timeout - forcing completion');
        this.stopStreamTicker();
        if (
          this.streamBuffer.length > 0 &&
          this.currentRequestSeq !== undefined
        ) {
          const seq = this.currentRequestSeq;
          const remaining = this.streamBuffer;
          this.streamBuffer = '';
          this.mutateLastAssistant((prev) => prev + remaining, seq);
        }
        this.setStateData({ busy: false, currentAbortKey: undefined });
        this.focusInput();
      }
      this.streamFallbackTimer = undefined;
    }, WIDGET_TIMING.STREAM_FALLBACK_TIMEOUT);
  }

  /**
   * SpectreAiClient callback for receiving streaming AI response chunks.
   * Buffers text deltas and uses a ticker to smoothly reveal them in the UI.
   * Handles errors and completion signals.
   */
  onStream(event: {
    key: string;
    delta?: string;
    done?: boolean;
    error?: string;
  }): void {
    if (!this.isValidStreamEvent(event)) {
      return;
    }

    if (this.currentRequestSeq === undefined) {
      spectreWarn('Received stream event for unknown request sequence - ignoring');
      return;
    }

    if (event.error) {
      this.handleStreamError(event.error, this.currentRequestSeq);
      return;
    }

    if (event.delta) {
      this.handleStreamDelta(event.delta, this.currentRequestSeq);
    }

    if (event.done) {
      this.handleStreamCompletion(this.currentRequestSeq);
    }
  }

  private isValidStreamEvent(event: { key: string }): boolean {
    return !!(this.currentAbortKey && event.key === this.currentAbortKey);
  }

  private handleStreamDelta(delta: string, requestSeq: number): void {
    if (!this.streamStarted) this.streamStarted = true;
    this.streamBuffer += delta;
    this.startStreamTicker(requestSeq);
  }

  private handleStreamCompletion(requestSeq: number): void {
    if (!this.streamTicker) {
      this.handleStreamImmediateCompletion(requestSeq);
    } else {
      this.setupStreamFallbackTimer();
    }
  }

  /**
   * SpectreAiClient callback for receiving quota/usage updates from the backend.
   * Updates widget state to reflect current API quota usage and rate limits.
   */
  onQuota(update: SpectreQuotaUpdate): void {
    // Server quota is authoritative - update widget state to reflect backend tracking
    this.setStateData({
      quotaUsed: update.usedTokens,
      quotaCapacity: update.capacity,
      rpmUsed: update.rpmUsed,
      rpmLimit: update.rpmLimit,
      queueSize: update.queued,
      nextAvailableMs: update.nextAvailableMs,
    });
  }

  constructor() {
    super();
    this.id = SpectreWidget.ID;
    this.title.label = SpectreWidget.LABEL;
    this.title.caption = SpectreWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = 'spectre-icon';
    this.addClass('arduino-spectre-widget');
  }

  /**
   * Lifecycle: Called after dependency injection completes, before widget attachment.
   * Initializes state that requires injected dependencies.
   * Sets the correct RPM limit immediately based on the persisted model preference.
   */
  @postConstruct()
  protected init(): void {
    // Initialize RPM limit based on current model preference (flash=10, flash-lite=15)
    // This ensures the correct limit is shown immediately when the widget renders,
    // before the async backend quota sync in onAfterAttach() completes
    const initialRpmLimit = this.getRpmLimit();
    this.stateData.rpmLimit = initialRpmLimit;
  }

  /**
   * CRITICAL: Clean up all timers and resources when widget is disposed.
   * Prevents memory leaks from orphaned timers and intervals.
   */
  override dispose(): void {
    // Clean up streaming timers
    this.stopStreamTicker(); // Clears both streamTicker and streamFallbackTimer

    // Clean up clock ticker
    this.stopClock();

    // Clean up all button feedback timers to prevent memory leaks
    this.feedbackTimers.forEach((timerId) => clearTimeout(timerId));
    this.feedbackTimers.clear();

    // Clean up all decoration timers to prevent memory leaks
    this.decorationTimers.forEach((timerId) => clearTimeout(timerId));
    this.decorationTimers.clear();

    // Call parent dispose to clean up React root and base widget resources
    super.dispose();
  }

  /**
   * Safely extracts error message from unknown error type.
   * Handles Error objects, strings, and other types.
   * @param error - The caught error (unknown type)
   * @returns Human-readable error message string
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return String(error);
  }

  /**
   * Asynchronous delay utility for consistent timing operations.
   *
   * Provides a clean, Promise-based alternative to setTimeout with improved:
   * @param ms - Milliseconds to delay
   * @returns Promise that resolves after the specified delay
   *
   * @example
   * // Wait for file save to complete
   * await this.delay(WIDGET_TIMING.SKETCH_SAVE_DELAY);
   *
   * @example
   * // Wait with custom delay
   * await this.delay(1000); // 1 second
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Gets the current date in Pacific Time as YYYY-MM-DD string.
   * Used for daily request/token tracking with midnight resets.
   */
  private getPacificDate(): string {
    const now = new Date();
    // Convert to Pacific Time (UTC-8/UTC-7 depending on DST)
    const pacificTime = new Date(
      now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
    );
    return pacificTime.toISOString().split('T')[0];
  }

  /**
   * Logs a request with timestamp and token usage for RPM/RPD tracking.
   * Automatically cleans up old logs and resets daily counters.
   */
  private logRequest(tokensUsed: number, model: string, success = true): void {
    const timestamp = Date.now();
    const currentDate = this.getPacificDate();

    // Reset daily tracker if date changed (midnight Pacific Time rollover)
    if (this.stateData.dailyTracker.date !== currentDate) {
      this.stateData.dailyTracker = {
        date: currentDate,
        requestCount: 0,
        tokenCount: 0,
      };
    }

    // Add new request log
    this.stateData.requestLogs.push({
      timestamp,
      tokensUsed,
      model,
      success,
    });

    // Update daily tracker
    this.stateData.dailyTracker.requestCount += 1;
    this.stateData.dailyTracker.tokenCount += tokensUsed;

    // Lazy cleanup: Only clean when array exceeds threshold (amortized O(1))
    const LOG_CLEANUP_THRESHOLD = 200;
    if (this.stateData.requestLogs.length > LOG_CLEANUP_THRESHOLD) {
      const sixtySecondsAgo = timestamp - 60 * 1000;
      this.stateData.requestLogs = this.stateData.requestLogs.filter(
        (log) => log.timestamp > sixtySecondsAgo
      );
    }

    // Update state to trigger UI refresh
    this.setStateData({
      requestLogs: [...this.stateData.requestLogs],
      dailyTracker: { ...this.stateData.dailyTracker },
    });
  }

  /**
   * Calculates current RPM based on requests in the last 60 seconds.
   */
  private calculateCurrentRpm(): number {
    const now = Date.now();
    const sixtySecondsAgo = now - 60 * 1000;
    return this.stateData.requestLogs.filter(
      (log) => log.timestamp > sixtySecondsAgo && log.success
    ).length;
  }

  /**
   * Gets the programming language for syntax highlighting based on file extension.
   */
  private readonly FILE_LANGUAGE_MAP: { [key: string]: string } = {
    ino: 'cpp',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    c: 'c',
    js: 'javascript',
    py: 'python',
  };

  private getFileLanguage(filePath: string): string {
    const ext = filePath.toLowerCase().split('.').pop();
    return this.FILE_LANGUAGE_MAP[ext || ''] || '';
  }

  /**
   * Executes an IDE action based on the AI's instructions.
   * This is the core agent mode functionality.
   */

  /**
   * Agent action methods for autonomous development board operations
   */
  private async agentCreateSketch(
    name?: string,
    code?: string
  ): Promise<string> {
    spectreLog('🔧 Creating sketch - checking current sketch first...');

    const currentSketch = await this.sketchesClient.currentSketch();

    if (CurrentSketch.isValid(currentSketch)) {
      return await this.handleExistingSketch(currentSketch, code);
    }

    spectreLog('🔧 No valid sketch found, creating new one...');
    await this.commands.executeCommand('arduino-new-sketch');

    if (code) {
      return await this.createNewSketchWithCode(code);
    }

    return `✅ COMPLETED: New blank sketch created and ready in the editor. DO NOT call create_sketch again. If you need to add code, use modify_sketch.`;
  }

  private async handleExistingSketch(currentSketch: any, code?: string): Promise<string> {
    spectreLog('🔧 Found existing sketch, using it:', currentSketch.name);

    if (code) {
      await this.agentModifySketch(
        `${currentSketch.uri}/${currentSketch.name}.ino`,
        code
      );
      return `✅ COMPLETED: Updated existing sketch "${currentSketch.name}" with the requested code. The sketch is now ready in the editor. DO NOT call create_sketch again - the task is complete.`;
    } else {
      return `✅ COMPLETED: Sketch "${currentSketch.name}" already exists and is open in the editor. DO NOT create it again - it is ready for use. If you need to modify it, use the code in the current sketch.`;
    }
  }

  private async createNewSketchWithCode(code: string): Promise<string> {
    spectreLog('🔧 Waiting for new sketch to be created and editor to be ready...');
    await this.delay(WIDGET_TIMING.AGENT_ERROR_DELAY);

    const sketch = await this.waitForSketchReady();

    if (CurrentSketch.isValid(sketch)) {
      spectreLog('🔧 Sketch is ready, adding code to:', sketch.name);
      await this.agentModifySketch(`${sketch.uri}/${sketch.name}.ino`, code);
      return `✅ COMPLETED: Created new sketch "${sketch.name}" with your MQ-5 sensor code. The sketch is now open in the editor with all the code you requested. DO NOT call create_sketch again - the task is finished. If you need to verify or upload, use those specific functions.`;
    } else {
      return `❌ ERROR: Sketch creation succeeded but could not access the sketch file after ${SKETCH_CONSTANTS.MAX_SKETCH_CREATION_RETRIES} retries. Please try manually creating a new sketch (File → New Sketch) and then ask me to add the code.`;
    }
  }

  private async waitForSketchReady(): Promise<any> {
    let retries = SKETCH_CONSTANTS.MAX_SKETCH_CREATION_RETRIES;
    let sketch: any = null;

    while (retries > 0 && !CurrentSketch.isValid(sketch)) {
      sketch = await this.sketchesClient.currentSketch();
      spectreLog(
        '🔧 Attempt',
        SKETCH_CONSTANTS.MAX_SKETCH_CREATION_RETRIES + 1 - retries,
        '- sketch valid:',
        CurrentSketch.isValid(sketch)
      );
      if (!CurrentSketch.isValid(sketch)) {
        await this.delay(SKETCH_CONSTANTS.SKETCH_CREATION_RETRY_DELAY);
        retries--;
      }
    }

    return sketch;
  }

  /**
   * Reads the content of the currently open sketch.
   * Returns the complete sketch code or throws on error.
   */
  private async agentReadSketch(): Promise<string> {
    spectreLog('📖 Reading current sketch...');

    // Get the currently open sketch
    const currentSketch = await this.sketchesClient.currentSketch();

    if (!CurrentSketch.isValid(currentSketch)) {
      throw new Error(
        'No sketch is currently open. Please create or open a sketch first.'
      );
    }

    spectreLog('📖 Reading sketch:', currentSketch.name);

    // Get the current editor (which should have the sketch file open)
    const currentEditor = this.editorManager.currentEditor;
    if (!currentEditor) {
      throw new Error('No editor is currently active.');
    }

    // Get the document content from the editor
    const document = currentEditor.editor.document;
    const code = document.getText();

    spectreLog('📖 Successfully read sketch, length:', code.length);
    return `✅ Current sketch: ${currentSketch.name}\n\n\`\`\`cpp\n${code}\n\`\`\``;
  }

  /**
   * Reads content from Arduino output channel with fallback strategies.
   * Attempts multiple methods to retrieve output channel text, handling
   * different Theia/Monaco API versions gracefully.
   *
   * @returns Output channel content or empty string if unavailable
   */
  private async readArduinoOutputChannel(): Promise<string> {
    const modernResult = await this.tryModernChannelApi();
    if (modernResult !== null) {
      return modernResult;
    }

    const outputChannel = this.outputChannels.getChannel('Arduino');
    if (!outputChannel) {
      spectreWarn('Arduino output channel not found');
      return '';
    }

    return this.extractChannelText(outputChannel);
  }

  private async tryModernChannelApi(): Promise<string | null> {
    try {
      const managerAny = this.outputChannels as any;
      if (typeof managerAny.contentOfChannel === 'function') {
        return (await managerAny.contentOfChannel('Arduino')) || '';
      }
    } catch {
      // Fallback to direct channel access
    }
    return null;
  }

  private extractChannelText(outputChannel: any): string {
    try {
      if ('getText' in outputChannel) {
        return outputChannel.getText();
      }
      if ('text' in outputChannel) {
        return outputChannel.text;
      }
      if ('append' in outputChannel && 'clear' in outputChannel) {
        if (outputChannel._lines) {
          return outputChannel._lines.join('\n');
        }
        if (outputChannel.document?.getText) {
          return outputChannel.document.getText();
        }
      }
    } catch (err) {
      spectreWarn('Failed to read output channel:', err);
    }
    return '';
  }

  /**
   * Checks for compilation or upload errors in the Arduino output channel.
   * Returns error details if found, or null if no errors detected.
   */

  /**
   * Compilation error patterns.
   */
  private readonly COMPILATION_ERROR_PATTERNS = [
    /error:/gi,
    /compilation terminated/gi,
    /undefined reference/gi,
    /was not declared/gi,
    /expected.*before/gi,
    /stray.*in program/gi,
    /missing terminating/gi,
    /fatal error:/gi,
    /syntax error/gi,
    /cannot find/gi,
    /not found/gi,
    /failed to compile/gi,
  ];

  /**
   * Upload error patterns for all platforms.
   */
  private readonly UPLOAD_ERROR_PATTERNS = [
    /upload.*error/gi,
    /upload.*failed/gi,
    /upload.*timeout/gi,
    /flash.*error/gi,
    /flash.*failed/gi,
    /programmer.*error/gi,
    /programmer.*failed/gi,
    /can't open.*port/gi,
    /cannot open.*port/gi,
    /ser_open.*failed/gi,
    /ser_open.*can't open/gi,
    /semaphore timeout/gi,
    /exit status 1/gi,
    /uploading error/gi,
    /failed uploading/gi,
    /permission denied/gi,
    /device busy/gi,
    /access denied/gi,
    /device not found/gi,
    /port.*busy/gi,
    /port.*in use/gi,
    /avrdude.*error/gi,
    /avrdude.*failed/gi,
    /esptool.*error/gi,
    /esptool.*failed/gi,
    /openocd.*error/gi,
    /stlink.*error/gi,
  ];

  /**
   * Scans lines for errors using provided patterns.
   */
  private scanLinesForErrors(
    lines: string[],
    patterns: RegExp[]
  ): string[] {
    const errorLines: string[] = [];
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      if (patterns.some((pattern: RegExp) => pattern.test(trimmedLine))) {
        errorLines.push(trimmedLine);
      }
    }
    return errorLines;
  }

  /**
   * Checks for potential error keywords in lines.
   */
  private findPotentialErrors(lines: string[]): string[] {
    return lines.filter(
      (line: string) =>
        line.toLowerCase().includes('error') ||
        line.toLowerCase().includes('failed') ||
        line.toLowerCase().includes('timeout')
    );
  }

  private async checkCompilationErrors(): Promise<string | null> {
    try {
      const content = await this.readArduinoOutputChannel();
      if (!content) return null;

      spectreLog('📋 Output channel content length:', content.length);
      spectreLog(
        '📋 Last chars of output:',
        content.slice(-SKETCH_CONSTANTS.DEBUG_OUTPUT_CHAR_LIMIT)
      );

      // Get the last N lines to focus on recent output
      const lines = content.split('\n');
      const recentLines = lines.slice(
        -SKETCH_CONSTANTS.RECENT_OUTPUT_LINE_COUNT
      );

      // Scan for errors using patterns
      const uploadErrorLines = this.scanLinesForErrors(
        recentLines,
        this.UPLOAD_ERROR_PATTERNS
      );
      const compilationErrorLines = this.scanLinesForErrors(
        recentLines,
        this.COMPILATION_ERROR_PATTERNS
      );

      // Upload errors take priority as they're more specific
      if (uploadErrorLines.length > 0) {
        spectreLog('🔴 Upload errors detected:', uploadErrorLines);
        return uploadErrorLines.join('\n');
      }

      if (compilationErrorLines.length > 0) {
        spectreLog('🔴 Compilation errors detected:', compilationErrorLines);
        return compilationErrorLines.join('\n');
      }

      // Additional check: look for potential error keywords
      const potentialErrors = this.findPotentialErrors(recentLines);

      if (potentialErrors.length > 0) {
        spectreLog('🟡 Potential errors found:', potentialErrors);
        return potentialErrors.join('\n');
      }

      spectreLog('✅ No errors detected in output channel');
      return null;
    } catch (error) {
      spectreWarn('Failed to check compilation errors:', error);
      return null;
    }
  }

  /**
   * Check if board is selected and optionally if port is selected
   */
  private validateBoardAndPort(requirePort = false): ValidationResult {
    const currentConfig = this.boardsServiceProvider.boardsConfig;
    const selectedBoard = currentConfig.selectedBoard;
    const selectedPort = currentConfig.selectedPort;

    spectreLog(
      '🔍 Current board selection:',
      selectedBoard?.name || 'No board selected'
    );
    spectreLog(
      '🔍 Current port selection:',
      selectedPort?.address || 'No port selected'
    );

    if (!selectedBoard) {
      return {
        valid: false,
        message:
          '❌ No board selected. Please select a board first using [ACTION:GET_BOARDS] to see available boards, then [ACTION:SELECT_BOARD:board_name].',
      };
    }

    if (requirePort && !selectedPort) {
      return {
        valid: false,
        message:
          '❌ No port selected. Please select a port first using [ACTION:GET_PORTS] to see available ports, then [ACTION:SELECT_PORT:port_address].',
      };
    }

    return {
      valid: true,
      board: selectedBoard,
      port: selectedPort,
    };
  }

  private async agentVerifySketch(): Promise<string> {
    // Wait a moment to ensure any file operations are complete
    await this.delay(WIDGET_TIMING.SKETCH_SAVE_DELAY);

    const sketch = await this.sketchesClient.currentSketch();
    if (!CurrentSketch.isValid(sketch)) {
      throw new Error('No valid sketch is currently open');
    }

    spectreLog('🔍 Checking current board selection before verification...');

    // Validate board selection (port is optional for verification)
    const validation = this.validateBoardAndPort(false);
    if (!validation.valid) {
      throw new Error(validation.message!);
    }

    spectreLog('🔧 Executing sketch verification...');

    // Execute verification and wait for completion
    spectreLog('🚀 Starting verification command...');
    await this.commands.executeCommand('arduino-verify-sketch');
    spectreLog('✅ Verification command completed, checking for errors...');

    // Give more time for any output to appear
    await this.delay(WIDGET_TIMING.COMPILATION_TIMEOUT);

    // Check output channel for errors multiple times
    let verificationErrors = await this.checkCompilationErrors();

    // If no errors found immediately, wait a bit more and check again
    if (!verificationErrors) {
      spectreLog('🔍 No immediate errors, waiting and checking again...');
      await this.delay(WIDGET_TIMING.UPLOAD_PREPARATION_DELAY);
      verificationErrors = await this.checkCompilationErrors();
    }

    if (verificationErrors) {
      spectreLog('🔴 Verification errors detected:', verificationErrors);
      throw new Error(
        `Sketch verification failed with errors:\n\n${verificationErrors}\n\n⚠️ Please fix these compilation errors before proceeding.`
      );
    }

    spectreLog('✅ Verification appears successful');
    return `✅ Sketch verification completed successfully for: ${sketch.name}`;
  }

  /**
   * Pattern categories for upload output analysis.
   */
  private readonly UPLOAD_PATTERN_CATEGORIES = {
    criticalError: [
      /compilation terminated/i,
      /undefined reference/i,
      /was not declared/i,
      /expected.*before/i,
      /fatal error/i,
      /syntax error/i,
      /failed to compile/i,
      /sketch too big/i,
      /no such file/i,
    ],
    portError: [
      /avrdude.*(timeout|can't open|cannot open|access.*denied|permission.*denied)/i,
      /ser_open.*(failed|can't open|access.*denied)/i,
      /semaphore timeout/i,
      /device (busy|not found|access.*denied)/i,
      /port.*(busy|in use|access.*denied|not available)/i,
      /system cannot find.*specified/i,
      /the handle is invalid/i,
    ],
    uploadError: [
      /upload(ing)? error/i,
      /failed uploading/i,
      /flash.*error/i,
      /flash.*failed/i,
      /programmer.*error/i,
      /programmer.*failed/i,
      /exit status 1/i,
      /avrdude.*error(?!.*done)/i,
      /avrdude.*failed/i,
      /esptool.*error/i,
      /esptool.*failed/i,
      /openocd.*error/i,
      /stlink.*error/i,
    ],
    success: [
      /writing.*\d+.*bytes/i,
      /reading.*\d+.*bytes/i,
      /verifying.*\d+.*bytes/i,
      /\d+.*bytes.*written/i,
      /\d+.*bytes.*verified/i,
      /\d+.*bytes.*programmed/i,
      /upload.*complete/i,
      /uploading.*done/i,
      /flash.*complete/i,
      /programming.*complete/i,
      /programming.*successful/i,
      /received port after upload/i,
      /hard resetting/i,
      /reset.*complete/i,
      /target.*connected/i,
      /connecting\.\.\.../i,
      /leaving\.\.\.../i,
      /avrdude.*done/i,
      /avrdude\s*:\s*done/i,
      /esptool.*done/i,
      /openocd.*shutdown/i,
      /stlink.*programming.*successful/i,
    ],
    normalBuildOutput: [
      /sketch uses.*bytes/i,
      /global variables use.*bytes/i,
      /maximum is.*bytes/i,
    ],
  };

  /**
   * Categorizes a single output line by checking against all pattern categories.
   * Returns the category name or null if no match found.
   */
  private categorizeLine(
    line: string
  ): keyof typeof this.UPLOAD_PATTERN_CATEGORIES | 'generic' | null {
    // Check each category in order of priority
    for (const pattern of this.UPLOAD_PATTERN_CATEGORIES.criticalError) {
      if (pattern.test(line)) return 'criticalError';
    }

    for (const pattern of this.UPLOAD_PATTERN_CATEGORIES.portError) {
      if (pattern.test(line)) return 'portError';
    }

    for (const pattern of this.UPLOAD_PATTERN_CATEGORIES.uploadError) {
      if (pattern.test(line)) return 'uploadError';
    }

    for (const pattern of this.UPLOAD_PATTERN_CATEGORIES.success) {
      if (pattern.test(line)) return 'success';
    }

    for (const pattern of this.UPLOAD_PATTERN_CATEGORIES.normalBuildOutput) {
      if (pattern.test(line)) return 'normalBuildOutput';
    }

    // Check for generic errors
    if (
      /\b(error|failed|failure|exception)\b/i.test(line) &&
      !/warning/i.test(line)
    ) {
      return 'generic';
    }

    return null;
  }

  /**
   * Categorizes all upload output lines into their respective categories.
   */
  private categorizeUploadLines(lines: string[]): {
    criticalErrors: string[];
    portErrors: string[];
    uploadErrors: string[];
    successLines: string[];
    normalBuildLines: string[];
    genericErrors: string[];
  } {
    const categorized: {
      criticalErrors: string[];
      portErrors: string[];
      uploadErrors: string[];
      successLines: string[];
      normalBuildLines: string[];
      genericErrors: string[];
    } = {
      criticalErrors: [],
      portErrors: [],
      uploadErrors: [],
      successLines: [],
      normalBuildLines: [],
      genericErrors: [],
    };

    for (const line of lines) {
      const category = this.categorizeLine(line);

      if (category === 'criticalError') {
        categorized.criticalErrors.push(line);
      } else if (category === 'portError') {
        categorized.portErrors.push(line);
      } else if (category === 'uploadError') {
        categorized.uploadErrors.push(line);
      } else if (category === 'success') {
        categorized.successLines.push(line);
      } else if (category === 'normalBuildOutput') {
        categorized.normalBuildLines.push(line);
      } else if (category === 'generic') {
        categorized.genericErrors.push(line);
      }
    }

    return categorized;
  }

  /**
   * Checks if upload result has any actual errors.
   */
  private hasAnyErrors(categorized: {
    criticalErrors: string[];
    portErrors: string[];
    uploadErrors: string[];
    genericErrors: string[];
  }): boolean {
    return (
      categorized.criticalErrors.length > 0 ||
      categorized.portErrors.length > 0 ||
      categorized.uploadErrors.length > 0 ||
      categorized.genericErrors.length > 0
    );
  }

  /**
   * Determines success based on lack of content or normal build output.
   */
  private checkFallbackSuccess(
    categorized: { normalBuildLines: string[] },
    hasAnyContent: boolean,
    hasActualErrors: boolean
  ): { success: boolean; error?: string; shouldRetry?: boolean } | null {
    // Empty output considered success
    if (!hasAnyContent) {
      spectreLog('🔍 Empty upload output - considering successful');
      return { success: true, shouldRetry: false };
    }

    // Normal build output without errors
    if (categorized.normalBuildLines.length > 0) {
      spectreLog('🔍 Normal build output detected - considering successful');
      return { success: true, shouldRetry: false };
    }

    // No clear indicators - check for any actual errors
    if (!hasActualErrors) {
      spectreLog(
        '🔍 No error keywords found - assuming successful (best guess)'
      );
      return { success: true, shouldRetry: false };
    }

    return null;
  }

  /**
   * Determines upload result from categorized lines.
   */
  private determineUploadResult(
    categorized: {
      criticalErrors: string[];
      portErrors: string[];
      uploadErrors: string[];
      successLines: string[];
      normalBuildLines: string[];
      genericErrors: string[];
    },
    hasAnyContent: boolean
  ): { success: boolean; error?: string; shouldRetry?: boolean } {
    // Critical errors always fail
    if (categorized.criticalErrors.length > 0) {
      return {
        success: false,
        error: categorized.criticalErrors.join('\n'),
        shouldRetry: false,
      };
    }

    const hasStrongSuccess = categorized.successLines.length > 0;

    // Port errors are retryable
    if (categorized.portErrors.length > 0) {
      return {
        success: false,
        error: categorized.portErrors.join('\n'),
        shouldRetry: true,
      };
    }

    // Upload errors fail unless we have success indicators
    if (categorized.uploadErrors.length > 0 && !hasStrongSuccess) {
      return {
        success: false,
        error: categorized.uploadErrors.join('\n'),
        shouldRetry: false,
      };
    }

    // Strong success indicators
    if (hasStrongSuccess) {
      return { success: true, shouldRetry: false };
    }

    // Generic errors without success
    if (categorized.genericErrors.length > 0) {
      return {
        success: false,
        error: categorized.genericErrors.join('\n'),
        shouldRetry: false,
      };
    }

    // Check fallback success cases
    const hasActualErrors = this.hasAnyErrors(categorized);
    const fallbackResult = this.checkFallbackSuccess(
      categorized,
      hasAnyContent,
      hasActualErrors
    );

    if (fallbackResult) {
      return fallbackResult;
    }

    return {
      success: false,
      error: 'Upload result unclear - no success confirmation found',
    };
  }

  private analyzeUploadOutput(
    diff: string
  ): { success: boolean; error?: string; shouldRetry?: boolean } {
    const lines = diff
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l);

    const categorized = this.categorizeUploadLines(lines);
    const hasAnyContent = lines.length > 0;
    return this.determineUploadResult(categorized, hasAnyContent);
  }

  private async attemptUploadOnCurrentPort(): Promise<{
    ok: boolean;
    errText?: string;
    diff?: string;
    shouldRetry?: boolean;
  }> {
    const before = await this.readArduinoOutputChannel();
    
    const commandResult = await this.executeUploadCommand();
    if (!commandResult.success) {
      return commandResult.result;
    }

    await this.delay(WIDGET_TIMING.COMPILATION_TIMEOUT);
    const firstAttempt = await this.analyzeUploadAttempt(before);
    if (firstAttempt.ok) {
      return firstAttempt;
    }

    await this.delay(WIDGET_TIMING.UPLOAD_START_DELAY);
    return await this.analyzeUploadAttempt(before, firstAttempt);
  }

  private async executeUploadCommand(): Promise<{ success: boolean; result?: any }> {
    try {
      spectreLog('🚀 Starting upload command...');
      await this.commands.executeCommand('arduino-upload-sketch');
      return { success: true };
    } catch (e) {
      const msg = e?.message || String(e);
      return { success: false, result: { ok: false, errText: msg, shouldRetry: false } };
    }
  }

  private async analyzeUploadAttempt(before: string, previousAttempt?: any): Promise<any> {
    const after = await this.readArduinoOutputChannel();
    const diff = after.startsWith(before) ? after.slice(before.length) : after;
    const analysis = this.analyzeUploadOutput(diff);

    if (analysis.success) {
      return { ok: true, diff, shouldRetry: false };
    }

    if (this.shouldAssumeSuccessOnNoErrors(previousAttempt, analysis)) {
      return { ok: true, diff, shouldRetry: false };
    }

    if (previousAttempt) {
      return this.buildFinalUploadResult(analysis, previousAttempt, diff);
    }

    return { ok: false, analysis, diff };
  }

  private shouldAssumeSuccessOnNoErrors(previousAttempt: any, analysis: any): boolean {
    return !previousAttempt && this.hasNoErrorIndicators(analysis.error);
  }

  private buildFinalUploadResult(analysis: any, previousAttempt: any, diff: string): any {
    const finalError = analysis.error || previousAttempt.analysis?.error || 'Upload failed with unclear error';
    const shouldRetry = analysis.shouldRetry ?? previousAttempt.analysis?.shouldRetry ?? false;
    spectreLog('🔴 Upload failed:', finalError, 'shouldRetry:', shouldRetry);
    return { ok: false, errText: finalError, diff, shouldRetry };
  }

  private getAlternateSerialPorts(): DetectedPort[] {
    const cfg = this.boardsServiceProvider.boardsConfig;
    const currentPort = cfg.selectedPort;
    const detected = Object.values(this.boardsServiceProvider.detectedPorts || {});
    
    return detected
      .filter(
        (dp): dp is DetectedPort =>
          !!dp?.port &&
          dp.port.protocol === 'serial' &&
          (!currentPort || dp.port.address !== currentPort.address)
      )
      .sort((a: DetectedPort, b: DetectedPort) =>
        (a.port.address || '').localeCompare(b.port.address || '')
      );
  }

  private readonly PORT_ERROR_KEYWORDS = [
    'timeout',
    'busy',
    "can't open",
    'cannot open',
    'access denied',
    'permission denied',
    'in use',
    'semaphore',
    'handle is invalid'
  ];

  private isPortRelatedError(errText: string, shouldRetry?: boolean): boolean {
    if (shouldRetry !== undefined) {
      return shouldRetry;
    }

    const s = errText.toLowerCase();
    return this.PORT_ERROR_KEYWORDS.some(keyword => s.includes(keyword));
  }

  /**
   * Manages serial monitor disconnection before upload and reconnection after.
   */
  private async withMonitorDisconnected<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    let restoreMonitor = false;
    try {
      restoreMonitor = await this.monitorManagerProxy.isWSConnected();
    } catch (err) {
      spectreWarn('Monitor connection check failed:', err);
    }

    if (restoreMonitor) {
      spectreLog(
        '🔌 Serial Monitor is connected; disconnecting before upload...'
      );
      try {
        this.monitorManagerProxy.disconnect();
      } catch (err) {
        spectreWarn('Monitor disconnect failed:', err);
      }
      await this.delay(WIDGET_TIMING.COMPILATION_CHECK_DELAY);
    }

    try {
      return await operation();
    } finally {
      if (restoreMonitor) {
        try {
          await this.monitorManagerProxy.startMonitor();
        } catch (err) {
          spectreWarn('Monitor restart failed:', err);
        }
      }
    }
  }

  /**
   * Attempts upload on alternate ports if initial upload fails with port-related error.
   */
  private async retryUploadOnAlternatePorts(
    firstErr: string,
    shouldRetry: boolean
  ): Promise<{ ok: boolean; errText?: string; address?: string }> {
    const candidates = this.getAlternateSerialPorts();

    if (candidates.length === 0) {
      throw new Error(
        `Upload failed due to port issues, but no alternate ports available.\n\nError: ${firstErr}`
      );
    }

    const tried: string[] = [];
    for (const cand of candidates) {
      const addr = cand.port.address;
      tried.push(addr);
      spectreLog(`🔄 Retrying upload on alternate port: ${addr}`);
      this.boardsServiceProvider.updateConfig({
        protocol: cand.port.protocol,
        address: addr,
      });
      await this.delay(WIDGET_TIMING.UPLOAD_PROCESS_DELAY);

      const attempt = await this.attemptUploadOnCurrentPort();
      if (attempt.ok) {
        return { ok: true, address: addr };
      }

      if (this.shouldStopPortRetries(attempt)) {
        spectreLog('🛑 Non-port error encountered, stopping port retries');
        return { ok: false, errText: attempt.errText };
      }

      if (tried.length >= 2) {
        return { ok: false, errText: attempt.errText };
      }
    }

    const triedMsg = tried.length ? ` Tried ports: ${tried.join(', ')}.` : '';
    throw new Error(
      `Upload failed on all available ports.${triedMsg}\n\nLast error: ${firstErr}`
    );
  }

  /**
   * Formats upload error with specific guidance based on error type.
   */
  private formatUploadError(errText: string): Error {
    const errLower = errText.toLowerCase();

    const compilationError = this.checkCompilationError(errLower, errText);
    if (compilationError) return compilationError;

    const sizeError = this.checkSizeError(errLower, errText);
    if (sizeError) return sizeError;

    const programmerError = this.checkProgrammerError(errLower, errText);
    if (programmerError) return programmerError;

    return new Error(`Upload failed:\n\n${errText}`);
  }

  private checkCompilationError(errLower: string, errText: string): Error | null {
    if (errLower.includes('compilation terminated') || errLower.includes('syntax error')) {
      return new Error(
        `Upload failed due to compilation errors:\n\n${errText}\n\n💡 Please fix the code errors and try again.`
      );
    }
    return null;
  }

  private checkSizeError(errLower: string, errText: string): Error | null {
    if (errLower.includes('sketch too big')) {
      return new Error(
        `Upload failed: Sketch is too large for the selected board.\n\n${errText}\n\n💡 Try optimizing your code or selecting a board with more memory.`
      );
    }
    return null;
  }

  private checkProgrammerError(errLower: string, errText: string): Error | null {
    if (errLower.includes('exit status 1')) {
      return new Error(
        `Upload failed: programmer error occurred.\n\n${errText}\n\n💡 Check:\n• Board/port selection is correct\n• Device connection is stable\n• No other programs using the port`
      );
    }
    return null;
  }

  private async agentUploadSketch(): Promise<string> {
    await this.delay(WIDGET_TIMING.SKETCH_SAVE_DELAY);

    const sketch = await this.validateCurrentSketch();
    this.validateUploadEnvironment();

    spectreLog('🔧 Executing sketch upload...');

    return await this.withMonitorDisconnected(async () => {
      return await this.executeUploadWithRetry(sketch);
    });
  }

  private async validateCurrentSketch() {
    const sketch = await this.sketchesClient.currentSketch();
    if (!CurrentSketch.isValid(sketch)) {
      throw new Error('No valid sketch is currently open');
    }
    return sketch;
  }

  private validateUploadEnvironment(): void {
    spectreLog('🔍 Checking current board and port selection before upload...');
    const validation = this.validateBoardAndPort(true);
    if (!validation.valid) {
      throw new Error(validation.message!);
    }
  }

  private async executeUploadWithRetry(sketch: any): Promise<string> {
    const attempt = await this.attemptUploadOnCurrentPort();
    if (attempt.ok) {
      spectreLog('✅ Upload successful');
      return `✅ Sketch uploaded successfully to board: ${sketch.name}`;
    }

    return await this.handleUploadFailure(attempt, sketch);
  }

  private async handleUploadFailure(attempt: any, sketch: any): Promise<string> {
    const firstErr = attempt.errText || '';
    spectreLog('🔴 Upload failed on current port:', firstErr, 'shouldRetry:', attempt.shouldRetry);

    if (attempt.shouldRetry || this.isPortRelatedError(firstErr, attempt.shouldRetry)) {
      const retryResult = await this.retryUploadOnAlternatePorts(
        firstErr,
        attempt.shouldRetry ?? false
      );
      if (retryResult.ok) {
        return `✅ Sketch uploaded successfully on alternate port ${retryResult.address}.`;
      }
    }

    throw this.formatUploadError(firstErr || 'Upload failed with unknown error.');
  }

  /**
   * Builds a case-insensitive map of libraries for efficient lookup.
   */
  private buildLibraryMap(
    searchResults: any[]
  ): Map<string, any> {
    const libraryMap = new Map<string, any>();
    for (const lib of searchResults) {
      if (lib && lib.name) {
        libraryMap.set(lib.name.toLowerCase(), lib);
      }
    }
    return libraryMap;
  }

  /**
   * Validates library name is not empty.
   */
  private validateLibraryName(libraryName: string): string | null {
    if (!libraryName || libraryName.trim().length === 0) {
      return '❌ Cannot install library: library name is empty';
    }
    return null;
  }

  /**
   * Searches for a library and resolves it from search results.
   * Returns either the library package or an error message string.
   */
  private async searchAndResolveLibrary(libraryName: string): Promise<any | string> {
    spectreLog(`🔍 Searching for library: "${libraryName}"`);

    const searchResults = await this.libraryService.search({
      query: libraryName,
    });

    if (!searchResults || searchResults.length === 0) {
      return `❌ Library "${libraryName}" not found in Arduino Library Manager\n\n💡 Common fixes:\n• Check spelling (library names are case-sensitive)\n• Try searching: https://www.arduino.cc/reference/en/libraries/\n• Some libraries have different names (e.g., "Servo" not "ServoLibrary")`;
    }

    spectreLog(`📦 Found ${searchResults.length} search results`);

    // Build case-insensitive Map for O(1) lookup
    const libraryMap = this.buildLibraryMap(searchResults);
    spectreLog(`📦 Built library map with ${libraryMap.size} entries`);

    // Fail-fast if all results were malformed
    if (libraryMap.size === 0) {
      spectreError(
        '❌ All search results were malformed (missing name property)'
      );
      return `❌ Library search returned invalid data for "${libraryName}"\n\n💡 This is an internal error. Please try again or search manually in Library Manager.`;
    }

    // Find the library
    const libraryPackage = this.findLibraryInResults(libraryName, libraryMap);

    // Handle case where library wasn't found
    if (!libraryPackage) {
      return `❌ Library "${libraryName}" could not be resolved from search results\n\n💡 Please try searching manually in Library Manager.`;
    }

    return libraryPackage;
  }

  /**
   * Finds library from search results using exact or best match.
   */
  private findLibraryInResults(
    libraryName: string,
    libraryMap: Map<string, any>
  ): any | undefined {
    let libraryPackage = libraryMap.get(libraryName.toLowerCase());
    if (!libraryPackage) {
      // If no exact match, use the first valid result from Map
      const firstResult = libraryMap.values().next();
      if (firstResult.done || !firstResult.value) {
        return undefined;
      }
      libraryPackage = firstResult.value;
      spectreLog(
        `📦 Using best match: "${libraryPackage.name}" for query "${libraryName}"`
      );
    } else {
      spectreLog(`📦 Found exact match: "${libraryPackage.name}"`);
    }
    return libraryPackage;
  }

  /**
   * Formats library installation errors based on error type.
   */
  private formatLibraryInstallError(libraryName: string, error: any): string {
    const errorMsg = error.message || String(error);

    // Check for common errors
    if (
      errorMsg.toLowerCase().includes('not found') ||
      errorMsg.toLowerCase().includes('no valid')
    ) {
      return `❌ Library "${libraryName}" not found in Arduino Library Manager\n\n💡 Please check the library name and try again. You can search for libraries at: https://www.arduino.cc/reference/en/libraries/`;
    } else if (
      errorMsg.toLowerCase().includes('network') ||
      errorMsg.toLowerCase().includes('download')
    ) {
      return `❌ Failed to download library "${libraryName}"\n\nError: ${errorMsg}\n\n💡 Check your internet connection and try again`;
    } else {
      return `❌ Failed to install library "${libraryName}"\n\nError: ${errorMsg}`;
    }
  }

  private async agentInstallLibrary(libraryName: string): Promise<string> {
    try {
      spectreLog(`📦 Installing Arduino library: ${libraryName}`);

      const validationError = this.validateLibraryName(libraryName);
      if (validationError) return validationError;

      const libraryPackage = await this.searchAndResolveLibrary(libraryName);
      if (typeof libraryPackage === 'string') return libraryPackage; // Error message

      // Check if already installed
      if (libraryPackage.installedVersion) {
        spectreLog(
          `✅ Library "${libraryPackage.name}" is already installed (version ${libraryPackage.installedVersion})`
        );
        return `✅ Library "${libraryPackage.name}" is already installed (version ${libraryPackage.installedVersion})`;
      }

      // Get the version that will be installed
      const versionToInstall = libraryPackage.availableVersions?.[0];
      if (!versionToInstall) {
        return `❌ No versions available for library "${libraryPackage.name}"`;
      }
      spectreLog(
        `📦 Installing library: ${libraryPackage.name}@${versionToInstall}`
      );

      // Install the library using the backend service
      await this.libraryService.install({
        item: libraryPackage,
        installDependencies: true,
      });

      spectreLog(
        `✅ Library "${libraryPackage.name}" installed successfully`
      );
      return `✅ Library "${libraryPackage.name}" installed successfully`;
    } catch (error: unknown) {
      spectreError('❌ Library installation error:', error);
      return this.formatLibraryInstallError(libraryName, error);
    }
  }

  /**
   * Formats library uninstall errors based on error type.
   */
  private formatLibraryUninstallError(
    libraryName: string,
    error: any
  ): string {
    const errorMsg = error.message || String(error);

    if (
      errorMsg.toLowerCase().includes('not found') ||
      errorMsg.toLowerCase().includes('not installed')
    ) {
      return `❌ Library "${libraryName}" is not installed or could not be found`;
    } else {
      return `❌ Failed to uninstall library "${libraryName}"\n\nError: ${errorMsg}`;
    }
  }

  private async agentUninstallLibrary(libraryName: string): Promise<string> {
    try {
      spectreLog(`🗑️ Uninstalling Arduino library: ${libraryName}`);

      const validationError = this.validateLibraryName(libraryName);
      if (validationError) return validationError.replace('install', 'uninstall');

      const libraryPackage = await this.searchAndResolveLibrary(libraryName);
      if (typeof libraryPackage === 'string') return libraryPackage; // Error message

      // Check if the library is actually installed
      if (!libraryPackage.installedVersion) {
        spectreLog(`⚠️ Library "${libraryPackage.name}" is not installed`);
        return `⚠️ Library "${libraryPackage.name}" is not currently installed`;
      }

      spectreLog(`🗑️ Uninstalling library: ${libraryPackage.name}`);

      // Uninstall the library using the backend service
      await this.libraryService.uninstall({
        item: libraryPackage,
      });

      // Write confirmation to Output panel
      const outputChannel = this.outputChannels.getChannel('Arduino');
      outputChannel.appendLine(
        `Uninstalled ${libraryPackage.name}@${libraryPackage.installedVersion}`
      );

      spectreLog(
        `✅ Library "${libraryPackage.name}" uninstalled successfully`
      );
      return `✅ Library "${libraryPackage.name}" uninstalled successfully`;
    } catch (error: unknown) {
      spectreError('❌ Library uninstallation error:', error);
      return this.formatLibraryUninstallError(libraryName, error);
    }
  }

  /**
   * Add a board manager URL to Arduino preferences.
   * Required for installing 3rd-party board platforms.
   * @param url Board manager package index URL
   * @returns Promise resolving to user-friendly status message
   */

  /**
   * Polls package index until ready or timeout.
   */
  private async pollForPackageIndexReady(
    maxWaitTime: number
  ): Promise<boolean> {
    const pollInterval = WIDGET_TIMING.PACKAGE_INDEX_POLL_INTERVAL;
    const startTime = Date.now();

    spectreLog('🔍 Checking if package index is ready...');

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const testSearch = await this.boardsService.search({ query: '' });
        if (testSearch && testSearch.length > 0) {
          const elapsedMs = Date.now() - startTime;
          spectreLog(`✅ Package index ready (took ${elapsedMs}ms)`);
          return true;
        }
      } catch (e) {
        // Index not ready yet, continue polling
      }

      await this.delay(pollInterval);
    }

    spectreWarn('⚠️ Package index update timed out after 10 seconds');
    return false;
  }

  /**
   * Updates package index and waits for it to be ready.
   */
  private async updateAndWaitForPackageIndex(): Promise<{
    success: boolean;
    timedOut: boolean;
  }> {
    try {
      await this.commands.executeCommand('arduino-update-package-index');
      spectreLog('✅ Package index update command completed');

      const indexReady = await this.pollForPackageIndexReady(10000);
      return { success: indexReady, timedOut: !indexReady };
    } catch (updateError) {
      spectreWarn('⚠️ Package index update failed:', updateError);
      return { success: false, timedOut: false };
    }
  }

  /**
   * Formats board URL add result message.
   */
  private formatBoardUrlAddResult(
    url: string,
    urlAlreadyExists: boolean,
    updateResult: { success: boolean; timedOut: boolean }
  ): string {
    const urlMatch = url.match(/package_([^_]+)_/);
    const boardName = urlMatch ? urlMatch[1] : 'the board';

    if (!updateResult.success) {
      if (updateResult.timedOut) {
        return urlAlreadyExists
          ? `✅ Board manager URL was already configured. Package index update initiated but may still be processing.

💡 Wait a moment before installing board platforms`
          : `✅ Added board manager URL. Package index update initiated but may still be processing.

💡 Wait a moment before installing board platforms`;
      } else {
        return urlAlreadyExists
          ? `✅ Board manager URL was already configured, but package index update failed

💡 Try waiting a moment and then install the board platform`
          : `✅ Added board manager URL, but package index update failed

💡 The Board Manager will refresh automatically`;
      }
    }

    return urlAlreadyExists
      ? `✅ Board manager URL was already configured. Package index has been refreshed and is ready.

💡 **NEXT STEP:** Use <action type="search_boards" query="${boardName}" /> to find the exact platform ID`
      : `✅ Added board manager URL and updated package index. Ready to install platforms.

💡 **NEXT STEP:** Use <action type="search_boards" query="${boardName}" /> to find the exact platform ID`;
  }

  private async agentAddBoardUrl(url: string): Promise<string> {
    if (!url || !url.trim()) {
      return '❌ Board manager URL is required';
    }

    try {
      spectreLog(`🔗 Adding board manager URL: ${url}`);

      const currentConfig = await this.configService.getConfiguration();
      if (!currentConfig.config) {
        return `❌ Failed to read configuration`;
      }

      const currentUrls = currentConfig.config.additionalUrls || [];
      const urlAlreadyExists = currentUrls.includes(url);

      await this.addUrlToConfiguration(currentConfig.config, currentUrls, url, urlAlreadyExists);

      spectreLog('🔄 Updating package indexes (this may take a moment)...');
      const updateResult = await this.updateAndWaitForPackageIndex();

      return this.formatBoardUrlAddResult(url, urlAlreadyExists, updateResult);
    } catch (error) {
      spectreError('❌ Failed to add board manager URL:', error);
      return `❌ Failed to add board manager URL: ${error}`;
    }
  }

  private async addUrlToConfiguration(
    config: any,
    currentUrls: string[],
    url: string,
    urlAlreadyExists: boolean
  ): Promise<void> {
    if (!urlAlreadyExists) {
      const updatedUrls = [...currentUrls, url];
      await this.configService.setConfiguration({
        ...config,
        additionalUrls: updatedUrls,
      });
      spectreLog('✅ Board manager URL added to preferences');
    } else {
      spectreLog(`ℹ️ Board manager URL already configured: ${url}`);
    }
  }

  /**
   * Remove a board manager URL from Arduino preferences.
   * Supports both exact URL matching and fuzzy matching by board name (e.g., "MiniCore", "ESP32").
   * @param urlOrName Board manager package index URL or board name (e.g., "MiniCore")
   * @returns Status message
   */
  private async agentRemoveBoardUrl(urlOrName: string): Promise<string> {
    if (!urlOrName || !urlOrName.trim()) {
      return '❌ Board manager URL or board name is required';
    }

    try {
      spectreLog(`🗑️ Removing board manager URL: ${urlOrName}`);

      const currentConfig = await this.configService.getConfiguration();
      if (!currentConfig.config) {
        return `❌ Failed to read configuration`;
      }

      const currentUrls = currentConfig.config.additionalUrls || [];
      if (currentUrls.length === 0) {
        return `ℹ️ No board manager URLs configured in preferences`;
      }

      const urlsToRemove = this.findUrlsToRemove(urlOrName, currentUrls);
      if (urlsToRemove.length === 0) {
        return this.formatNoMatchMessage(urlOrName, currentUrls);
      }

      return await this.removeUrlsAndUpdate(urlsToRemove, currentUrls, currentConfig.config, urlOrName);
    } catch (error) {
      spectreError('❌ Failed to remove board manager URL:', error);
      return `❌ Failed to remove board manager URL: ${error}`;
    }
  }

  private findUrlsToRemove(urlOrName: string, currentUrls: string[]): string[] {
    if (currentUrls.includes(urlOrName)) {
      return [urlOrName];
    }

    const searchTerm = urlOrName.toLowerCase().trim();
    return currentUrls.filter((url) => url.toLowerCase().includes(searchTerm));
  }

  private formatNoMatchMessage(urlOrName: string, currentUrls: string[]): string {
    return `ℹ️ No matching board manager URLs found for: "${urlOrName}"

Current URLs:
${currentUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}

💡 Tip: You can say "remove MiniCore" or "remove ESP32" to match by board name`;
  }

  private async removeUrlsAndUpdate(
    urlsToRemove: string[],
    currentUrls: string[],
    config: any,
    urlOrName: string
  ): Promise<string> {
    const updatedUrls = currentUrls.filter((u) => !urlsToRemove.includes(u));

    await this.configService.setConfiguration({
      ...config,
      additionalUrls: updatedUrls,
    });

    spectreLog(`✅ Removed ${urlsToRemove.length} board manager URL(s) from preferences`);

    await this.updatePackageIndexes();

    if (urlsToRemove.length > 1) {
      return this.formatMultipleRemovalMessage(urlsToRemove, urlOrName, updatedUrls.length);
    }

    return this.formatSingleRemovalMessage(urlsToRemove[0], updatedUrls.length);
  }

  private async updatePackageIndexes(): Promise<void> {
    spectreLog('🔄 Updating package indexes to reflect changes...');
    try {
      await this.commands.executeCommand('arduino-update-package-index');
      spectreLog('✅ Package index updated');
    } catch (updateError) {
      spectreWarn('⚠️ Package index update failed:', updateError);
    }
  }

  private formatMultipleRemovalMessage(urlsToRemove: string[], urlOrName: string, remainingCount: number): string {
    return `✅ Removed ${
      urlsToRemove.length
    } board manager URLs matching "${urlOrName}":

${urlsToRemove.map((u, i) => `${i + 1}. ${u}`).join('\n')}

⚠️ Note: This only removes the URLs. Installed platforms remain until explicitly uninstalled.

Remaining URLs: ${remainingCount}`;
  }

  private formatSingleRemovalMessage(url: string, remainingCount: number): string {
    return `✅ Removed board manager URL from preferences:
${url}

⚠️ Note: This only removes the URL. Installed platforms remain until explicitly uninstalled.

Remaining URLs: ${remainingCount}`;
  }

  /**
   * Extracts board URL from a wiki line.
   */
  private extractBoardUrlFromLine(line: string, query: string): {
    name: string;
    url: string;
  } | null {
    // Extract URLs from the line (match http/https URLs ending in .json)
    const urlMatch = line.match(/(https?:\/\/[^\s\)]+\.json)/i);
    if (!urlMatch) {
      return null;
    }

    const url = urlMatch[1];

    // Try to extract a meaningful name from the line
    let name = query;

    // Check for markdown link format: [Name](url)
    const mdLinkMatch = line.match(/\[([^\]]+)\]/);
    if (mdLinkMatch) {
      name = mdLinkMatch[1];
    } else {
      // Try to extract text before the URL
      const beforeUrl = line.substring(0, line.indexOf(url)).trim();
      // Remove markdown formatting
      const cleanName = beforeUrl
        .replace(/^[-*•]\s*/, '')
        .replace(/\[|\]/g, '')
        .trim();
      if (cleanName) {
        name = cleanName;
      }
    }

    return { name, url };
  }

  /**
   * Parses wiki content to find board URLs matching query.
   */
  private parseWikiForBoardUrls(
    wikiContent: string,
    query: string
  ): Array<{ name: string; url: string }> {
    const lines = wikiContent.split('\n');
    const matches: Array<{ name: string; url: string }> = [];
    const searchTerm = query.toLowerCase().trim();

    for (const line of lines) {
      const lowerLine = line.toLowerCase();

      // Skip if line doesn't contain search term
      if (!lowerLine.includes(searchTerm)) {
        continue;
      }

      const match = this.extractBoardUrlFromLine(line, query);
      if (match) {
        matches.push(match);
      }
    }

    return matches;
  }

  /**
   * Formats board URL search results with action suggestions.
   */
  private formatBoardUrlResults(
    matches: Array<{ name: string; url: string }>,
    query: string
  ): string {
    let result = `✅ Found ${matches.length} board manager URL(s) for "${query}":\n\n`;

    matches.forEach((match, index) => {
      result += `${index + 1}. ${match.name}\n   ${match.url}\n\n`;
    });

    // If there's only one match, provide a helpful suggestion
    if (matches.length === 1) {
      result += `💡 To add this URL, use:\n<action type="add_board_url" url="${matches[0].url}" />`;
    } else {
      result += `💡 To add a URL, use:\n<action type="add_board_url" url="[choose one from above]" />`;
    }

    return result;
  }

  /**
   * Fetches and searches for board manager URLs from the official Arduino Wiki.
   * Dynamically retrieves the list of third-party board URLs to avoid hardcoding.
   *
   * @param query Board name to search for (e.g., "ESP32", "STM32", "MiniCore")
   * @returns Promise resolving to matching board URLs or error message
   */
  private async agentFetchBoardUrls(query: string): Promise<string> {
    if (!query || !query.trim()) {
      return '❌ Board name is required to search for URLs';
    }

    // GitHub wikis are stored in a separate .wiki.git repository
    const wikiUrl =
      'https://raw.githubusercontent.com/wiki/arduino/Arduino/Unofficial-list-of-3rd-party-boards-support-urls.md';

    try {
      spectreLog(`🔍 Fetching board URLs for: ${query}`);

      // Fetch the wiki page
      const response = await fetch(wikiUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch wiki: ${response.status} ${response.statusText}`
        );
      }

      const wikiContent = await response.text();

      // Parse the wiki content
      const matches = this.parseWikiForBoardUrls(wikiContent, query);

      if (matches.length === 0) {
        return `❌ No board manager URLs found for "${query}"

💡 Try searching with a different term or check the Arduino Wiki manually:
https://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls`;
      }

      return this.formatBoardUrlResults(matches, query);
    } catch (error) {
      spectreError('❌ Failed to fetch board URLs:', error);
      return `❌ Failed to fetch board URLs from Arduino Wiki: ${error}

💡 You can manually check: https://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls`;
    }
  }

  /**
   * Install a board platform (core) using the Board Manager.
   * @param platformId Platform identifier in "vendor:arch" format
   * @param version Optional specific version to install (defaults to latest)
   * @returns Promise resolving to user-friendly status message
   */
  /**
   * Searches for and finds a platform by ID with exact and fuzzy matching.
   */
  private async findPlatformById(
    platformId: string
  ): Promise<{ platform: any; searchResults: any[] } | { error: string }> {
    const searchResults = await this.boardsService.search({ query: platformId });

    const initialCheck = this.checkSearchResults(searchResults, platformId);
    if (initialCheck) {
      return initialCheck;
    }

    spectreLog(`🔍 Found ${searchResults.length} search results for "${platformId}"`);
    searchResults.forEach((pkg) => spectreLog(`  - ${pkg.id} (${pkg.name})`));

    const { exactMap, caseInsensitiveMap } = this.buildPlatformLookupMaps(searchResults);

    if (exactMap.size === 0) {
      return {
        error: `❌ Platform search returned invalid data for "${platformId}"\n\n💡 This is an internal error. Please try searching manually in Board Manager.`,
      };
    }

    const platform = this.findMatchingPlatform(platformId, searchResults, exactMap, caseInsensitiveMap);
    if (!platform) {
      return this.formatPlatformSearchError(platformId, searchResults);
    }

    return { platform, searchResults };
  }

  private checkSearchResults(
    searchResults: any[] | null | undefined,
    platformId: string
  ): { error: string } | null {
    if (!searchResults || searchResults.length === 0) {
      return {
        error: `❌ Board platform "${platformId}" not found in Board Manager\n\n💡 Common fixes:\n• Run the ADD_BOARD_URL action first to add the board manager URL\n• Wait a moment for the package index to download\n• Check platform ID spelling (case-sensitive, usually format: "vendor:arch")\n• Verify the board manager URL is correct\n\nTry asking: "Add the board manager URL for [board name]"`,
      };
    }
    return null;
  }

  private buildPlatformLookupMaps(searchResults: any[]): {
    exactMap: Map<string, any>;
    caseInsensitiveMap: Map<string, any>;
  } {
    const exactMap = new Map<string, any>();
    const caseInsensitiveMap = new Map<string, any>();

    for (const pkg of searchResults) {
      if (pkg && pkg.id) {
        exactMap.set(pkg.id, pkg);
        caseInsensitiveMap.set(pkg.id.toLowerCase(), pkg);
      }
    }

    return { exactMap, caseInsensitiveMap };
  }

  /**
   * Shared helper: Find matching platform using cascading search strategies.
   * 1. Exact match (case-sensitive)
   * 2. Case-insensitive match
   * 3. Partial substring match
   */
  private findMatchingPlatform(
    platformId: string,
    searchResults: any[],
    exactMap: Map<string, any>,
    caseInsensitiveMap: Map<string, any>
  ): any | null {
    return (
      exactMap.get(platformId) ||
      caseInsensitiveMap.get(platformId.toLowerCase()) ||
      searchResults.find((pkg) =>
        pkg.id.toLowerCase().includes(platformId.toLowerCase())
      )
    );
  }

  /**
   * Shared helper: Format platform search error with suggestions.
   * Used by both install and uninstall operations.
   */
  private formatPlatformSearchError(platformId: string, searchResults: any[]): { error: string } {
    const suggestions = searchResults
      .slice(0, 3)
      .map((p) => `${p.id} (${p.name})`)
      .join('\n• ');
    return {
      error: `❌ Platform "${platformId}" not found\n\nFound these similar platforms:\n• ${suggestions}\n\n💡 Use the exact platform ID shown above`,
    };
  }

  /**
   * Checks if platform is already installed and validates version compatibility.
   */
  private checkPlatformInstallation(
    platform: any,
    requestedVersion?: string
  ): { shouldInstall: boolean; message?: string } {
    if (!platform.installedVersion) {
      return { shouldInstall: true };
    }

    const installedVersion = platform.installedVersion;
    if (requestedVersion && installedVersion !== requestedVersion) {
      return {
        shouldInstall: false,
        message: `ℹ️ Platform "${platform.name}" is already installed with version ${installedVersion}

💡 To install version ${requestedVersion}, uninstall the current version first from Board Manager`,
      };
    }

    return {
      shouldInstall: false,
      message: `✅ Platform "${platform.name}" already installed (version ${installedVersion})`,
    };
  }

  /**
   * Formats installation error with helpful guidance.
   */
  private formatInstallationError(platformId: string, error: any): string {
    if (error instanceof Error) {
      if (error.message.includes('not found') || error.message.includes('404')) {
        return `❌ Platform "${platformId}" not found

💡 You may need to add the board manager URL first:
[ACTION:ADD_BOARD_URL:https://...]`;
      }
      if (
        error.message.includes('network') ||
        error.message.includes('timeout')
      ) {
        return `❌ Network error while installing platform "${platformId}"

💡 Check your internet connection and try again`;
      }
    }
    return `❌ Failed to install platform "${platformId}": ${error}`;
  }

  private async agentInstallBoard(
    platformId: string,
    version?: string
  ): Promise<string> {
    // Use shared validation helper to maintain consistency
    const validation = this.validatePlatformId(platformId, 'installation');
    if (validation) {
      return validation;
    }

    try {
      const versionStr = version ? `@${version}` : ' (latest)';
      spectreLog(`📦 Installing board platform: ${platformId}${versionStr}`);

      const platform = await this.resolvePlatformForInstall(platformId, version);
      if (typeof platform === 'string') {
        return platform;
      }

      return await this.installPlatform(platform.item, platform.version, platformId);
    } catch (error) {
      spectreError(`❌ Failed to install platform "${platformId}":`, error);
      return this.formatInstallationError(platformId, error);
    }
  }

  /**
   * Shared helper: Validate platform ID format.
   * Used by both install and uninstall operations.
   */
  private validatePlatformId(platformId: string, operation: 'installation' | 'uninstallation' = 'installation'): string | null {
    if (!platformId || !platformId.trim()) {
      return `❌ Platform ID is required for board ${operation}`;
    }

    const parts = platformId.split(':');
    if (parts.length !== 2) {
      return `❌ Invalid platform ID format: "${platformId}"\n\n💡 Expected format: "vendor:architecture" (e.g., "esp32:esp32", "MiniCore:avr")`;
    }

    return null;
  }

  private async resolvePlatformForInstall(platformId: string, version?: string): Promise<{ item: any; version: string } | string> {
    const findResult = await this.findPlatformById(platformId);
    if ('error' in findResult) {
      return findResult.error;
    }

    const { platform } = findResult;
    const installCheck = this.checkPlatformInstallation(platform, version);
    if (!installCheck.shouldInstall) {
      return installCheck.message!;
    }

    const versionToInstall = version || platform.availableVersions[0];
    if (!versionToInstall) {
      return `❌ No versions available for platform "${platformId}"`;
    }

    return { item: platform, version: versionToInstall };
  }

  private async installPlatform(platform: any, versionToInstall: string, platformId: string): Promise<string> {
    spectreLog(`📦 Installing ${platform.name}@${versionToInstall}`);

    await this.boardsService.install({
      item: platform,
      version: versionToInstall,
      skipPostInstall: false,
    });

    this.outputChannels
      .getChannel('Arduino')
      .appendLine(`Installed ${platform.name}@${versionToInstall}`);

    spectreLog(`✅ Platform "${platform.name}" version ${versionToInstall} installed successfully`);
    return `✅ Platform "${platform.name}" version ${versionToInstall} installed successfully`;
  }

  /**
   * Search for available board platforms in the Board Manager.
   * Useful for discovering the correct platform ID before installation.
   * @param query Search query (board name, vendor, etc.)
   * @returns Promise resolving to formatted list of available platforms
   */
  private async agentSearchBoards(query: string): Promise<string> {
    if (!query || !query.trim()) {
      return '❌ Search query is required';
    }

    try {
      spectreLog(`🔍 Searching for board platforms: "${query}"`);

      const searchResults = await this.boardsService.search({ query });

      if (!searchResults || searchResults.length === 0) {
        return `❌ No board platforms found for "${query}"

💡 Try:
• Different search terms (manufacturer name, board name, etc.)
• Adding the board manager URL first if it's a 3rd-party board`;
      }

      spectreLog(`✅ Found ${searchResults.length} platform(s)`);

      // Format results with clear platform IDs that AI can extract
      const platformsList = searchResults
        .slice(0, 10) // Limit to top 10 results
        .map((pkg, index) => {
          const installed = pkg.installedVersion
            ? ` ✅ v${pkg.installedVersion}`
            : '';
          const latest = pkg.availableVersions?.[0]
            ? ` (latest: v${pkg.availableVersions[0]})`
            : '';
          return `${index + 1}. **${pkg.name}** → Platform ID: **${
            pkg.id
          }**${installed}${latest}`;
        })
        .join('\n');

      // Extract the most relevant platform ID (first result) for AI to use
      const primaryPlatform = searchResults[0];
      const primaryId = primaryPlatform.id;

      return `📋 Found ${searchResults.length} platform(s) for "${query}":

${platformsList}

💡 **NEXT STEP:** Use this EXACT command to install:
<action type="install_board" platform="${primaryId}" />`;
    } catch (error) {
      spectreError('❌ Board search error:', error);
      return `❌ Failed to search for boards: ${error}`;
    }
  }

  /**
   * Uninstall a board platform (core) using the Board Manager.
   * @param platformId Platform identifier in "vendor:arch" format
   * @returns Promise resolving to user-friendly status message
   */
  private async agentUninstallBoard(platformId: string): Promise<string> {
    const validation = this.validateUninstallRequest(platformId);
    if (validation) {
      return validation;
    }

    try {
      spectreLog(`🗑️ Uninstalling board platform: ${platformId}`);

      const platform = await this.findPlatformForUninstall(platformId);
      if (typeof platform === 'string') {
        return platform;
      }

      return await this.uninstallPlatform(platform);
    } catch (error) {
      spectreError(`❌ Failed to uninstall platform "${platformId}":`, error);
      return this.formatUninstallError(platformId, error);
    }
  }

  private validateUninstallRequest(platformId: string): string | null {
    return this.validatePlatformId(platformId, 'uninstallation');
  }

  private async findPlatformForUninstall(platformId: string): Promise<any | string> {
    const searchResults = await this.boardsService.search({ query: platformId });

    if (!searchResults || searchResults.length === 0) {
      return `❌ Board platform "${platformId}" not found in Board Manager\n\n💡 Check platform ID spelling (case-sensitive)`;
    }

    const { exactMap, caseInsensitiveMap } = this.buildPlatformMaps(searchResults);

    if (exactMap.size === 0) {
      spectreError('❌ All search results were malformed (missing id property)');
      return `❌ Platform search returned invalid data for "${platformId}"\n\n💡 This is an internal error. Please try searching manually in Board Manager.`;
    }

    const platform = this.findPlatformFromResults(
      platformId,
      searchResults,
      exactMap,
      caseInsensitiveMap
    );

    if (!platform) {
      return this.formatPlatformNotFoundError(platformId, searchResults);
    }

    if (!platform.installedVersion) {
      return `ℹ️ Platform "${platform.name}" is not installed\n\n💡 Nothing to uninstall`;
    }

    return platform;
  }

  private async uninstallPlatform(platform: any): Promise<string> {
    const installedVersion = platform.installedVersion;
    spectreLog(`🗑️ Uninstalling ${platform.name}@${installedVersion}`);

    await this.boardsService.uninstall({ item: platform });

    const outputChannel = this.outputChannels.getChannel('Arduino');
    outputChannel.appendLine(`Uninstalled ${platform.name}@${installedVersion}`);

    spectreLog(`✅ Platform "${platform.name}" version ${installedVersion} uninstalled successfully`);
    return `✅ Platform "${platform.name}" version ${installedVersion} uninstalled successfully`;
  }

  /**
   * Builds lookup maps for platform search results.
   * Note: This delegates to the shared buildPlatformLookupMaps method.
   */
  private buildPlatformMaps(
    searchResults: any[]
  ): {
    exactMap: Map<string, any>;
    caseInsensitiveMap: Map<string, any>;
  } {
    return this.buildPlatformLookupMaps(searchResults);
  }

  /**
   * Finds platform from search results using exact, case-insensitive, or partial match.
   * Note: This now delegates to the shared findMatchingPlatform method.
   */
  private findPlatformFromResults(
    platformId: string,
    searchResults: any[],
    exactMap: Map<string, any>,
    caseInsensitiveMap: Map<string, any>
  ): any | null {
    return this.findMatchingPlatform(platformId, searchResults, exactMap, caseInsensitiveMap);
  }

  /**
   * Formats platform not found error with suggestions.
   * Note: This now uses the shared formatPlatformSearchError method.
   */
  private formatPlatformNotFoundError(
    platformId: string,
    searchResults: any[]
  ): string {
    const errorResult = this.formatPlatformSearchError(platformId, searchResults);
    return errorResult.error;
  }

  /**
   * Formats uninstall errors based on error type.
   */
  private formatUninstallError(platformId: string, error: unknown): string {
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        return `❌ Platform "${platformId}" not found or not installed`;
      }
      if (
        error.message.includes('in use') ||
        error.message.includes('dependency')
      ) {
        return `❌ Cannot uninstall platform "${platformId}" - it may be in use or required by other platforms

💡 Close any sketches using this board and try again`;
      }
    }
    return `❌ Failed to uninstall platform "${platformId}": ${error}`;
  }

  /**
   * Opens editor with retry logic.
   */
  private async openEditorWithRetry(uri: any): Promise<any> {
    let editor = await this.editorManager.open(uri);

    // If editor is not available, wait and try again with longer timeout
    if (!editor) {
      spectreLog('⏳ Editor not ready, waiting longer...');
      await this.delay(WIDGET_TIMING.SERVICE_READY_WAIT);
      editor = await this.editorManager.open(uri);
    }

    return editor;
  }

  /**
   * Applies content changes to Monaco editor model.
   */
  private async applyEditorChanges(
    editor: any,
    uri: any,
    filePath: string,
    content: string
  ): Promise<string> {
    // Wait for the editor to be fully initialized
    await this.delay(WIDGET_TIMING.PORT_SELECTION_DELAY);

    const monacoEditor = editor.editor;
    if (!('getControl' in monacoEditor)) {
      return '❌ Could not access Monaco editor model - editor may not be fully loaded';
    }

    const control = (monacoEditor as any).getControl();
    const model = control.getModel();
    if (!model) {
      return '❌ Could not access Monaco editor model - editor may not be fully loaded';
    }

    // Capture old code before modification
    const oldCode = model.getValue();

    if (oldCode !== content) {
      await this.showInlineDiff(uri, filePath, oldCode, content);
      return `✅ Applied changes to: ${filePath}\n\n💡 Click "Keep" to accept or "Undo" to revert`;
    }

    // No changes needed
    return `✅ Code is already up to date: ${filePath}`;
  }

  private async agentModifySketch(
    filePath: string,
    content: string
  ): Promise<string> {
    try {
      const uri = new URI(filePath);

      // Validate content is not empty
      if (!content || content.trim().length === 0) {
        return '❌ Cannot modify sketch: content is empty';
      }

      // Wait a bit for any editor opening process to complete
      await this.delay(WIDGET_TIMING.SKETCH_SAVE_DELAY);

      const editor = await this.openEditorWithRetry(uri);

      if (editor) {
        return await this.applyEditorChanges(editor, uri, filePath, content);
      } else {
        return '❌ Could not open file in editor - please ensure the sketch is open and try pasting the code manually';
      }
    } catch (error: unknown) {
      spectreError('Sketch modification error:', error);
      return `❌ Failed to modify sketch content: ${this.getErrorMessage(error)}`;
    }
  }

  /**
   * Shows inline diff editor like VS Code with Keep/Undo buttons
   * Shows removed lines inline (red, no line numbers) above added lines (green, with numbers)
   */
  /**
   * Gets Monaco editor control and model from URI.
   */
  private async getMonacoControl(
    uri: any
  ): Promise<{ control: any; model: any } | null> {
    const editor = await this.editorManager.open(uri);
    if (!editor) {
      spectreError('Could not open editor');
      return null;
    }

    const monacoEditor = editor.editor;
    if (!('getControl' in monacoEditor)) {
      spectreError('Not a Monaco editor');
      return null;
    }

    const control = (monacoEditor as any).getControl();
    const model = control.getModel();
    if (!model) {
      spectreError('No model found');
      return null;
    }

    return { control, model };
  }

  /**
   * Computes diff decorations and content widgets for line-by-line comparison.
   */
  private computeDiffElements(
    oldLines: string[],
    newLines: string[]
  ): { decorations: any[]; contentWidgets: any[] } {
    const decorations: any[] = [];
    const contentWidgets: any[] = [];
    let oldIdx = 0;
    let newIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
      if (oldIdx >= oldLines.length) {
        this.addAdditionDecoration(decorations, newIdx);
        newIdx++;
      } else if (newIdx >= newLines.length) {
        oldIdx++;
      } else if (oldLines[oldIdx] === newLines[newIdx]) {
        oldIdx++;
        newIdx++;
      } else {
        const matchResult = this.findLineMatch({
          oldLines,
          newLines,
          oldIdx,
          newIdx,
          decorations,
          contentWidgets,
        });
        oldIdx = matchResult.oldIdx;
        newIdx = matchResult.newIdx;
      }
    }

    return { decorations, contentWidgets };
  }

  /**
   * Adds decoration for an added line.
   */
  private addAdditionDecoration(decorations: any[], lineNumber: number): void {
    decorations.push({
      range: {
        startLineNumber: lineNumber + 1,
        startColumn: 1,
        endLineNumber: lineNumber + 1,
        endColumn: 1000,
      },
      options: {
        isWholeLine: true,
        className: 'spectre-diff-line-added',
        glyphMarginClassName: 'spectre-diff-glyph-add',
      },
    });
  }

  /**
   * Finds matching lines using lookahead to detect additions/deletions.
   */
  private findLineMatch(
    params: FindLineMatchParams
  ): { oldIdx: number; newIdx: number } {
    const { oldLines, newLines, oldIdx, newIdx, decorations, contentWidgets } = params;

    const deletionMatch = this.checkDeletion({ oldLines, newLines, oldIdx, newIdx, decorations });
    if (deletionMatch) return deletionMatch;

    const additionMatch = this.checkAddition({ oldLines, newLines, oldIdx, newIdx, contentWidgets });
    if (additionMatch) return additionMatch;

    return this.handleDirectReplacement({ oldLines, newLines, oldIdx, newIdx, decorations, contentWidgets });
  }

  /**
   * Performs lookahead matching to find line correspondence.
   * Generic helper that checks if lines match at different offsets.
   */
  private tryLookaheadMatch(
    currentLine: string,
    searchLines: string[],
    searchStartIdx: number,
    maxLookahead: number
  ): number {
    for (let lookahead = 1; lookahead <= maxLookahead && searchStartIdx + lookahead < searchLines.length; lookahead++) {
      if (currentLine === searchLines[searchStartIdx + lookahead]) {
        return lookahead;
      }
    }
    return -1;
  }

  private checkDeletion(params: {
    oldLines: string[];
    newLines: string[];
    oldIdx: number;
    newIdx: number;
    decorations: any[];
  }): { oldIdx: number; newIdx: number } | null {
    const { oldLines, newLines, oldIdx, newIdx, decorations } = params;
    const lookahead = this.tryLookaheadMatch(oldLines[oldIdx], newLines, newIdx, 3);
    
    if (lookahead !== -1) {
      for (let i = 0; i < lookahead; i++) {
        this.addAdditionDecoration(decorations, newIdx + i);
      }
      return { oldIdx, newIdx: newIdx + lookahead };
    }
    return null;
  }

  private checkAddition(params: {
    oldLines: string[];
    newLines: string[];
    oldIdx: number;
    newIdx: number;
    contentWidgets: any[];
  }): { oldIdx: number; newIdx: number } | null {
    const { oldLines, newLines, oldIdx, newIdx, contentWidgets } = params;
    const lookahead = this.tryLookaheadMatch(newLines[newIdx], oldLines, oldIdx, 3);
    
    if (lookahead !== -1) {
      for (let i = 0; i < lookahead; i++) {
        contentWidgets.push({
          lineNumber: newIdx + 1,
          text: oldLines[oldIdx + i],
        });
      }
      return { oldIdx: oldIdx + lookahead, newIdx };
    }
    return null;
  }

  private handleDirectReplacement(params: {
    oldLines: string[];
    newLines: string[];
    oldIdx: number;
    newIdx: number;
    decorations: any[];
    contentWidgets: any[];
  }): { oldIdx: number; newIdx: number } {
    const { oldLines, oldIdx, newIdx, decorations, contentWidgets } = params;
    contentWidgets.push({
      lineNumber: newIdx + 1,
      text: oldLines[oldIdx],
    });
    this.addAdditionDecoration(decorations, newIdx);
    return { oldIdx: oldIdx + 1, newIdx: newIdx + 1 };
  }

  /**
   * Creates view zones for removed lines.
   */
  private createViewZones(control: any, contentWidgets: any[]): string[] {
    const zoneIds: string[] = [];
    control.changeViewZones((changeAccessor: any) => {
      for (const widget of contentWidgets) {
        try {
          const container = document.createElement('div');
          container.style.cssText = `
            background: rgba(255, 129, 130, 0.15) !important;
            border-left: 4px solid #ff0000 !important;
            padding: 4px 8px !important;
            font-family: var(--monaco-monospace-font), monospace !important;
            font-size: var(--monaco-font-size, 14px) !important;
            line-height: var(--monaco-line-height, 19px) !important;
            color: #a31515 !important;
            width: 100% !important;
            box-sizing: border-box !important;
          `;

          const lineText = document.createElement('span');
          lineText.textContent = widget.text;
          lineText.style.cssText = 'opacity: 0.8;';
          container.appendChild(lineText);

          const zoneId = changeAccessor.addZone({
            afterLineNumber: widget.lineNumber - 1,
            heightInLines: 1,
            domNode: container,
            suppressMouseDown: true,
          });
          zoneIds.push(zoneId);
        } catch (e) {
          // Ignore zone creation errors
        }
      }
    });
    return zoneIds;
  }

  /**
   * Sets up auto-removal of decorations and view zones.
   */
  private scheduleDecorationsRemoval(
    control: any,
    decorationIds: string[],
    zoneIds: string[]
  ): void {
    const timerId = window.setTimeout(() => {
      this.decorationTimers.delete(timerId);
      try {
        control.deltaDecorations(decorationIds, []);
        control.changeViewZones((changeAccessor: any) => {
          zoneIds.forEach((zoneId) => changeAccessor.removeZone(zoneId));
        });
      } catch (e) {
        // Ignore if editor closed
      }
    }, WIDGET_TIMING.DECORATION_AUTO_REMOVE);
    this.decorationTimers.add(timerId);
  }

  private async showInlineDiff(
    uri: any,
    filePath: string,
    oldCode: string,
    newCode: string
  ): Promise<void> {
    try {
      const monaco = await this.getMonacoControl(uri);
      if (!monaco) return;

      const { control, model } = monaco;
      const oldLines = oldCode.split('\n');
      const newLines = newCode.split('\n');

      // Apply the new content
      model.pushEditOperations(
        [],
        [
          {
            range: model.getFullModelRange(),
            text: newCode,
          },
        ],
        () => null
      );

      // Compute diff and create decorations
      const { decorations, contentWidgets } = this.computeDiffElements(
        oldLines,
        newLines
      );

      // Apply decorations and view zones
      const decorationIds = control.deltaDecorations([], decorations);
      const zoneIds = this.createViewZones(control, contentWidgets);

      control.pushUndoStop();
      control.focus();

      // Schedule auto-removal
      this.scheduleDecorationsRemoval(control, decorationIds, zoneIds);
    } catch (error) {
      spectreError('Error showing inline diff:', error);
      // Fallback to simple edit
      const monaco = await this.getMonacoControl(uri);
      if (monaco) {
        this.applySimpleEdit(monaco.control, monaco.model, newCode);
      }
    }
  }

  /**
   * Simple fallback edit method
   */
  private applySimpleEdit(control: any, model: any, newCode: string): void {
    const range = model.getFullModelRange();
    model.pushEditOperations(
      [],
      [
        {
          range,
          text: newCode,
        },
      ],
      () => null
    );
    control.pushUndoStop();
    control.focus();
  }

  /**
   * Build board search cache with normalized data.
   * Eliminates repeated string operations by pre-computing normalized forms.
   */
  private buildBoardCache(boards: any[]): void {
    const now = Date.now();
    this.boardSearchCache = new Map();

    for (const board of boards) {
      const normalizedName = board.name.toLowerCase();
      const normalizedWords = normalizedName
        .split(/[\s\-_]+/)
        .filter((w: string) => w.length >= 2);

      this.boardSearchCache.set(board.fqbn, {
        board,
        normalizedName,
        normalizedWords,
        lastUpdated: now,
      });
    }

    spectreLog(
      `📦 Board cache built: ${this.boardSearchCache.size} boards cached`
    );
  }

  /**
   * Check if board cache is valid.
   */
  private isBoardCacheValid(): boolean {
    if (!this.boardSearchCache || this.boardSearchCache.size === 0) {
      return false;
    }

    // Get first cached entry to check TTL
    const firstEntry = this.boardSearchCache.values().next().value;
    if (!firstEntry) return false;

    const age = Date.now() - firstEntry.lastUpdated;
    return age < this.BOARD_CACHE_TTL_MS;
  }

  /**
   * Find board by name - SMART matching with typo tolerance.
   * Uses cached normalized data for O(1) lookups.
   * Returns the FIRST board where ALL input words appear in the board name (with fuzzy matching).
   */
  private findBoardByName(inputName: string, boards: any[]): any | null {
    spectreLog('\n🔍 ===== SEARCHING FOR BOARD =====');
    spectreLog('Input:', inputName);

    if (!this.isBoardCacheValid()) {
      this.buildBoardCache(boards);
    }

    const inputWords = inputName
      .toLowerCase()
      .split(/[\s\-_]+/)
      .filter((w: string) => w.length >= 2);
    spectreLog('Input words:', inputWords);

    const exactMatch = this.tryExactMatch(inputWords);
    if (exactMatch) return exactMatch;

    spectreLog('⚠️ No exact match, trying fuzzy matching...');
    const fuzzyMatch = this.tryFuzzyMatch(inputWords);
    if (fuzzyMatch) return fuzzyMatch;

    spectreLog('❌ No match found');
    return null;
  }

  private tryExactMatch(inputWords: string[]): any | null {
    for (const cached of this.boardSearchCache!.values()) {
      const allWordsMatch = inputWords.every((inputWord: string) => {
        return cached.normalizedName.includes(inputWord);
      });

      if (allWordsMatch) {
        spectreLog('✅ EXACT MATCH:', cached.board.name);
        spectreLog('   FQBN:', cached.board.fqbn);
        return cached.board;
      }
    }
    return null;
  }

  private tryFuzzyMatch(inputWords: string[]): any | null {
    for (const cached of this.boardSearchCache!.values()) {
      const allWordsFuzzyMatch = inputWords.every((inputWord: string) => {
        if (cached.normalizedName.includes(inputWord)) return true;
        return cached.normalizedWords.some((boardWord: string) => {
          return this.isFuzzyMatch(inputWord, boardWord);
        });
      });

      if (allWordsFuzzyMatch) {
        spectreLog('✅ FUZZY MATCH:', cached.board.name);
        spectreLog('   FQBN:', cached.board.fqbn);
        return cached.board;
      }
    }
    return null;
  }

  /**
   * Check if two words are similar enough (handles typos)
   * Returns true if words are similar (1-2 character difference allowed)
   */
  private isFuzzyMatch(word1: string, word2: string): boolean {
    // If one word contains the other, it's a match
    if (word1.includes(word2) || word2.includes(word1)) return true;

    // Use Levenshtein distance for typo tolerance
    const distance = this.levenshteinDistance(word1, word2);
    const maxLength = Math.max(word1.length, word2.length);

    // Allow 1 character difference for short words (3-5 chars)
    // Allow 2 character differences for longer words (6+ chars)
    if (maxLength <= 5) {
      return distance <= 1; // Max 1 typo for short words
    } else {
      return distance <= 2; // Max 2 typos for longer words
    }
  }

  /**
   * Calculate Levenshtein distance (edit distance) between two strings
   * Measures how many single-character edits are needed to change one word into another
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;

    // Create matrix
    const matrix: number[][] = [];
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }

    // Fill matrix
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j] + 1, // deletion
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j - 1] + 1 // substitution
          );
        }
      }
    }

    return matrix[len1][len2];
  }

  /**
   * Agent board selection - SIMPLE AND DIRECT
   * User provides board NAME → we find it → we select it
   * NO FQBN BULLSHIT - just match the name and select the board
   */
  private async agentSelectBoard(input: string): Promise<string> {
    try {
      spectreLog('\n🎯 ===== BOARD SELECTION START =====');
      spectreLog('User input:', input);

      await this.boardsServiceProvider.ready;
      const allBoards = await this.getInstalledBoards();
      const matchedBoard = this.findBoardByName(input.toLowerCase().trim(), allBoards);

      if (!matchedBoard) {
        return `❌ Board not found: "${input}". Check installed boards in Tools → Board menu.`;
      }

      spectreLog('✅ MATCHED BOARD:', matchedBoard.name);
      spectreLog('✅ FQBN:', matchedBoard.fqbn);

      return await this.selectAndValidateBoard(matchedBoard);
    } catch (error: unknown) {
      spectreError('❌ Board selection error:', error);
      return `❌ Failed to select board: ${this.getErrorMessage(error)}`;
    }
  }

  private async getInstalledBoards(): Promise<any[]> {
    const installedBoards = await this.boardsService.getInstalledBoards();
    return installedBoards.filter((board: any) => board.fqbn && board.name);
  }

  private async selectAndValidateBoard(matchedBoard: any): Promise<string> {
    const currentConfig = this.boardsServiceProvider.boardsConfig;
    if (currentConfig?.selectedBoard?.fqbn === matchedBoard.fqbn) {
      spectreLog('✅ Board is already selected');
      return `✅ Board already selected: ${matchedBoard.name} (${matchedBoard.fqbn}). No action needed - board configuration is ready.`;
    }

    this.boardsServiceProvider.updateConfig({
      name: matchedBoard.name,
      fqbn: matchedBoard.fqbn,
    });

    await this.delay(WIDGET_TIMING.BOARD_SELECTION_DELAY);

    const updatedConfig = this.boardsServiceProvider.boardsConfig;
    if (updatedConfig?.selectedBoard?.fqbn === matchedBoard.fqbn) {
      spectreLog('✅ BOARD SELECTED SUCCESSFULLY');
      return `✅ Board selected: ${matchedBoard.name} (${matchedBoard.fqbn})`;
    }

    spectreWarn('⚠️ Selection validation failed');
    return `⚠️ Board selected but validation failed: ${matchedBoard.name}`;
  }

  private async agentSelectPort(port: string): Promise<string> {
    try {
      spectreLog('🔧 Selecting port:', port);

      // Find the port in detected ports
      const detectedPorts = Object.values(
        this.boardsServiceProvider.detectedPorts
      );
      const targetPort = detectedPorts.find(
        (dp: any) => dp.port.address === port
      );

      if (targetPort) {
        spectreLog('🔧 Found port, selecting:', targetPort.port.address);
        this.boardsServiceProvider.updateConfig({
          protocol: targetPort.port.protocol,
          address: targetPort.port.address,
        });
        await this.delay(WIDGET_TIMING.BOARD_SELECTION_DELAY); // Wait for selection
        return `✅ Port selected: ${targetPort.port.address} (${
          targetPort.port.protocolLabel || targetPort.port.protocol
        })`;
      } else {
        // List available ports to help user
        const availablePorts = detectedPorts
          .map((dp: any) => dp.port.address)
          .join(', ');
        if (availablePorts) {
          return `❌ Port "${port}" not found. Available ports: ${availablePorts}. Please check your Arduino connection or use one of the available ports.`;
        } else {
          return `❌ Port "${port}" not found and no development boards detected. Please check your board connection.`;
        }
      }
    } catch (error: unknown) {
      spectreError('❌ Port selection error:', error);
      return `❌ Failed to select port: ${this.getErrorMessage(error)}`;
    }
  }

  private async agentGetBoardsList(): Promise<string> {
    try {
      // Get detected boards (connected devices)
      const boardList = this.boardsServiceProvider.boardList;
      const detectedBoards = boardList.boards
        .filter((board: any) => board.board && board.board.fqbn)
        .map(
          (board: any) =>
            `- ${board.board.name} (FQBN: ${board.board.fqbn}) [Connected]`
        )
        .join('\n');

      // Also get all available boards from installed platforms via searchBoards
      let allAvailableBoards: string[] = [];
      try {
        const searchResults = await this.boardsService.searchBoards({
          query: '',
        });
        allAvailableBoards = searchResults
          .filter((board: any) => board.fqbn && board.name)
          .map((board: any) => `- ${board.name} (FQBN: ${board.fqbn})`)
          .slice(0, 20); // Limit to first 20 to avoid overwhelming output
      } catch (searchError) {
        spectreWarn('Failed to search boards:', searchError);
      }

      let result = '📋 **Available Boards:**\n';

      if (detectedBoards) {
        result += '\n**🔌 Connected Boards:**\n' + detectedBoards + '\n';
      }

      if (allAvailableBoards.length > 0) {
        result +=
          '\n**📚 All Available Boards (from installed platforms):**\n' +
          allAvailableBoards.join('\n') +
          '\n';
      }

      if (!detectedBoards && allAvailableBoards.length === 0) {
        result +=
          'No boards available. Please:\n1. Connect your development board, or\n2. Install board packages via Boards Manager\n3. Make sure the IDE can detect your hardware';
      }

      result +=
        '\n\n💡 Use [ACTION:SELECT_BOARD:board_name] to select any board by its name from the list above.';
      return result;
    } catch (error: unknown) {
      return `❌ Failed to get board list: ${this.getErrorMessage(error)}`;
    }
  }

  private async agentGetPortsList(): Promise<string> {
    try {
      const detectedPorts = Object.values(
        this.boardsServiceProvider.detectedPorts
      );
      if (detectedPorts.length === 0) {
        return '❌ No development boards detected. Please check:\n• Board is connected via USB cable\n• Board drivers are installed\n• Cable supports data transfer (not power-only)\n• Board is powered on';
      }

      const portsList = detectedPorts
        .map((dp: any) => {
          const boardInfo =
            dp.matchingBoards?.length > 0
              ? ` (Board: ${dp.matchingBoards[0].name})`
              : '';
          return `- ${dp.port.address} (${
            dp.port.protocolLabel || dp.port.protocol
          })${boardInfo}`;
        })
        .join('\n');

      return `📋 Available ports:\n${portsList}\n\n💡 Use [ACTION:SELECT_PORT:address] to select a port.`;
    } catch (error: unknown) {
      spectreError('❌ Port listing error:', error);
      return `❌ Failed to list ports: ${this.getErrorMessage(error)}`;
    }
  }

  private async agentGetBoardConfig(fqbn?: string): Promise<string> {
    try {
      // If no FQBN provided, use currently selected board
      let targetFqbn = fqbn;
      if (!targetFqbn) {
        const currentBoard =
          this.boardsServiceProvider.boardsConfig.selectedBoard;
        if (!currentBoard?.fqbn) {
          return `❌ No board selected. Please select a board first using [ACTION:SELECT_BOARD:board_name].`;
        }
        targetFqbn = currentBoard.fqbn;
      }

      spectreLog('🔧 Getting board configuration for FQBN:', targetFqbn);

      // Get board details including configuration options
      const boardDetails = await this.boardsService.getBoardDetails({
        fqbn: targetFqbn,
      });
      if (!boardDetails) {
        return `❌ Could not get board details for ${targetFqbn}. Make sure the board platform is installed.`;
      }

      if (boardDetails.configOptions.length === 0) {
        return `✅ Board "${targetFqbn}" has no configuration options available.`;
      }

      // Format configuration options with current selections
      const configList = boardDetails.configOptions
        .map((option) => {
          const availableValues = option.values
            .map(
              (v) => `${v.value}="${v.label}"${v.selected ? ' (current)' : ''}`
            )
            .join(', ');
          return `- **${option.option}** (${option.label}): ${availableValues}`;
        })
        .join('\n');

      const boardName =
        this.boardsServiceProvider.boardsConfig.selectedBoard?.name ||
        targetFqbn;
      return `⚙️ **Board Configuration for "${boardName}":**\n\n${configList}\n\n💡 Use [ACTION:SET_BOARD_CONFIG:option=value] to configure options.`;
    } catch (error: unknown) {
      spectreError('❌ Board config error:', error);
      return `❌ Failed to get board configuration: ${this.getErrorMessage(error)}`;
    }
  }

  /**
   * Parses board configuration options from string format.
   */
  private parseConfigOptions(options: string): Array<{
    option: string;
    selectedValue: string;
  }> {
    return options.split(',').map((opt) => {
      const [option, selectedValue] = opt.trim().split('=');
      if (!option || !selectedValue) {
        throw new Error(
          `Invalid option format: "${opt}". Use format: option=value`
        );
      }
      return { option: option.trim(), selectedValue: selectedValue.trim() };
    });
  }

  /**
   * Resolves board name from FQBN using board details and search.
   */
  private async resolveBoardName(fqbn: string): Promise<string> {
    try {
      const boardDetails = await this.boardsService.getBoardDetails({ fqbn });
      if (boardDetails) {
        const resolvedName = await this.searchForBoardName(fqbn);
        if (resolvedName) {
          return resolvedName;
        }
      }
    } catch (e) {
      spectreWarn('Could not get board details for name resolution:', e);
    }

    return this.extractBoardIdFromFqbn(fqbn);
  }

  private async searchForBoardName(fqbn: string): Promise<string | null> {
    const searchParts = fqbn.split(':');
    const searchTerm = searchParts.length >= 3 ? searchParts[2] : fqbn;
    const searchResults = await this.boardsService.searchBoards({ query: searchTerm });
    
    const platformPrefix = searchParts.slice(0, Math.min(3, searchParts.length)).join(':');
    const matchingBoard = searchResults.find(
      (b: any) => b.fqbn === fqbn || b.fqbn?.startsWith(platformPrefix)
    );

    if (matchingBoard?.name) {
      return matchingBoard.name;
    }

    const boardId = this.extractBoardIdFromFqbn(fqbn);
    return boardId;
  }

  private extractBoardIdFromFqbn(fqbn: string): string {
    const fqbnParts = fqbn.split(':');
    const boardId = fqbnParts.length >= 3 ? fqbnParts[2] : fqbnParts[fqbnParts.length - 1];
    return boardId || 'Platform Board';
  }

  private async agentSetBoardConfig(
    fqbn: string | undefined,
    options: string
  ): Promise<string> {
    try {
      const targetFqbn = await this.resolveBoardFqbn(fqbn);
      if (targetFqbn.startsWith('❌')) {
        return targetFqbn;
      }

      spectreLog('🔧 Setting board configuration:', targetFqbn, options);

      const optionsToUpdate = this.parseConfigOptions(options);
      const updateResult = await this.applyBoardConfigUpdate(targetFqbn, optionsToUpdate);

      if (typeof updateResult === 'string') {
        return updateResult;
      }

      const optionsText = optionsToUpdate
        .map((o) => `${o.option}=${o.selectedValue}`)
        .join(', ');
      return `✅ Board configuration updated: ${optionsText}\n\nFull FQBN: ${
        updateResult.updatedFqbn || targetFqbn
      }`;
    } catch (error: unknown) {
      spectreError('❌ Board config update error:', error);
      return `❌ Failed to set board configuration: ${this.getErrorMessage(error)}`;
    }
  }

  private async resolveBoardFqbn(fqbn: string | undefined): Promise<string> {
    if (fqbn) {
      return fqbn;
    }

    const currentBoard = this.boardsServiceProvider.boardsConfig.selectedBoard;
    if (!currentBoard?.fqbn) {
      return `❌ No board selected. Please select a board first using [ACTION:SELECT_BOARD:board_name].`;
    }

    return currentBoard.fqbn;
  }

  private async applyBoardConfigUpdate(
    targetFqbn: string,
    optionsToUpdate: Array<{ option: string; selectedValue: string }>
  ): Promise<{ updatedFqbn: string | undefined } | string> {
    const success = await this.boardsDataStore.selectConfigOption({
      fqbn: targetFqbn,
      optionsToUpdate,
    });

    if (!success) {
      return `❌ Failed to update board configuration. Please check that the options exist and values are valid.`;
    }

    const updatedFqbn = await this.boardsDataStore.appendConfigToFqbn(targetFqbn);

    if (updatedFqbn) {
      await this.updateBoardProviderConfig(targetFqbn, updatedFqbn);
    }

    return { updatedFqbn };
  }

  private async updateBoardProviderConfig(targetFqbn: string, updatedFqbn: string): Promise<void> {
    let boardName = this.boardsServiceProvider.boardsConfig.selectedBoard?.name;

    if (!boardName || boardName === 'Unknown') {
      boardName = await this.resolveBoardName(targetFqbn);
    }

    this.boardsServiceProvider.updateConfig({
      name: boardName || 'Platform Board',
      fqbn: updatedFqbn,
    });
  }

  /**
   * Parses AI response and automatically executes Arduino IDE actions in agent mode with task tracking.
   */
  /**
   * Requests AI to analyze an error and provide a fix
   */
  /**
   * Gets daily request and token usage stats.
   */
  private getDailyStats(): { requests: number; tokens: number } {
    return {
      requests: this.stateData.dailyTracker.requestCount,
      tokens: this.stateData.dailyTracker.tokenCount,
    };
  }

  /**
   * Lifecycle: Called when widget is attached to the DOM.
   * Establishes backend connection and syncs quota state.
   */
  protected override async onAfterAttach(msg: any): Promise<void> {
    super.onAfterAttach(msg);

    // Subscribe to AI client events for streaming responses and quota updates
    this.toDispose.push(this.aiClient.onStreamEvent((e) => this.onStream(e)));
    this.toDispose.push(this.aiClient.onQuotaEvent((u) => this.onQuota(u)));

    // Start clock ticker for UI updates (time-based displays)
    this.startClock();

    // Establish backend connection and sync initial quota state
    // This triggers backend's setClient() which pushes current quota immediately
    await this.refreshQuotaForCurrentModel();

    // Listen for model preference changes to refresh quota when user switches models
    const prefDisposable = (this.prefs as any).onPreferenceChanged?.(
      (e: any) => {
        if (e.preferenceName === 'arduino.spectre.model') {
          // Update RPM limit immediately when model changes
          this.setStateData({ rpmLimit: this.getRpmLimit() });
          // Then refresh quota from backend
          this.refreshQuotaForCurrentModel();
        }
      }
    );
    if (prefDisposable) {
      this.toDispose.push(prefDisposable);
    }

    // Also update RPM limit immediately after attach in case preferences loaded late
    // This ensures correct display even if backend sync is delayed
    this.setStateData({ rpmLimit: this.getRpmLimit() });
  }
  protected override onBeforeDetach(msg: any): void {
    super.onBeforeDetach(msg);

    // Widget detach cleanup
    this.detachStreamListener();
    this.stopClock();
  }

  protected override onBeforeShow(msg: any): void {
    super.onBeforeShow(msg);
  }

  /**
   * Called when the widget is activated (gains focus).
   * Focuses the input textarea, lazy-loads react-markdown library,
   * and hooks into sketch change events for context awareness.
   */
  protected override async onActivateRequest(msg: any): Promise<void> {
    super.onActivateRequest(msg);
    // Prefer focusing the input textarea so the widget accepts focus promptly.
    // Fall back to container if input is disabled or missing.
    const tryFocus = () => {
      const input = this.inputRef;
      if (input && !input.disabled) {
        input.focus();
        // Place caret at end
        try {
          input.selectionStart = input.selectionEnd = input.value.length;
        } catch (err) {
          spectreLog('Failed to position cursor (activate):', err);
        }
      } else {
        // Ensure the container is at least focusable
        (this.node as HTMLElement).setAttribute(
          'tabindex',
          (this.node as HTMLElement).getAttribute('tabindex') ?? '-1'
        );
        (this.node as HTMLElement).focus();
      }
    };
    // Defer to next frame to ensure DOM is ready
    requestAnimationFrame(tryFocus);
    if (!ReactMarkdownLazy) {
      try {
        ReactMarkdownLazy = (await import('react-markdown')).default;
        this.update();
      } catch (error) {
        spectreWarn(
          'Failed to load react-markdown, using fallback rendering:',
          error
        );
        ReactMarkdownLazy = null; // Signal to use fallback
        this.update();
      }
    }
    await this.hookSketchChanges();
  }

  /**
   * Focuses the input textarea and places the caret at the end.
   * Retries with requestAnimationFrame to handle timing issues.
   */
  private isInputFocusable(input: HTMLTextAreaElement | null | undefined): boolean {
    return !!input && !input.disabled && input.offsetParent !== null;
  }

  private focusInput(): void {
    const tryFocus = () => {
      const input = this.inputRef;
      if (this.isInputFocusable(input)) {
        input!.focus();
        // Place caret at end
        try {
          input!.selectionStart = input!.selectionEnd = input!.value.length;
        } catch (err) {
          spectreLog('Failed to position cursor (focus):', err);
        }
      }
    };
    // Small delay to ensure DOM is ready and any state updates have finished
    setTimeout(tryFocus, WIDGET_TIMING.FOCUS_INPUT_DELAY);
  }

  /**
   * Detects if a text contains Arduino code patterns
   */
  private containsArduinoCode(text: string): boolean {
    const arduinoPatterns = [
      // Core Arduino functions
      /void\s+setup\s*\(\s*\)\s*\{/,
      /void\s+loop\s*\(\s*\)\s*\{/,

      // Arduino includes
      /#include\s*[<"].*\.h[>"]/,

      // Digital I/O functions
      /digitalWrite\s*\(/,
      /digitalRead\s*\(/,
      /pinMode\s*\(/,

      // Analog I/O functions
      /analogRead\s*\(/,
      /analogWrite\s*\(/,
      /analogReference\s*\(/,

      // Serial communication
      /Serial\.begin\s*\(/,
      /Serial\.print(ln)?\s*\(/,
      /Serial\.available\s*\(/,
      /Serial\.read\s*\(/,

      // Timing functions
      /delay\s*\(/,
      /delayMicroseconds\s*\(/,
      /millis\s*\(/,
      /micros\s*\(/,

      // Arduino framework types and constants (used by all platforms in Arduino IDE)
      /\b(HIGH|LOW|INPUT|OUTPUT|INPUT_PULLUP)\b/,
      /\b(LED_BUILTIN|A0|A1|A2|A3|A4|A5)\b/,

      // Common Arduino variable declarations
      /\b(int|byte|boolean|float|double|char|String)\s+\w+\s*[=;]/,

      // Pin definitions
      /\bconst\s+int\s+\w*[Pp]in\s*=/,
      /\bint\s+\w*[Pp]in\s*=/,

      // Arduino libraries
      /\b(Servo|SoftwareSerial|Wire|SPI|Stepper|LiquidCrystal)\s*\w*/,
    ];

    // Require at least 2 Arduino patterns for better accuracy
    const matches = arduinoPatterns.filter((pattern) =>
      pattern.test(text)
    ).length;
    return matches >= 2;
  }

  private isEmptyLineOrComment(trimmed: string): boolean {
    return trimmed === '' || trimmed.startsWith('*') || trimmed.startsWith('//');
  }

  private isArduinoLanguageOrCode(language: string, code: string): boolean {
    return !!language.match(/^(cpp|c|arduino|ino)$/) || this.containsArduinoCode(code);
  }

  private requiresFunctionCalling(response: any): boolean {
    return !!(response.requiresAction && response.functionCalls && response.functionCalls.length > 0);
  }

  private hasNoErrorIndicators(error: string | undefined): boolean {
    return !error?.includes('error') && !error?.includes('failed') && !error?.includes('timeout');
  }

  private shouldStopPortRetries(attempt: any): boolean {
    const isPortRelated = (errText: string, shouldRetry: boolean | undefined): boolean => {
      if (shouldRetry === false) return false;
      const portIndicators = [
        'port',
        'serial',
        'access denied',
        'permission',
        'device not found',
      ];
      return portIndicators.some((indicator) =>
        errText.toLowerCase().includes(indicator)
      );
    };
    return attempt.shouldRetry === false || !isPortRelated(attempt.errText || '', attempt.shouldRetry);
  }

  private shouldUpdateMemory(newText: string, oldText: string, memory: any): boolean {
    return newText !== oldText && newText.trim() !== '' && !!memory;
  }

  private canSendMessage(text: string, busy: boolean, sending: boolean): boolean {
    return !!text && !busy && !sending;
  }

  private isNetworkError(message: string): boolean {
    const msg = message.toLowerCase();
    return msg.includes('network') || msg.includes('fetch') || msg.includes('connection');
  }

  private isCompletedCheckbox(checkbox: string): boolean {
    return checkbox === 'x' || checkbox === '✓' || checkbox === '✔';
  }

  private isInProgressCheckbox(checkbox: string): boolean {
    return checkbox === 'o' || checkbox === '~' || checkbox === '⏳';
  }

  private isFailedCheckbox(checkbox: string, description: string): boolean {
    return (
      checkbox === '!' ||
      (checkbox === 'x' && description.toLowerCase().includes('failed'))
    );
  }

  /**
   * Extracts Arduino code from text (looks for code blocks or detects Arduino patterns)
   */
  /**
   * Extracts explicit code blocks (```cpp, ```c, ```arduino, ```ino, or plain ```).
   */
  private extractExplicitCodeBlocks(
    text: string
  ): Array<{ code: string; type: 'block' | 'inline'; language?: string }> {
    const codeBlocks: Array<{
      code: string;
      type: 'block' | 'inline';
      language?: string;
    }> = [];

    const codeBlockRegex = /```(?:(cpp|c|arduino|ino))?\n?([\s\S]*?)\n?```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const language = match[1] || 'arduino';
      const code = match[2].trim();
      if (code && this.isArduinoLanguageOrCode(language, code)) {
        codeBlocks.push({ code, type: 'block', language });
      }
    }

    return codeBlocks;
  }

  /**
   * Checks if a line is a strong code indicator.
   */
  private isCodeLine(line: string): boolean {
    const trimmed = line.trim();

    return (
      trimmed.startsWith('#include') ||
      trimmed.includes('void setup') ||
      trimmed.includes('void loop') ||
      /^\s*(int|float|char|bool|String|const)\s+\w+/.test(line) ||
      /^\s*\w+\s*\([^)]*\)\s*;?\s*$/.test(line) ||
      /^\s*(digitalWrite|digitalRead|pinMode|analogRead|analogWrite|Serial\.)/.test(
        line
      ) ||
      trimmed.startsWith('//') ||
      /^\s*[{}]\s*$/.test(line) ||
      /^\s*\w+\s*=/.test(line)
    );
  }

  /**
   * Checks if line should be added to code section.
   */
  private shouldAddToCodeSection(params: {
    line: string;
    trimmed: string;
    inCodeSection: boolean;
    isCode: boolean;
    isExplanation: boolean;
    codeStarted: boolean;
  }): { add: boolean; continueSection: boolean } {
    const { trimmed, inCodeSection, isCode, isExplanation, codeStarted } = params;

    if (isCode) {
      return { add: true, continueSection: true };
    }

    if (inCodeSection && this.isEmptyLineOrComment(trimmed)) {
      return { add: true, continueSection: true };
    }

    if (isExplanation && codeStarted) {
      return { add: false, continueSection: false };
    }

    if (inCodeSection && !isExplanation) {
      return { add: true, continueSection: true };
    }

    return { add: false, continueSection: false };
  }

  /**
   * Checks if a line looks like explanatory text rather than code.
   */
  private isExplanatoryText(line: string, isCodeLine: boolean): boolean {
    const trimmed = line.trim();
    return (
      trimmed.length > 0 &&
      /^[A-Z]/.test(trimmed) &&
      !isCodeLine &&
      !trimmed.startsWith('#') &&
      trimmed.includes(' ') &&
      trimmed.split(' ').length > 3
    );
  }

  /**
   * Extracts inline code from mixed text by analyzing line patterns.
   */
  private extractInlineCode(text: string): string | null {
    const lines = text.split('\n');
    const codeLines = this.processCodeLines(lines);
    return this.validateExtractedCode(codeLines);
  }

  private processCodeLines(lines: string[]): string[] {
    const codeLines: string[] = [];
    let inCodeSection = false;
    let codeStarted = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const isCode = this.isCodeLine(line);
      const isExplanation = this.isExplanatoryText(trimmed, isCode);

      const decision = this.shouldAddToCodeSection({
        line,
        trimmed,
        inCodeSection,
        isCode,
        isExplanation,
        codeStarted,
      });

      if (decision.add) {
        codeLines.push(line);
        if (isCode) {
          codeStarted = true;
        }
      }

      inCodeSection = decision.continueSection;
    }

    return codeLines;
  }

  private validateExtractedCode(codeLines: string[]): string | null {
    if (codeLines.length <= 3) {
      return null;
    }

    const cleanCode = codeLines
      .join('\n')
      .trim()
      .replace(/^\n+|\n+$/g, '');
    
    if (cleanCode && this.containsArduinoCode(cleanCode)) {
      return cleanCode;
    }

    return null;
  }

  private isEditorReady(success: boolean, editor: any): boolean {
    return success && editor && editor.editor;
  }

  private extractArduinoCode(
    text: string
  ): Array<{ code: string; type: 'block' | 'inline'; language?: string }> {
    // First, try to find explicit code blocks
    const explicitBlocks = this.extractExplicitCodeBlocks(text);
    if (explicitBlocks.length > 0) {
      return explicitBlocks;
    }

    // If no explicit code blocks and no Arduino code detected, return empty
    if (!this.containsArduinoCode(text)) {
      return [];
    }

    // Try to extract inline code from mixed text
    const inlineCode = this.extractInlineCode(text);
    if (inlineCode) {
      return [{ code: inlineCode, type: 'inline' }];
    }

    return [];
  }

  /**
   * Copies text to clipboard
   */
  private async copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textArea);
      return success;
    }
  }

  /**
   * Pastes code directly to Monaco editor.
   */
  private pasteToMonacoEditor(monacoEditor: any, code: string): boolean {
    const model = monacoEditor.getModel();

    if (model) {
      // Replace all content with the new code
      const fullRange = model.getFullModelRange();
      monacoEditor.executeEdits('paste-arduino-code', [
        {
          range: fullRange,
          text: code,
        },
      ]);

      // Position cursor at the beginning
      monacoEditor.setPosition({ lineNumber: 1, column: 1 });
      monacoEditor.focus();

      return true;
    }

    return false;
  }

  /**
   * Fallback to clipboard when direct paste fails.
   */
  private async fallbackToClipboard(code: string, editor?: any): Promise<boolean> {
    spectreWarn(
      'Could not access Monaco editor directly, falling back to clipboard'
    );
    const success = await this.copyToClipboard(code);
    if (this.isEditorReady(success, editor)) {
      editor.editor.focus();
    }
    return success;
  }

  /**
   * Pastes code to the current editor, replacing all content
   */
  private async pasteToEditor(code: string): Promise<boolean> {
    try {
      const editor = this.editorManager.currentEditor;
      if (!editor || !editor.editor) {
        return false;
      }

      const textEditor = editor.editor;

      // Check if it's a Monaco editor and access the Monaco instance
      if (
        'getControl' in textEditor &&
        typeof textEditor.getControl === 'function'
      ) {
        const monacoEditor = textEditor.getControl();
        const success = this.pasteToMonacoEditor(monacoEditor, code);
        
        if (success) {
          return true;
        }
      }

      // Fallback: copy to clipboard and focus editor
      return await this.fallbackToClipboard(code, editor);
    } catch (error) {
      spectreWarn(
        'Failed to paste to editor, falling back to clipboard:',
        error
      );
      // Fallback: copy to clipboard and focus editor
      return await this.fallbackToClipboard(code, this.editorManager.currentEditor);
    }
  }

  /**
   * Renders assistant message content with integrated Arduino code blocks
   */
  private renderAssistantMessage(
    text: string,
    isStreaming: boolean
  ): React.ReactNode {
    // Always render markdown for consistency (streaming or not)
    // Modern markdown parsers are optimized and fast enough
    // This prevents jarring visual changes when stream completes

    // For completed messages, check if we should use custom code block rendering
    const codeBlocks = this.extractArduinoCode(text);
    const isBasicMode = this.prefs['arduino.spectre.mode'] !== 'agent';

    if (codeBlocks.length > 0 && isBasicMode) {
      // Custom rendering with integrated code blocks
      return this.renderMessageWithCodeBlocks(text, codeBlocks);
    } else {
      // Regular markdown rendering - same for streaming and completed
      // React-markdown is optimized for incremental updates
      return ReactMarkdownLazy && ReactMarkdownLazy !== null ? (
        <ReactMarkdownLazy>{text}</ReactMarkdownLazy>
      ) : (
        <pre style={{ whiteSpace: 'pre-wrap' }}>{text}</pre>
      );
    }
  }

  /**
   * Renders text content with markdown.
   */
  private renderMarkdownText(text: string, key: string): React.ReactNode {
    return (
      <div key={key} style={{ marginBottom: '8px' }}>
        {ReactMarkdownLazy && ReactMarkdownLazy !== null ? (
          <ReactMarkdownLazy>{text}</ReactMarkdownLazy>
        ) : (
          <pre>{text}</pre>
        )}
      </div>
    );
  }

  /**
   * Processes explicit code blocks from text.
   */
  private processExplicitCodeBlocks(
    text: string,
    codeBlocks: Array<{
      code: string;
      type: 'block' | 'inline';
      language?: string;
    }>
  ): React.ReactNode[] {
    const codeBlockRegex = /```(?:cpp|c|arduino|ino)?\n?([\s\S]*?)\n?```/g;
    let lastIndex = 0;
    const parts: React.ReactNode[] = [];
    let blockIndex = 0;

    let match;
    while (
      (match = codeBlockRegex.exec(text)) !== null &&
      blockIndex < codeBlocks.length
    ) {
      const beforeCode = text.slice(lastIndex, match.index);

      // Add text before code block
      if (beforeCode.trim()) {
        parts.push(this.renderMarkdownText(beforeCode, `text-${blockIndex}`));
      }

      // Add code block
      const codeBlock = codeBlocks[blockIndex];
      if (codeBlock && codeBlock.code.trim() === match[1].trim()) {
        parts.push(this.renderSingleCodeBlock(codeBlock, blockIndex));
        blockIndex++;
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last code block
    const remainingText = text.slice(lastIndex);
    if (remainingText.trim()) {
      parts.push(
        <div key="text-final" style={{ marginTop: '8px' }}>
          {ReactMarkdownLazy && ReactMarkdownLazy !== null ? (
            <ReactMarkdownLazy>{remainingText}</ReactMarkdownLazy>
          ) : (
            <pre>{remainingText}</pre>
          )}
        </div>
      );
    }

    return parts;
  }

  /**
   * Renders inline code blocks when no explicit blocks found.
   */
  private renderInlineCodeBlocks(
    text: string,
    codeBlocks: Array<{
      code: string;
      type: 'block' | 'inline';
      language?: string;
    }>
  ): React.ReactNode[] {
    const parts: React.ReactNode[] = [];

    parts.push(
      <div key="text-main">
        {ReactMarkdownLazy && ReactMarkdownLazy !== null ? (
          <ReactMarkdownLazy>{text}</ReactMarkdownLazy>
        ) : (
          <pre>{text}</pre>
        )}
      </div>
    );

    // Add the detected Arduino code blocks
    codeBlocks.forEach((codeBlock, index) => {
      parts.push(this.renderSingleCodeBlock(codeBlock, index));
    });

    return parts;
  }

  /**
   * Renders message text with Arduino code blocks replaced by custom components
   */
  private renderMessageWithCodeBlocks(
    text: string,
    codeBlocks: Array<{
      code: string;
      type: 'block' | 'inline';
      language?: string;
    }>
  ): React.ReactNode {
    // Process explicit code blocks
    const parts = this.processExplicitCodeBlocks(text, codeBlocks);

    // If no explicit code blocks were found, render inline code blocks
    if (parts.length === 0 && codeBlocks.length > 0) {
      return <div>{this.renderInlineCodeBlocks(text, codeBlocks)}</div>;
    }

    return <div>{parts}</div>;
  }

  /**
   * Renders a single code block with header and actions
   */
  private renderSingleCodeBlock(
    codeBlock: { code: string; type: 'block' | 'inline'; language?: string },
    index: number
  ): React.ReactNode {
    const lineCount = codeBlock.code.split('\n').length;
    const language = codeBlock.language
      ? codeBlock.language.toUpperCase()
      : 'ARDUINO';

    return (
      <div key={`code-${index}`} className="spectre-code-container">
        <div className="spectre-code-header">
          <div className="spectre-code-language">
            {language} • {lineCount} line{lineCount !== 1 ? 's' : ''}
          </div>
          <div className="spectre-code-actions">
            <button
              className="spectre-code-action-btn"
              onClick={async () => {
                const success = await this.copyToClipboard(codeBlock.code);
                const button = document.activeElement as HTMLButtonElement;
                if (button && success) {
                  const originalHTML = button.innerHTML;
                  button.classList.add('success');
                  button.innerHTML = '✓ Copied';
                  const timerId = window.setTimeout(() => {
                    this.feedbackTimers.delete(timerId);
                    button.classList.remove('success');
                    button.innerHTML = originalHTML;
                  }, WIDGET_TIMING.COPY_FEEDBACK_DURATION);
                  this.feedbackTimers.add(timerId);
                }
              }}
              aria-label="Copy code to clipboard"
              title="Copy code to clipboard"
            >
              📋 Copy
            </button>
            <button
              className="spectre-code-action-btn"
              onClick={async () => {
                const success = await this.pasteToEditor(codeBlock.code);
                const button = document.activeElement as HTMLButtonElement;
                if (button && success) {
                  const originalHTML = button.innerHTML;
                  button.classList.add('success');
                  button.innerHTML = '✓ Ready to Paste';
                  const timerId = window.setTimeout(() => {
                    this.feedbackTimers.delete(timerId);
                    button.classList.remove('success');
                    button.innerHTML = originalHTML;
                  }, WIDGET_TIMING.COPY_FEEDBACK_DURATION);
                  this.feedbackTimers.add(timerId);
                }
              }}
              aria-label="Copy code and focus editor for pasting"
              title="Copy code and focus editor for pasting"
            >
              📝 Paste
            </button>
          </div>
        </div>
        <div className="spectre-code-content">
          <pre>
            <code>{codeBlock.code}</code>
          </pre>
        </div>
      </div>
    );
  }

  private startClock(): void {
    this.stopClock();
    this.clockTicker = window.setInterval(() => {
      const now = Date.now();
      this.stateData.now = now;

      // Periodic cleanup runs every second (batched, not per-request)
      // This is acceptable as it's time-based, not per-operation
      const sixtySecondsAgo = now - 60 * 1000;
      const originalLogCount = this.stateData.requestLogs.length;
      this.stateData.requestLogs = this.stateData.requestLogs.filter(
        (log) => log.timestamp > sixtySecondsAgo
      );

      // Check for daily tracker reset (midnight Pacific Time rollover)
      const currentDate = this.getPacificDate();
      if (this.stateData.dailyTracker.date !== currentDate) {
        this.stateData.dailyTracker = {
          date: currentDate,
          requestCount: 0,
          tokenCount: 0,
        };
        // Persist the reset immediately
        this.persistTrackingData();
      }

      // Persist tracking data if logs were cleaned up
      if (this.stateData.requestLogs.length !== originalLogCount) {
        this.persistTrackingData();
      }

      this.update();
    }, 1000);
  }
  private stopClock(): void {
    if (this.clockTicker) {
      clearInterval(this.clockTicker);
      this.clockTicker = undefined;
    }
  }

  private detachStreamListener(): void {
    this.stopStreamTicker();
    this.currentAbortKey = undefined;
    this.currentRequestSeq = undefined;
  }

  private async hookSketchChanges(): Promise<void> {
    await this.loadForCurrentSketch();
    this.toDispose.push(
      this.sketchesClient.onCurrentSketchDidChange(() =>
        this.loadForCurrentSketch()
      )
    );
  }

  private storageKeyFor(sketch: CurrentSketch | undefined): string | undefined {
    return CurrentSketch.isValid(sketch)
      ? `spectre.chat.${sketch.uri}`
      : undefined;
  }

  private async loadForCurrentSketch(): Promise<void> {
    const sketch = this.sketchesClient.tryGetCurrentSketch();
    const key = this.storageKeyFor(sketch);

    // Load request tracking data from global storage
    await this.loadTrackingData();

    if (key) {
      const saved = await this.storage.getData<ChatSession[]>(key);
      if (Array.isArray(saved)) {
        // Migrate old sessions to new memory system
        const migratedSessions = await this.migrateSessions(saved);

        this.setStateData({
          sessions: migratedSessions,
          active: 0,
          sketchKey: key,
        });

        // Update memory stats for active session
        this.updateMemoryStats();
        return;
      }
    }

    // Create new session with memory system
    const newSession = await this.createSessionWithMemory();
    this.setStateData({
      sessions: [newSession],
      active: 0,
      sketchKey: key,
    });
    this.updateMemoryStats();
  }

  /**
   * Loads request tracking data from storage.
   * Includes request logs and daily tracker with automatic cleanup.
   */
  private async loadTrackingData(): Promise<void> {
    try {
      // Load request logs (keep only last 60 seconds)
      const savedLogs =
        (await this.storage.getData<RequestLog[]>('spectre.requestLogs')) || [];
      const sixtySecondsAgo = Date.now() - 60 * 1000;
      const validLogs = savedLogs.filter(
        (log) => log.timestamp > sixtySecondsAgo
      );

      // Load daily tracker
      const savedDaily = await this.storage.getData<DailyTracker>(
        'spectre.dailyTracker'
      );
      const currentDate = this.getPacificDate();

      // Reset daily tracker if date changed (midnight Pacific Time rollover)
      const dailyTracker =
        savedDaily && savedDaily.date === currentDate
          ? savedDaily
          : { date: currentDate, requestCount: 0, tokenCount: 0 };

      this.setStateData({
        requestLogs: validLogs,
        dailyTracker: dailyTracker,
      });
    } catch (error) {
      spectreWarn('Failed to load tracking data:', error);
      // Use default values on error
      this.setStateData({
        requestLogs: [],
        dailyTracker: {
          date: this.getPacificDate(),
          requestCount: 0,
          tokenCount: 0,
        },
      });
    }
  }

  /**
   * Persists both chat sessions and tracking data to storage.
   */
  private async persist(): Promise<void> {
    if (this.stateData.sketchKey) {
      await this.storage.setData(
        this.stateData.sketchKey,
        this.stateData.sessions
      );
    }
    await this.persistTrackingData();
  }

  /**
   * Persists request tracking data to global storage.
   */
  private async persistTrackingData(): Promise<void> {
    try {
      await this.storage.setData(
        'spectre.requestLogs',
        this.stateData.requestLogs
      );
      await this.storage.setData(
        'spectre.dailyTracker',
        this.stateData.dailyTracker
      );
    } catch (error) {
      spectreWarn('Failed to persist tracking data:', error);
    }
  }

  /**
   * Migrates old chat sessions to new memory system.
   * Converts ChatMessage[] to ConversationMemory with rolling buffer.
   * Also attempts to restore persisted memory from localStorage.
   */
  private async migrateSessions(
    oldSessions: ChatSession[]
  ): Promise<ChatSession[]> {
    const migrated: ChatSession[] = [];

    for (const session of oldSessions) {
      // Try to load persisted memory first
      const persistedMemory = this.loadSessionMemory(session.id);

      if (persistedMemory) {
        // Use persisted memory if available
        migrated.push({
          ...session,
          memory: persistedMemory,
        });
        continue;
      }

      // Skip if already has memory system (but no persisted version)
      if (session.memory) {
        migrated.push(session);
        continue;
      }

      // Create new memory system for this session
      const memory = this.memoryManager.createConversation(
        session.id.toString(),
        {
          maxRecentMessages: 40, // Updated to new config
          memoryBankTokenCap: 100_000, // Updated to new config
        }
      );

      // Convert old messages to raw messages in memory
      for (const msg of session.messages) {
        const rawMsg: RawMessage = {
          id: msg.id,
          role: msg.role,
          text: msg.text,
          timestamp: Date.now(), // Use current time as fallback
          estimatedTokens: TokenCounter.estimate(
            msg.text,
            msg.role === 'user' ? 'mixed' : 'natural'
          ),
        };
        memory.recentMessages.push(rawMsg);
      }

      // Trigger summarization if needed (async, non-blocking)
      if (memory.recentMessages.length > 30) {
        // Updated threshold
        this.performAsyncSummarization(memory).catch((err) =>
          spectreWarn('Background summarization failed:', err)
        );
      }

      migrated.push({
        ...session,
        memory,
      });
    }

    return migrated;
  }

  /**
   * Creates a new chat session with memory system initialized.
   * Attempts to load persisted memory if available.
   */
  private async createSessionWithMemory(
    sessionId?: number
  ): Promise<ChatSession> {
    const id = sessionId || Date.now();

    // Try to load existing memory from localStorage
    const existingMemory = this.loadSessionMemory(id);
    const memory =
      existingMemory || this.memoryManager.createConversation(id.toString());

    return {
      id,
      title: 'New Chat',
      messages: [],
      memory,
    };
  }

  /**
   * Saves session memory to localStorage for persistence across reloads.
   * Called after each message is added to memory.
   */
  private saveSessionMemory(sessionId: number): void {
    const session = this.stateData.sessions.find((s) => s.id === sessionId);
    if (!session?.memory) {
      return;
    }

    try {
      const serialized = JSON.stringify({
        sessionId: session.memory.sessionId,
        recentMessages: session.memory.recentMessages,
        memoryBank: session.memory.memoryBank,
        stats: session.memory.stats,
        config: session.memory.config,
      });
      localStorage.setItem(`spectre-memory-${sessionId}`, serialized);
      spectreLog(
        `💾 Saved memory for session ${sessionId} (${session.memory.recentMessages.length} recent, ${session.memory.memoryBank.summaries.length} summaries)`
      );
    } catch (error) {
      spectreError('Failed to save session memory:', error);
    }
  }

  /**
   * Loads session memory from localStorage when restoring a session.
   * Returns undefined if no saved memory exists.
   */
  private loadSessionMemory(sessionId: number): ConversationMemory | undefined {
    try {
      const stored = localStorage.getItem(`spectre-memory-${sessionId}`);
      if (!stored) {
        return undefined;
      }

      const parsed = JSON.parse(stored);

      // Reconstruct memory object with proper structure
      const memory = this.memoryManager.createConversation(
        sessionId.toString(),
        parsed.config
      );
      memory.recentMessages = parsed.recentMessages || [];
      memory.memoryBank = parsed.memoryBank || {
        summaries: [],
        totalTokens: 0,
        version: 1,
      };
      memory.stats = parsed.stats || {
        totalInteractions: 0,
        summarizationsPerformed: 0,
      };

      spectreLog(
        `📂 Loaded memory for session ${sessionId} (${memory.recentMessages.length} recent, ${memory.memoryBank.summaries.length} summaries)`
      );
      return memory;
    } catch (error) {
      spectreError('Failed to load session memory:', error);
      return undefined;
    }
  }

  /**
   * Updates memory stats in state for UI display.
   */
  private updateMemoryStats(): void {
    const session = this.stateData.sessions[this.stateData.active];
    if (!session?.memory) {
      this.setStateData({ memoryStats: undefined });
      return;
    }

    const stats = this.memoryManager.getStats(session.memory);
    this.setStateData({
      memoryStats: {
        recentMessages: stats.recentMessages,
        summaries: stats.summaries,
        totalTokens: stats.totalTokens,
        memoryBankTokens: stats.memoryBankTokens,
        compressionRatio: stats.compressionRatio,
        isSummarizing: false,
      },
    });
  }

  /**
   * Performs summarization asynchronously without blocking UI.
   */
  private async performAsyncSummarization(
    memory: ConversationMemory
  ): Promise<void> {
    // Show summarization indicator
    this.setStateData({
      memoryStats: {
        ...this.stateData.memoryStats,
        isSummarizing: true,
      } as any,
    });

    try {
      // This will trigger summarization if thresholds are met
      const lastMessage =
        memory.recentMessages[memory.recentMessages.length - 1];
      if (lastMessage) {
        await this.memoryManager.addMessage(
          memory,
          lastMessage.role,
          lastMessage.text
        );
      }
    } finally {
      // Update stats and hide indicator
      this.updateMemoryStats();
    }
  }

  private setStateData(patch: Partial<SpectreWidget['stateData']>): void {
    // Atomic state update to prevent race conditions
    this.stateData = { ...this.stateData, ...patch };
    this.update();
  }

  /**
   * Creates a new chat session and switches to it.
   * Called by the "New Chat" toolbar button.
   */
  async newChat(): Promise<void> {
    const newSession = await this.createSessionWithMemory();
    const sessions = [...this.stateData.sessions, newSession];

    this.setStateData({
      sessions,
      active: sessions.length - 1,
      error: undefined,
      tasks: [],
    });
    this.updateMemoryStats();
    this.persist();
  }

  /**
   * Clears all messages in the current chat session.
   * Called by the "Clear Chat" toolbar button.
   */
  async clearChat(): Promise<void> {
    const sessions = this.stateData.sessions.slice();
    const currentSession = sessions[this.stateData.active];

    // Create fresh memory for cleared session
    const newMemory = this.memoryManager.createConversation(
      currentSession.id.toString()
    );

    sessions[this.stateData.active] = {
      ...currentSession,
      messages: [],
      title: 'New Chat',
      memory: newMemory,
    };

    this.setStateData({ sessions, error: undefined, tasks: [] });
    this.updateMemoryStats();
    this.persist();
  }

  /**
   * Closes the current chat session. If it's the last session,
   * creates a new default session to ensure at least one always exists.
   * Called by the "Close Chat" toolbar button.
   */
  async closeChat(): Promise<void> {
    const sessions = this.stateData.sessions.slice();
    sessions.splice(this.stateData.active, 1);

    // If no sessions left, create a default one
    if (!sessions.length) {
      const newSession = await this.createSessionWithMemory();
      sessions.push(newSession);
    }

    const active = Math.min(this.stateData.active, sessions.length - 1);
    this.setStateData({ sessions, active, error: undefined });
    this.updateMemoryStats();
    this.persist();
  }
  private setActive(index: number): void {
    if (index >= 0 && index < this.stateData.sessions.length) {
      this.setStateData({ active: index });
      this.updateMemoryStats(); // Update stats for new active session
    }
  }

  private onInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // Limit input based on model-specific token capacity
    const charLimit = this.getCharacterLimit();
    if (value.length > charLimit) {
      spectreLog('⚠️ Input exceeds character limit:', { length: value.length, limit: charLimit });
      return;
    }
    this.setStateData({ input: value });
    this.autoGrow(e.target);
  };
  private onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      spectreLog('⌨️ Enter pressed, calling send()');
      e.preventDefault();
      this.send();
    }
  };

  /**
   * Gets the character limit based on the selected model.
   * Gemini 2.5 Flash: 25,000 tokens × 4 chars/token = 100,000 chars
   * Gemini 2.5 Flash Lite: 16,667 tokens × 4 chars/token = 66,668 chars
   */
  private getCharacterLimit(): number {
    if (this.isFlashModel()) {
      return 100000;
    } else if (this.isFlashLiteModel()) {
      return 66000;
    }
    return 50000;
  }

  /**
   * Gets the RPM (requests per minute) limit based on the selected model.
   */
  private getRpmLimit(): number {
    if (this.isFlashModel()) {
      return 10;
    } else if (this.isFlashLiteModel()) {
      return 15;
    }
    return 10;
  }

  private isFlashModel(): boolean {
    const model = this.getModelName();
    return model.includes('flash') && !model.includes('lite');
  }

  private isFlashLiteModel(): boolean {
    const model = this.getModelName();
    return model.includes('lite');
  }

  private getModelName(): string {
    return (this.prefs['arduino.spectre.model'] || '').toLowerCase();
  }

  /**
   * Sends a message using the new function calling approach (agent mode).
   * Implements ReAct loop: Think → Act → Observe → Repeat
   */
  /**
   * Builds sketch context string from sketch files.
   * Formats each file with path and language-tagged code block.
   */
  private buildSketchContext(
    sketchFiles: Array<{ path: string; content: string }>
  ): string {
    if (sketchFiles.length === 0) {
      return 'No Arduino sketch is currently open in the IDE.';
    }

    return sketchFiles
      .map(
        (file) =>
          `**${file.path}:**\n\`\`\`${this.getFileLanguage(file.path)}\n${
            file.content
          }\n\`\`\``
      )
      .join('\n\n');
  }

  /**
   * Initializes conversation memory and builds conversation history for agent mode.
   * Returns conversation history array with memory context and recent messages.
   */
  private async initializeConversationMemory(
    text: string,
    sketchFiles: Array<{ path: string; content: string }>,
    model: string,
    contextualPrompt: string
  ): Promise<
    Array<{
      role: 'user' | 'model' | 'function';
      text?: string;
      name?: string;
      response?: any;
    }>
  > {
    const conversationHistory: Array<{
      role: 'user' | 'model' | 'function';
      text?: string;
      name?: string;
      response?: any;
    }> = [];

    const session = this.stateData.sessions[this.stateData.active];
    if (!session) {
      conversationHistory.push({ role: 'user', text: contextualPrompt });
      return conversationHistory;
    }

    // Initialize memory if needed
    if (!session.memory) {
      session.memory = this.memoryManager.createConversation(
        session.id.toString()
      );
    }

    // Add current user message to memory
    await this.memoryManager.addMessage(
      session.memory,
      'user',
      contextualPrompt
    );
    this.saveSessionMemory(session.id);
    this.updateMemoryStats();

    // Determine token budget based on model
    const isFlashLite = model === 'gemini-2.5-flash-lite';
    const targetBudget = isFlashLite ? 30_000 : 50_000;

    const sketchContext =
      sketchFiles.length > 0 ? this.buildSketchContext(sketchFiles) : '';

    const { tokenCount } = this.memoryManager.assemblePrompt(session.memory, {
      currentPrompt: text,
      additionalContext: sketchContext,
      targetTokenBudget: targetBudget,
    });

    spectreLog(
      `📊 [Agent Mode] Token usage: ${TokenCounter.formatCount(
        tokenCount.total
      )} ` +
        `(Memory: ${TokenCounter.formatCount(
          tokenCount.breakdown.memoryBank
        )}, ` +
        `Recent: ${TokenCounter.formatCount(
          tokenCount.breakdown.recentMessages
        )}, ` +
        `Current: ${TokenCounter.formatCount(
          tokenCount.breakdown.currentPrompt
        )})`
    );

    // Add memory bank summaries as historical context
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

    // Add recent messages (excluding current one)
    const recentMessages = session.memory.recentMessages.slice(0, -1);
    for (const msg of recentMessages) {
      conversationHistory.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        text: msg.text,
      });
    }

    // Add current user message
    conversationHistory.push({ role: 'user', text: contextualPrompt });

    spectreLog(
      `💬 [Agent Mode] Conversation history: ${conversationHistory.length} messages (${session.memory.memoryBank.summaries.length} summaries, ${recentMessages.length} recent)`
    );

    return conversationHistory;
  }

  /**
   * Creates a loop detector for agent function calling.
   * Returns a detector function and action history array.
   */
  private createLoopDetector(): {
    detectLoop: (
      functionCalls: Array<{ name: string; args: any }>
    ) => { signature: string; functionName: string; args: any } | null;
    actionHistory: Array<{
      signature: string;
      normalizedSignature: string;
      timestamp: number;
      functionName: string;
      args: any;
      result?: { success: boolean; error?: string };
    }>;
  } {
    const actionHistory: Array<{
      signature: string;
      normalizedSignature: string;
      timestamp: number;
      functionName: string;
      args: any;
      result?: { success: boolean; error?: string };
    }> = [];

    const LOOP_DETECTION_WINDOW = 5;
    const MAX_IDENTICAL_ACTIONS = 1;

    const normalizeArgs = (name: string, args: any): any => {
      const normalized: any = {};

      for (const key in args) {
        let value = args[key];

        if (typeof value === 'string') {
          value = value.toLowerCase().trim().replace(/\s+/g, ' ');

          if (name === 'select_board' || name === 'search_boards') {
            value = value.replace(/^arduino\s+/i, '').trim();
          } else if (
            name === 'install_library' ||
            name === 'uninstall_library'
          ) {
            value = value.trim();
          } else if (name === 'select_port') {
            value = value.trim();
          }
        }

        normalized[key] = value;
      }

      return normalized;
    };

    const detectLoop = (
      functionCalls: Array<{ name: string; args: any }>
    ): { signature: string; functionName: string; args: any } | null => {
      const exactSig = functionCalls
        .map((fc) => {
          const sortedArgs = Object.keys(fc.args || {})
            .sort()
            .reduce((acc, key) => {
              acc[key] = fc.args[key];
              return acc;
            }, {} as any);
          return `${fc.name}:${JSON.stringify(sortedArgs)}`;
        })
        .join('|');

      const normalizedSig = functionCalls
        .map((fc) => {
          const normalized = normalizeArgs(fc.name, fc.args || {});
          const sortedArgs = Object.keys(normalized)
            .sort()
            .reduce((acc, key) => {
              acc[key] = normalized[key];
              return acc;
            }, {} as any);
          return `${fc.name}:${JSON.stringify(sortedArgs)}`;
        })
        .join('|');

      const record = {
        signature: exactSig,
        normalizedSignature: normalizedSig,
        timestamp: Date.now(),
        functionName: functionCalls[0]?.name || 'unknown',
        args: functionCalls[0]?.args || {},
      };

      actionHistory.push(record);
      if (actionHistory.length > LOOP_DETECTION_WINDOW) {
        actionHistory.shift();
      }

      // Check repeated failures
      const functionName = functionCalls[0]?.name;
      if (functionName) {
        const recentFailures = actionHistory
          .slice(-5)
          .filter(
            (r) =>
              r.functionName === functionName && r.result?.success === false
          );

        if (recentFailures.length >= 3) {
          spectreWarn(
            `🔴 Loop detected: ${functionName} failed ${recentFailures.length} times`
          );
          return recentFailures[recentFailures.length - 1];
        }
      }

      // Check normalized signature
      const normalizedCounts = new Map<string, number>();
      for (const action of actionHistory) {
        normalizedCounts.set(
          action.normalizedSignature,
          (normalizedCounts.get(action.normalizedSignature) || 0) + 1
        );
      }

      const normalizedCount = normalizedCounts.get(normalizedSig) || 0;
      if (normalizedCount > MAX_IDENTICAL_ACTIONS) {
        spectreWarn(
          `🔴 Loop detected: Normalized signature repeated ${normalizedCount} times`
        );
        return record;
      }

      // Check exact signature
      const exactCounts = new Map<string, number>();
      for (const action of actionHistory) {
        exactCounts.set(
          action.signature,
          (exactCounts.get(action.signature) || 0) + 1
        );
      }

      const exactCount = exactCounts.get(exactSig) || 0;
      if (exactCount > MAX_IDENTICAL_ACTIONS) {
        spectreWarn(
          `🔴 Loop detected: Exact signature repeated ${exactCount} times`
        );
        return record;
      }

      return null;
    };

    return { detectLoop, actionHistory };
  }

  /**
   * Cleans agent response by removing internal markers and redundant content.
   */
  private cleanAgentResponse(
    responseText: string,
    thoughtsTokens?: number
  ): string {
    let cleanText = responseText;

    // Remove agent mode headers
    cleanText = cleanText.replace(/^##?\s*🤖\s*Agent Mode\s*\n*/gim, '');

    // Remove iteration markers
    cleanText = cleanText.replace(
      /^###?\s*🔄\s*Iteration\s+\d+\/\d+\s*\n*/gim,
      ''
    );

    // Remove analyzing messages
    cleanText = cleanText.replace(/^\*Analyzing your request.*?\*\s*\n*/gim, '');

    // Remove redundant code blocks
    cleanText = this.suppressRedundantCodeBlocks(cleanText);

    // Extract tasks to panel
    cleanText = this.extractTasksToPanel(cleanText, responseText);

    // Add thinking badge if available
    if (thoughtsTokens && thoughtsTokens > 0) {
      const thinkingBadge = `*💭 Used ${thoughtsTokens} thinking tokens*\n\n`;
      cleanText = thinkingBadge + cleanText;
    }

    // Remove excessive line breaks and trim
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
    cleanText = cleanText.replace(/^[\s\-]+|[\s\-]+$/g, '');

    return cleanText;
  }

  /**
   * Formats function execution display with icon and label.
   */
  private formatFunctionExecution(
    functionName: string,
    multipleActions: boolean
  ): string {
    const funcIcon = this.getFunctionIcon(functionName);
    const funcLabel = this.getFunctionLabel(functionName);
    const prefix = multipleActions ? '' : '\n';
    return `${prefix}${funcIcon} ${funcLabel}...`;
  }

  /**
   * Builds the prompt for current agent iteration.
   * First iteration uses original request, subsequent use continuation instruction.
   */
  private buildIterationPrompt(iteration: number, originalText: string): string {
    return iteration === 1
      ? originalText
      : 'Continue with the next step based on the function results above. If all tasks are complete, respond with confirmation and no function calls.';
  }

  /**
   * Handles loop detection and displays warning message.
   * Returns true if loop was detected.
   */
  private handleLoopDetection(
    loopDetected: { signature: string; functionName: string; args: any } | null,
    requestSeq: number
  ): boolean {
    if (!loopDetected) return false;

    const prettyArgs = JSON.stringify(loopDetected.args, null, 2);
    spectreError(`🔴 Infinite loop detected: ${loopDetected.signature}`);

    this.mutateLastAssistant(
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
        `**Action Taken:** Stopped after 2 identical attempts to prevent wasted API calls.\n\n` +
        `**Recommendation:** Rephrase your request or manually perform the action.\n`,
      requestSeq
    );
    return true;
  }

  /**
   * Executes a single function call and displays result.
   * Updates action history with result for loop detection.
   */
  private async executeSingleFunction(
    functionCall: { name: string; args: any },
    actionHistory: Array<{
      signature: string;
      normalizedSignature: string;
      timestamp: number;
      functionName: string;
      args: any;
      result?: { success: boolean; error?: string };
    }>,
    conversationHistory: Array<{
      role: 'user' | 'model' | 'function';
      text?: string;
      name?: string;
      response?: any;
    }>,
    requestSeq: number
  ): Promise<boolean> {
    const result = await this.executeWithErrorHandling(functionCall);
    this.updateActionHistory(actionHistory, functionCall.name, result);
    this.displayExecutionResult(result, requestSeq);
    this.addToConversationHistory(conversationHistory, functionCall.name, result);
    return result.success;
  }

  private async executeWithErrorHandling(
    functionCall: { name: string; args: any }
  ): Promise<{ success: boolean; result?: string; error?: string }> {
    try {
      return await this.executeFunctionCall(functionCall);
    } catch (funcError) {
      spectreError(`Function ${functionCall.name} threw error:`, funcError);
      return {
        success: false,
        error: funcError instanceof Error ? funcError.message : String(funcError),
      };
    }
  }

  private updateActionHistory(
    actionHistory: Array<{ functionName: string; result?: any }>,
    functionName: string,
    result: any
  ): void {
    const lastAction = actionHistory[actionHistory.length - 1];
    if (lastAction && lastAction.functionName === functionName) {
      lastAction.result = result;
    }
  }

  private displayExecutionResult(
    result: { success: boolean; error?: string },
    requestSeq: number
  ): void {
    if (result.success) {
      this.mutateLastAssistant((prev) => prev + ' ✓\n', requestSeq);
    } else {
      const errorMsg = result.error || 'Unknown error';
      const shortError = errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg;
      this.mutateLastAssistant((prev) => prev + ` ✗ (${shortError})\n`, requestSeq);
    }
  }

  private addToConversationHistory(
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

  /**
   * Processes function calls from AI response.
   * Handles loop detection, execution display, and function invocation.
   * Returns true if loop was detected (should stop).
   */
  private async processFunctionCalls(
    params: ProcessFunctionCallsParams
  ): Promise<boolean> {
    const { functionCalls, detectLoop, actionHistory, conversationHistory, requestSeq } = params;

    spectreLog(
      `🔧 Agent wants to call ${functionCalls.length} function(s):`,
      functionCalls.map((fc) => fc.name)
    );

    if (this.handleLoopDetection(detectLoop(functionCalls), requestSeq)) {
      return true;
    }

    await this.executeFunctionCallsSequence(
      functionCalls,
      actionHistory,
      conversationHistory,
      requestSeq
    );

    return false;
  }

  private async executeFunctionCallsSequence(
    functionCalls: Array<{ name: string; args: any }>,
    actionHistory: any[],
    conversationHistory: any[],
    requestSeq: number
  ): Promise<void> {
    const multipleActions = functionCalls.length > 1;
    
    if (multipleActions) {
      this.showMultipleActionsHeader(functionCalls.length, requestSeq);
    }

    for (let i = 0; i < functionCalls.length; i++) {
      if (requestSeq !== this.stateData.requestSeq) {
        return;
      }

      const functionCall = functionCalls[i];
      this.showFunctionExecution(functionCall.name, multipleActions, requestSeq);
      
      await this.executeSingleFunction(
        functionCall,
        actionHistory,
        conversationHistory,
        requestSeq
      );
    }
  }

  private showMultipleActionsHeader(count: number, requestSeq: number): void {
    const functionSection = `\n**Executing ${count} actions...**\n\n`;
    this.mutateLastAssistant((prev) => {
      const separator = prev.trim() ? '\n\n' : '';
      return prev + separator + functionSection;
    }, requestSeq);
  }

  private showFunctionExecution(functionName: string, multipleActions: boolean, requestSeq: number): void {
    const functionDisplay = this.formatFunctionExecution(functionName, multipleActions);
    this.mutateLastAssistant((prev) => {
      const separator = prev.trim() && !prev.endsWith('\n\n') ? '\n' : '';
      return prev + separator + functionDisplay;
    }, requestSeq);
  }

  /**
   * Handles agent completion - marks tasks complete and shows completion message.
   */
  private handleAgentCompletion(
    iteration: number,
    actionHistory: Array<{ result?: { success: boolean } }>,
    responseText: string | undefined,
    requestSeq: number
  ): void {
    spectreLog('✅ Agent completed task - no more function calls needed');

    if (this.taskCompletedSuccessfully(responseText, actionHistory)) {
      spectreLog('✅ AI provided completion message after successful actions - task is complete');
    }

    this.markAllTasksCompleted();
    this.displayCompletionMessage(iteration, requestSeq);
  }

  private taskCompletedSuccessfully(
    responseText: string | undefined,
    actionHistory: Array<{ result?: { success: boolean } }>
  ): boolean {
    const hasCompletionIndicators = this.hasCompletionKeywords(responseText);
    const hadSuccessfulActions = actionHistory.some(
      (action) => action.result?.success === true
    );
    return hasCompletionIndicators && hadSuccessfulActions;
  }

  private hasCompletionKeywords(responseText: string | undefined): boolean {
    if (!responseText) return false;

    const text = responseText.toLowerCase();
    const keywords = ['created', 'completed', 'done', 'ready', 'finished'];
    return keywords.some(keyword => text.includes(keyword));
  }

  private markAllTasksCompleted(): void {
    const currentTasks = this.stateData.tasks || [];
    if (currentTasks.length > 0) {
      const completedTasks = currentTasks.map((task) => ({
        ...task,
        status: 'completed' as const,
      }));
      this.setStateData({ tasks: completedTasks });
    }
  }

  private displayCompletionMessage(iteration: number, requestSeq: number): void {
    this.mutateLastAssistant(
      (prev) =>
        prev +
        `\n\n---\n\n### ✅ Task Completed\n\nCompleted in **${iteration}** iteration${
          iteration > 1 ? 's' : ''
        }.\n`,
      requestSeq
    );
  }

  private async sendMessageWithFunctionCalling(
    params: FunctionCallingParams
  ): Promise<void> {
    const { text, requestSeq, abortKey, model, sketchFiles } = params;
    const MAX_ITERATIONS = 10;

    const context = await this.setupReActLoop(text, sketchFiles, model, requestSeq);
    let agentError: any = null;

    try {
      const result = await this.executeReActLoop({
        text,
        requestSeq,
        abortKey,
        model,
        context,
        maxIterations: MAX_ITERATIONS,
      });
      agentError = result.error;
    } catch (outerError: any) {
      spectreError('Agent mode outer error:', outerError);
      this.mutateLastAssistant(
        (prev) => prev + `\n\n❌ **Error:** ${outerError.message || String(outerError)}\n`,
        requestSeq
      );
      agentError = outerError;
    } finally {
      this.finalizeAgent(agentError);
    }
  }

  private async setupReActLoop(
    text: string,
    sketchFiles: any[] | undefined,
    model: string | undefined,
    requestSeq: number
  ): Promise<{
    conversationHistory: Array<any>;
    detectLoop: (functionCalls: Array<{ name: string; args: any }>) => any;
    actionHistory: Array<any>;
    contextualPrompt: string;
  }> {
    const files = sketchFiles || [];
    const sketchContext = this.buildSketchContext(files);
    const contextualPrompt = `Here are my current Arduino sketch files:\n\n${sketchContext}\n\n**User request:** ${text}`;

    const conversationHistory = await this.initializeConversationMemory(
      text,
      files,
      model || 'gemini-2.0-flash-exp',
      contextualPrompt
    );

    await this.appendAssistant('', requestSeq);
    const { detectLoop, actionHistory } = this.createLoopDetector();

    return { conversationHistory, detectLoop, actionHistory, contextualPrompt };
  }

  private async executeReActLoop(params: {
    text: string;
    requestSeq: number;
    abortKey: string | undefined;
    model: string | undefined;
    context: {
      conversationHistory: Array<any>;
      detectLoop: (functionCalls: Array<{ name: string; args: any }>) => any;
      actionHistory: Array<any>;
    };
    maxIterations: number;
  }): Promise<{ error: any | null }> {
    const { text, requestSeq, abortKey, model, context, maxIterations } = params;
    const { conversationHistory, detectLoop, actionHistory } = context;
    let iteration = 0;
    let capturedError: any = null;

    while (iteration < maxIterations) {
      iteration++;
      spectreLog(`🤖 Agent Iteration ${iteration}/${maxIterations} starting...`);

      if (requestSeq !== this.stateData.requestSeq) {
        spectreLog('🤖 Agent loop canceled by user');
        break;
      }

      try {
        const shouldStop = await this.executeReActIteration({
          iteration,
          text,
          requestSeq,
          abortKey,
          model,
          conversationHistory,
          detectLoop,
          actionHistory,
        });

        if (shouldStop) break;
      } catch (iterationError) {
        this.handleIterationError(iteration, iterationError, requestSeq);
        capturedError = iterationError;
        break;
      }
    }

    if (iteration >= maxIterations) {
      this.displayMaxIterationsWarning(maxIterations, requestSeq);
    }

    return { error: capturedError };
  }

  private async executeReActIteration(params: {
    iteration: number;
    text: string;
    requestSeq: number;
    abortKey: string | undefined;
    model: string | undefined;
    conversationHistory: Array<any>;
    detectLoop: (functionCalls: Array<{ name: string; args: any }>) => any;
    actionHistory: Array<any>;
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
    } = params;

    const currentPrompt = this.buildIterationPrompt(iteration, text);
    const response = await this.ai.generate({
      prompt: currentPrompt,
      model: model as any,
      enableAgentMode: true,
      context: {
        conversation: conversationHistory.map((m) => {
          if (m.role === 'function') {
            return {
              role: 'function' as const,
              parts: [{ functionResponse: { name: m.name!, response: m.response } }],
            };
          }
          return { role: m.role as 'user' | 'model', text: m.text || '' };
        }) as any,
      },
      generationConfig: { maxOutputTokens: 65536, topP: 0.9 },
      abortKey,
    });

    this.addResponseToHistory(response, conversationHistory, requestSeq);

    if (this.requiresFunctionCalling(response)) {
      return await this.processFunctionCalls({
        functionCalls: response.functionCalls!,
        detectLoop,
        actionHistory,
        conversationHistory,
        requestSeq,
      });
    }

    this.handleAgentCompletion(iteration, actionHistory, response.text, requestSeq);
    return true;
  }

  private addResponseToHistory(
    response: any,
    conversationHistory: Array<any>,
    requestSeq: number
  ): void {
    if (response.text) {
      conversationHistory.push({ role: 'model', text: response.text });
      const cleanText = this.cleanAgentResponse(response.text, response.meta?.thoughtsTokens);
      if (cleanText.trim()) {
        this.mutateLastAssistant((prev) => {
          const separator = prev.trim() ? '\n\n' : '';
          return prev + separator + cleanText;
        }, requestSeq);
      }
    }
  }

  private handleIterationError(
    iteration: number,
    error: any,
    requestSeq: number
  ): void {
    spectreError(`Agent iteration ${iteration} error:`, error);
    this.mutateLastAssistant(
      (prev) =>
        prev +
        `\n\n⚠️ **Error in iteration ${iteration}:** ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      requestSeq
    );
  }

  private displayMaxIterationsWarning(maxIterations: number, requestSeq: number): void {
    this.mutateLastAssistant(
      (prev) =>
        prev +
        `\n\n---\n\n### ⚠️ Maximum Iterations Reached\n\nStopped after **${maxIterations}** iterations for safety.\n`,
      requestSeq
    );
  }

  private finalizeAgent(agentError: any): void {
    try {
      this.setStateData({
        busy: false,
        currentAbortKey: undefined,
        error: agentError ? agentError.message || String(agentError) : undefined,
      });
      this.persist();
      this.deferScroll();
    } catch (cleanupError) {
      spectreError('Agent cleanup error:', cleanupError);
      try {
        this.setStateData({ busy: false, currentAbortKey: undefined });
      } catch {
        spectreError('Critical: Failed to reset busy state');
      }
    }
  }

  /**
   * Checks if result indicates success (no error marker).
   */
  private isSuccessResult(result: string): boolean {
    return !result.includes('❌');
  }

  /**
   * Executes sketch-related functions.
   */
  private async executeSketchFunction(
    name: string,
    args: Record<string, any>
  ): Promise<{ success: boolean; result?: string } | null> {
    let result: string;

    switch (name) {
      case 'create_sketch':
        result = await this.agentCreateSketch(args.name, args.code);
        return { success: true, result };

      case 'read_sketch':
        result = await this.agentReadSketch();
        return { success: true, result };

      case 'verify_sketch':
        result = await this.agentVerifySketch();
        return { success: true, result };

      case 'upload_sketch':
        result = await this.agentUploadSketch();
        return { success: true, result };

      default:
        return null;
    }
  }

  /**
   * Executes board-related functions.
   */
  private async executeBoardFunction(
    name: string,
    args: Record<string, any>
  ): Promise<{ success: boolean; result?: string } | null> {
    const boardFunctions: { [key: string]: () => Promise<string> } = {
      get_boards: () => this.agentGetBoardsList(),
      select_board: () => this.agentSelectBoard(args.name),
      search_boards: () => this.agentSearchBoards(args.query),
      install_board: () => this.agentInstallBoard(args.platform, args.version),
      uninstall_board: () => this.agentUninstallBoard(args.platform),
      add_board_url: () => this.agentAddBoardUrl(args.url),
      remove_board_url: () => this.agentRemoveBoardUrl(args.url),
      fetch_board_urls: () => this.agentFetchBoardUrls(args.query),
      get_board_config: () => this.agentGetBoardConfig(args.fqbn),
      set_board_config: () => this.agentSetBoardConfig(args.fqbn, args.options),
    };

    const fn = boardFunctions[name];
    if (!fn) {
      return null;
    }

    const result = await fn();
    return { success: this.isSuccessResult(result), result };
  }

  /**
   * Executes port and library-related functions.
   */
  private async executePortAndLibraryFunction(
    name: string,
    args: Record<string, any>
  ): Promise<{ success: boolean; result?: string } | null> {
    let result: string;

    switch (name) {
      case 'get_ports':
        result = await this.agentGetPortsList();
        return { success: this.isSuccessResult(result), result };

      case 'select_port':
        result = await this.agentSelectPort(args.address);
        return { success: this.isSuccessResult(result), result };

      case 'install_library':
        result = await this.agentInstallLibrary(args.name);
        return { success: this.isSuccessResult(result), result };

      case 'uninstall_library':
        result = await this.agentUninstallLibrary(args.name);
        return { success: this.isSuccessResult(result), result };

      default:
        return null;
    }
  }

  /**
   * Executes a function call from the AI agent by routing to the appropriate agent method.
   */
  private async executeFunctionCall(functionCall: {
    name: string;
    args: Record<string, any>;
  }): Promise<{ success: boolean; result?: string; error?: string }> {
    const { name, args } = functionCall;

    try {
      // Try sketch functions
      const sketchResult = await this.executeSketchFunction(name, args);
      if (sketchResult) return sketchResult;

      // Try board functions
      const boardResult = await this.executeBoardFunction(name, args);
      if (boardResult) return boardResult;

      // Try port and library functions
      const portLibResult = await this.executePortAndLibraryFunction(name, args);
      if (portLibResult) return portLibResult;

      // Unknown function
      return {
        success: false,
        error: `Unknown function: ${name}`,
      };
    } catch (error: any) {
      spectreError(`Function execution failed: ${name}`, error);
      return {
        success: false,
        error: error?.message || String(error),
      };
    }
  }

  /**
   * Sends a message to the AI service with optional sketch file context.
   * Handles validation, rate limiting, and error recovery.
   */
  /**
   * Validates input and prepares message state.
   * Returns prepared data or null if validation fails.
   */
  private async validateAndPrepareMessage(): Promise<{
    text: string;
    requestSeq: number;
    abortKey: string;
    model: string;
    sessions: ChatSession[];
  } | null> {
    const text = this.stateData.input.trim();
    spectreLog('📝 validateAndPrepareMessage:', { textLength: text.length, busy: this.stateData.busy, sending: this.sending });
    
    if (!this.canSendMessage(text, this.stateData.busy, this.sending)) {
      spectreLog('⚠️ canSendMessage returned false:', { text: !!text, busy: this.stateData.busy, sending: this.sending });
      return null;
    }

    const charLimit = this.getCharacterLimit();
    if (text.length > charLimit) {
      spectreLog('⚠️ Message too long:', { length: text.length, limit: charLimit });
      this.setStateData({
        error: `Message too long. Please limit to ${charLimit.toLocaleString()} characters for ${
          this.prefs['arduino.spectre.model']
        }.`,
      });
      return null;
    }

    const now = Date.now();
    if (now - this.lastSendAt < 350) {
      spectreLog('⚠️ Debounce triggered:', { now, lastSendAt: this.lastSendAt, diff: now - this.lastSendAt });
      return null;
    }
    this.lastSendAt = now;

    const sessions = this.stateData.sessions.slice();
    const current = sessions[this.stateData.active];

    // Initialize memory if needed
    if (!current.memory) {
      current.memory = this.memoryManager.createConversation(
        current.id.toString()
      );
    }

    await this.memoryManager.addMessage(current.memory, 'user', text);
    this.saveSessionMemory(current.id);

    // Sync to messages array for UI
    sessions[this.stateData.active] = {
      ...current,
      messages: [
        ...current.messages,
        { id: `msg-${Date.now()}-user`, role: 'user', text },
      ],
    };

    const requestSeq = this.stateData.requestSeq + 1;
    const model = this.prefs['arduino.spectre.model'];
    const abortKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.setStateData({
      sessions,
      input: '',
      busy: true,
      error: undefined,
      requestSeq,
      currentAbortKey: abortKey,
    });

    this.updateMemoryStats();
    this.persist();
    this.deferScroll();

    return { text, requestSeq, abortKey, model, sessions };
  }

  /**
   * Builds context prompt for basic mode.
   */
  private buildBasicModeContext(
    text: string,
    sketchFiles: Array<{ path: string; content: string }>
  ): string {
    if (sketchFiles.length === 0) {
      return text;
    }
    return `I have an Arduino sketch open.\n\n**User question:** ${text}`;
  }

  /**
   * Builds conversation history from memory system.
   */
  private buildConversationHistory(
    session: ChatSession | undefined,
    text: string,
    sketchFiles: Array<{ path: string; content: string }>,
    model: string
  ): Array<{ role: 'user' | 'model'; text: string }> {
    const conversationHistory: Array<{ role: 'user' | 'model'; text: string }> =
      [];

    if (!session?.memory) {
      return conversationHistory;
    }

    const isFlashLite = model === 'gemini-2.5-flash-lite';
    const targetBudget = isFlashLite ? 30_000 : 50_000;

    const sketchContext =
      sketchFiles.length > 0 ? this.buildSketchContext(sketchFiles) : '';

    const { tokenCount } = this.memoryManager.assemblePrompt(session.memory, {
      currentPrompt: text,
      additionalContext: sketchContext,
      targetTokenBudget: targetBudget,
    });

    spectreLog(
      `📊 Token usage: ${TokenCounter.formatCount(
        tokenCount.total
      )} (Memory: ${TokenCounter.formatCount(
        tokenCount.breakdown.memoryBank
      )}, Recent: ${TokenCounter.formatCount(
        tokenCount.breakdown.recentMessages
      )}, Current: ${TokenCounter.formatCount(
        tokenCount.breakdown.currentPrompt
      )})`
    );

    // Add memory bank summaries as context
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

    // Add recent messages
    for (const msg of session.memory.recentMessages) {
      conversationHistory.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        text: msg.text,
      });
    }

    spectreLog(
      `💬 Conversation history: ${conversationHistory.length} messages (${session.memory.memoryBank.summaries.length} summaries, ${session.memory.recentMessages.length} recent)`
    );

    return conversationHistory;
  }

  /**
   * Creates AI generation configuration.
   */
  private createGenerationConfig(
    contextualPrompt: string,
    model: string,
    abortKey: string,
    conversationHistory: Array<{ role: 'user' | 'model'; text: string }>
  ) {
    return {
      prompt: contextualPrompt,
      model: model as any,
      generationConfig: this.getModelGenerationConfig(),
      includeThoughts: this.shouldIncludeThoughts(model),
      abortKey,
      thinkingBudget: -1,
      enableGoogleSearch: true,
      context: this.buildConversationContext(conversationHistory),
    };
  }

  private getModelGenerationConfig() {
    return {
      maxOutputTokens: 65536,
      topP: 0.9,
    };
  }

  private shouldIncludeThoughts(model: string): boolean {
    return model === 'gemini-2.5-flash-lite';
  }

  private buildConversationContext(conversationHistory: Array<{ role: 'user' | 'model'; text: string }>) {
    return {
      conversation: conversationHistory.length > 0 ? conversationHistory : undefined,
    };
  }

  /**
   * Handles successful AI generation response.
   */
  private async handleGenerationSuccess(
    params: GenerationSuccessParams
  ): Promise<void> {
    const { res, requestSeq, abortKey, text, model, estTokens, current } = params;
    if (requestSeq !== this.stateData.requestSeq) {
      return;
    }

    const actualTokensUsed = res.meta?.totalTokens || estTokens;
    this.logRequest(actualTokensUsed, model, true);

    if (this.currentAbortKey === abortKey) {
      this.setStateData({ busy: false, currentAbortKey: undefined });
      if (res.text && !this.streamStarted) {
        this.mutateLastAssistant(() => res.text, requestSeq);
      }
    }

    const after = this.stateData.sessions.slice();
    const cur = after[this.stateData.active];
    const shouldUpdateTitle =
      current.messages.length === 1 || cur.title === 'New Chat';
    const newTitle = shouldUpdateTitle ? autoTitle(text) : cur.title;
    after[this.stateData.active] = { ...cur, title: newTitle };
    this.setStateData({ sessions: after });

    this.persist();
    this.deferScroll();
  }

  /**
   * Handles AI generation error with classification and retry logic.
   */
  private handleGenerationError(
    err: any,
    requestSeq: number,
    model: string,
    estTokens: number
  ): void {
    spectreError('Spectre AI generation failed:', err.message || err);

    if (requestSeq !== this.stateData.requestSeq) {
      return;
    }

    this.logRequest(estTokens, model, false);

    const { errorMessage, shouldRetry } = this.classifyError(err);
    this.displayErrorMessage(errorMessage, shouldRetry);
  }

  private classifyError(err: any): { errorMessage: string; shouldRetry: boolean } {
    if (!err?.message) {
      return { errorMessage: 'An error occurred while generating response.', shouldRetry: false };
    }

    const msg = err.message.toLowerCase();

    if (this.isNetworkError(err.message)) {
      return { errorMessage: 'Network error. Please check your connection and try again.', shouldRetry: true };
    }

    if (msg.includes('api key') || msg.includes('authentication')) {
      return { errorMessage: 'API key error. Please check your Spectre settings.', shouldRetry: false };
    }

    if (msg.includes('quota') || msg.includes('limit')) {
      return { errorMessage: 'API quota exceeded. Please wait before sending another message.', shouldRetry: true };
    }

    if (msg.includes('timeout')) {
      return { errorMessage: 'Request timed out. Please try again.', shouldRetry: true };
    }

    return { errorMessage: err.message, shouldRetry: false };
  }

  private displayErrorMessage(errorMessage: string, shouldRetry: boolean): void {
    const sessions = this.stateData.sessions.slice();
    const current = sessions[this.stateData.active];
    const messages = [
      ...current.messages,
      {
        id: `msg-${Date.now()}-assistant-error`,
        role: 'assistant' as const,
        text: `❌ **Error:** ${errorMessage}${
          shouldRetry ? '\n\n*Click the send button to retry.*' : ''
        }`,
      },
    ];
    sessions[this.stateData.active] = { ...current, messages };

    this.setStateData({
      sessions,
      busy: false,
      error: errorMessage,
      currentAbortKey: undefined,
      retryable: shouldRetry,
    });
    this.deferScroll();
  }

  async send(): Promise<void> {
    spectreLog('🚀 send() called');

    try {
      const prepared = await this.validateAndPrepareMessage();
      if (!prepared) {
        spectreLog('⚠️ validateAndPrepareMessage returned null');
        return;
      }

      // Set sending flag AFTER validation succeeds
      this.sending = true;

      const { text, requestSeq, abortKey, model, sessions } = prepared;
      spectreLog('📤 Sending message:', { text: text.substring(0, 50), requestSeq, model });
      const current = sessions[this.stateData.active];

      // Collect current sketch files for context (both basic and agent modes need this)
      const sketchFiles = await this.getCurrentSketchFiles();

      const agentMode = this.prefs['arduino.spectre.mode'] === 'agent';
      spectreLog('🤖 Agent mode:', agentMode);

      // Use new function calling approach for agent mode
      if (agentMode) {
        await this.sendMessageWithFunctionCalling({
          text,
          requestSeq,
          abortKey,
          model,
          sketchFiles,
        });
        return; // finally block will reset this.sending
      }

      // Basic mode: Create empty assistant message and attach stream listener
      this.appendAssistant('', requestSeq);
      this.attachStreamListener(abortKey, requestSeq);

      // Build context prompt
      const contextualPrompt = this.buildBasicModeContext(text, sketchFiles);

      // Build conversation history from memory system
      const session = this.stateData.sessions[this.stateData.active];
      const conversationHistory = this.buildConversationHistory(
        session,
        text,
        sketchFiles,
        model
      );

      // Calculate token estimate
      const estTokens = conversationHistory.reduce(
        (sum, msg) => sum + TokenCounter.fastEstimate(msg.text),
        TokenCounter.fastEstimate(contextualPrompt)
      );

      const genConfig = this.createGenerationConfig(
        contextualPrompt,
        model,
        abortKey,
        conversationHistory
      );

      this.ai
        .generate(genConfig)
        .then((res) =>
          this.handleGenerationSuccess({
            res,
            requestSeq,
            abortKey,
            text,
            model,
            estTokens,
            current,
          })
        )
        .catch((err) =>
          this.handleGenerationError(err, requestSeq, model, estTokens)
        );
    } catch (err: unknown) {
      // Handle any errors in the send flow
      spectreError('❌ Error in send():', err);
      this.setStateData({
        busy: false,
        error: `Error: ${this.getErrorMessage(err)}`,
      });
    } finally {
      this.sending = false;
    }
  }

  private startStreamTicker(requestSeq?: number): void {
    if (this.streamTicker) return;
    const seq = requestSeq ?? this.currentRequestSeq;
    if (seq === undefined) return;
    const TICK_MS = 25;
    this.streamTicker = window.setInterval(() => {
      if (this.shouldAbortStream(seq)) {
        this.stopStreamTicker();
        return;
      }
      if (this.streamBuffer.length > 0) {
        const step = this.calculateChunkSize(this.streamBuffer.length);
        const take = this.streamBuffer.slice(0, step);
        this.streamBuffer = this.streamBuffer.slice(step);
        this.mutateLastAssistant((prev) => prev + take, seq);
      } else if (this.streamDone) {
        this.flushStreamBuffer(seq);
      }
    }, TICK_MS);
  }

  private shouldAbortStream(seq: number): boolean {
    return seq !== this.currentRequestSeq || !this.currentAbortKey;
  }

  private calculateChunkSize(bufferLength: number): number {
    if (bufferLength > 1000) return 120;
    if (bufferLength > 500) return 80;
    if (bufferLength > 150) return 40;
    return 24;
  }

  private flushStreamBuffer(seq: number): void {
    this.stopStreamTicker();
    this.setStateData({ busy: false, currentAbortKey: undefined });
    this.focusInput();
  }

  private stopStreamTicker(): void {
    if (this.streamTicker) {
      clearInterval(this.streamTicker);
      this.streamTicker = undefined;
    }
    // Cancel fallback timeout to prevent memory leak
    if (this.streamFallbackTimer) {
      clearTimeout(this.streamFallbackTimer);
      this.streamFallbackTimer = undefined;
    }
    this.streamBuffer = '';
    this.streamDone = false;
    this.streamStarted = false;
  }

  private attachStreamListener(streamKey: string, requestSeq: number): void {
    // Reset any previous streaming animation state (clears buffer, timers, and flags)
    this.stopStreamTicker();

    // Store the current stream key and request sequence for onStream callback
    this.currentAbortKey = streamKey;
    this.currentRequestSeq = requestSeq;
  }

  /**
   * Appends an assistant message to the conversation.
   * Also adds to memory system for long-term retention.
   */
  private async appendAssistant(
    text: string,
    requestSeq: number
  ): Promise<void> {
    if (requestSeq !== this.stateData.requestSeq) return;

    const sessions = this.stateData.sessions.slice();
    const cur = sessions[this.stateData.active];

    // Add to messages array for UI
    sessions[this.stateData.active] = {
      ...cur,
      messages: [
        ...cur.messages,
        { id: `msg-${Date.now()}-assistant`, role: 'assistant', text },
      ],
    };

    // Add to memory system (only if text is not empty - empty is placeholder)
    if (text.trim() !== '' && cur.memory) {
      await this.memoryManager.addMessage(cur.memory, 'assistant', text);
      this.saveSessionMemory(cur.id); // Persist memory after adding assistant response
      this.updateMemoryStats();
    }

    this.setStateData({ sessions });
    this.persist();
    this.deferScroll();
  }

  private async mutateLastAssistant(
    mutator: (text: string) => string,
    requestSeq: number
  ): Promise<void> {
    // Double-check request sequence to prevent race conditions
    if (requestSeq !== this.stateData.requestSeq) return;

    const sessions = this.stateData.sessions.slice();
    const cur = sessions[this.stateData.active];
    const msgs = cur.messages.slice();
    const last = msgs[msgs.length - 1];

    if (last && last.role === 'assistant') {
      const newText = mutator(last.text);
      msgs[msgs.length - 1] = { id: last.id, role: 'assistant', text: newText };
      sessions[this.stateData.active] = { ...cur, messages: msgs };

      // Update memory system if text changed and is not empty
      if (this.shouldUpdateMemory(newText, last.text, cur.memory)) {
        // Find and update the corresponding message in memory
        const memoryMsg =
          cur.memory!.recentMessages[cur.memory!.recentMessages.length - 1];
        if (memoryMsg && memoryMsg.role === 'assistant') {
          memoryMsg.text = newText;
          memoryMsg.estimatedTokens = TokenCounter.estimate(newText, 'natural');
        }
      }

      this.setStateData({ sessions });
      this.persist();
      this.deferScroll();
    }
  }

  private cancel(): void {
    const key = this.stateData.currentAbortKey;
    const newSeq = this.stateData.requestSeq + 1;
    this.setStateData({
      busy: false,
      requestSeq: newSeq,
      currentAbortKey: undefined,
    });
    this.sending = false;
    this.stopStreamTicker();
    if (key) this.ai.cancel(key).catch(() => {});
    // Auto-focus input after stopping generation
    this.focusInput();
  }

  // Task rendering methods for GitHub Copilot-style workflow

  /**
   * Parses markdown checkboxes from AI response and extracts tasks.
   * Supports formats:
   * - [ ] Pending task
   * - [x] Completed task
   * - [o] In-progress task (or ⏳)
   */
  private parseTasksFromResponse(text: string): AgentTask[] {
    const tasks: AgentTask[] = [];
    const lines = text.split('\n');
    let taskId = 1;

    for (const line of lines) {
      // Match markdown checkbox patterns: - [ ], - [x], - [X], - [o], etc.
      const checkboxMatch = line.match(/^\s*[-*]\s*\[([^\]]*)\]\s*(.+)/);

      if (checkboxMatch) {
        const checkbox = checkboxMatch[1].toLowerCase().trim();
        const description = checkboxMatch[2].trim();

        // Determine status from checkbox character
        let status: 'pending' | 'in-progress' | 'completed' | 'failed' =
          'pending';

        if (this.isCompletedCheckbox(checkbox)) {
          status = 'completed';
        } else if (this.isInProgressCheckbox(checkbox)) {
          status = 'in-progress';
        } else if (this.isFailedCheckbox(checkbox, description)) {
          status = 'failed';
        }

        tasks.push({
          id: `task-${taskId++}`,
          description,
          status,
          actionType: 'task', // Generic action type for parsed tasks
        });
      }
    }

    return tasks;
  }

  /**
   * Updates the task list by parsing the latest AI response.
   * Call this after receiving an AI response in agent mode.
   */
  private updateTasksFromResponse(responseText: string): void {
    const parsedTasks = this.parseTasksFromResponse(responseText);

    if (parsedTasks.length > 0) {
      // Replace existing tasks with newly parsed ones
      this.setStateData({
        tasks: parsedTasks,
        tasksExpanded: false, // Start minimized - user can click to expand
        tasksClosed: false, // Make sure it's not closed
      });
    }
  }

  /**
   * Extracts task list from message, updates panel, returns clean text.
   * Tasks go in panel, not message for cleaner conversation display.
   */
  private extractTasksToPanel(
    messageText: string,
    originalText: string
  ): string {
    // Parse and update task panel
    this.updateTasksFromResponse(originalText);

    // Remove task list from message text (GitHub Copilot style)
    // Task lists are in the format:
    // - [ ] Task 1
    // - [x] Task 2
    // - [o] Task 3
    let cleanText = messageText;

    // Remove the entire task list section
    // Match: optional header + task list + optional trailing newlines
    cleanText = cleanText.replace(
      /(?:Here's the plan:|Plan:|Tasks?:)?\s*\n(?:- \[[xo ]\] [^\n]+\n?)+/gim,
      ''
    );

    // Also remove standalone task lines scattered in text
    cleanText = cleanText.replace(/^- \[[xo ]\] [^\n]+\n?/gim, '');

    return cleanText;
  }

  /**
   * Suppress large code blocks from agent responses.
   * Users see code in editor - only keep small snippets for examples.
   * Limit: 15 lines or less for teaching/explanations.
   */
  private suppressRedundantCodeBlocks(text: string): string {
    // Match code blocks with cpp/arduino/c/ino language tags
    const codeBlockRegex = /```(?:cpp|c|arduino|ino)\n([\s\S]*?)\n```/gi;

    return text.replace(codeBlockRegex, (match, code) => {
      const lines = code.trim().split('\n');
      const lineCount = lines.length;

      // Keep small snippets (teaching/examples) - these are helpful
      if (lineCount <= 15) {
        return match; // Keep original code block
      }

      // Replace large code blocks with summary (agent just updated the sketch)
      // Check if it looks like a complete sketch (has setup/loop)
      const hasSetup = /void\s+setup\s*\(\s*\)/i.test(code);
      const hasLoop = /void\s+loop\s*\(\s*\)/i.test(code);

      if (hasSetup && hasLoop) {
        return `\n*✅ Updated sketch in editor (${lineCount} lines)*\n`;
      }

      // Generic large code block
      return `\n*✅ Updated code in editor (${lineCount} lines)*\n`;
    });
  }

  /**
   * Gets a friendly icon for a function name.
   * Makes the UI more visual and easier to scan.
   */
  private getFunctionIcon(functionName: string): string {
    const iconMap: Record<string, string> = {
      create_sketch: '✏️',
      read_sketch: '📖',
      verify_sketch: '🔍',
      upload_sketch: '⬆️',
      get_boards: '🔌',
      select_board: '📟',
      search_boards: '🔎',
      install_board: '📥',
      uninstall_board: '🗑️',
      get_board_config: '⚙️',
      set_board_config: '🔧',
      add_board_url: '🔗',
      remove_board_url: '❌',
      fetch_board_urls: '📋',
      get_ports: '🔌',
      select_port: '🔌',
      install_library: '📚',
      uninstall_library: '🗑️',
    };
    return iconMap[functionName] || '⚡';
  }

  /**
   * Gets a friendly label for a function name.
   * Makes technical function names human-readable.
   */
  private getFunctionLabel(functionName: string): string {
    const labelMap: Record<string, string> = {
      create_sketch: 'Updating sketch',
      read_sketch: 'Reading sketch',
      verify_sketch: 'Verifying code',
      upload_sketch: 'Uploading to board',
      get_boards: 'Getting boards',
      select_board: 'Selecting board',
      search_boards: 'Searching boards',
      install_board: 'Installing board',
      uninstall_board: 'Removing board',
      get_board_config: 'Reading board config',
      set_board_config: 'Updating board config',
      add_board_url: 'Adding board URL',
      remove_board_url: 'Removing board URL',
      fetch_board_urls: 'Getting board URLs',
      get_ports: 'Getting ports',
      select_port: 'Selecting port',
      install_library: 'Installing library',
      uninstall_library: 'Removing library',
    };
    return labelMap[functionName] || functionName.replace(/_/g, ' ');
  }

  /**
   * Checks if task list should be hidden.
   */
  private shouldHideTaskList(): boolean {
    const { tasks, tasksClosed } = this.stateData;
    return !tasks || tasks.length === 0 || tasksClosed;
  }

  private renderTaskList(): React.ReactNode {
    const { tasks, tasksExpanded } = this.stateData;
    if (this.shouldHideTaskList()) {
      return null;
    }

    const completedCount = tasks.filter((t) => t.status === 'completed').length;
    const totalCount = tasks.length;

    return (
      <div className="spectre-task-list">
        <div className="spectre-task-header">
          <div
            className="spectre-task-header-left"
            onClick={() => this.setStateData({ tasksExpanded: !tasksExpanded })}
            style={{
              cursor: 'pointer',
              userSelect: 'none',
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span className="spectre-task-toggle">
              {tasksExpanded ? '▼' : '▶'}
            </span>
            <strong>
              📋 Tasks ({completedCount}/{totalCount})
            </strong>
          </div>
          <button
            className="spectre-task-close"
            onClick={() => this.setStateData({ tasksClosed: true })}
            aria-label="Close task list"
            title="Close task list"
            style={{
              cursor: 'pointer',
              padding: '2px 6px',
              background: 'transparent',
              border: 'none',
              color: 'var(--theia-foreground)',
              opacity: 0.6,
              fontSize: '16px',
            }}
          >
            ✕
          </button>
        </div>
        {tasksExpanded && tasks.map((task) => this.renderTask(task))}
      </div>
    );
  }

  private renderTask(task: AgentTask): React.ReactNode {
    let statusIcon = '';
    let statusClass = '';

    switch (task.status) {
      case 'pending':
        statusIcon = '○';
        statusClass = 'task-pending';
        break;
      case 'in-progress':
        statusIcon = '⏳';
        statusClass = 'task-in-progress';
        break;
      case 'completed':
        statusIcon = '✓';
        statusClass = 'task-completed';
        break;
      case 'failed':
        statusIcon = '✗';
        statusClass = 'task-failed';
        break;
    }

    return (
      <div key={task.id} className={`spectre-task ${statusClass}`}>
        <span className="spectre-task-icon">{statusIcon}</span>
        <span className="spectre-task-description">{task.description}</span>
        {task.error && (
          <div className="spectre-task-error">Error: {task.error}</div>
        )}
      </div>
    );
  }

  /**
   * Renders session tab navigation.
   */
  private renderSessionTabs(): React.ReactNode {
    const { sessions, active } = this.stateData;
    return (
      <div className="spectre-tabs" role="tablist" aria-label="Chat sessions">
        {sessions.map((s, i) => (
          <div
            key={s.id}
            role="tab"
            aria-selected={i === active}
            aria-label={`Chat session: ${s.title}`}
            className={i === active ? 'spectre-tab active' : 'spectre-tab'}
            onClick={() => this.setActive(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.setActive(i);
              }
            }}
            tabIndex={0}
            title={s.title}
          >
            {s.title}
          </div>
        ))}
      </div>
    );
  }

  /**
   * Renders empty state message when no messages exist.
   */
  private renderEmptyState(): React.ReactNode {
    const isAgentMode = this.prefs['arduino.spectre.mode'] === 'agent';
    return (
      <div className="spectre-empty">
        {isAgentMode ? (
          <div>
            <strong>Agent Mode:</strong> I can autonomously create/edit
            sketches, verify code, upload to boards, install/manage boards
            & libraries, and configure board settings.
            <br />
            Just ask me what you need - I&apos;ll execute IDE actions
            automatically.
          </div>
        ) : (
          <div>
            <strong>Basic Mode:</strong> Ask me anything about Arduino
            programming.
            <br />I can see your current sketch files and remember our
            conversation.
          </div>
        )}
        <div style={{ marginTop: '8px', fontSize: '12px', opacity: 0.7 }}>
          Requests over quota are queued automatically.
        </div>
      </div>
    );
  }

  /**
   * Renders a single message bubble (user or assistant).
   */
  private renderMessage(
    message: ChatMessage,
    idx: number,
    sessionLength: number
  ): React.ReactNode {
    const { busy } = this.stateData;
    const isUser = message.role === 'user';
    const isLastMessage = idx === sessionLength - 1;

    return (
      <div
        key={message.id}
        className={`spectre-row ${isUser ? 'user' : 'assistant'}`}
      >
        <div
          className={`spectre-bubble ${isUser ? 'user' : 'assistant'}`}
        >
          <div
            className="spectre-meta"
            style={{ textAlign: isUser ? 'right' : 'left' }}
          >
            {isUser ? 'You' : 'Spectre'}
          </div>
          {message.role === 'assistant' ? (
            <div style={{ position: 'relative' }}>
              {this.renderAssistantMessage(
                message.text,
                busy && isLastMessage
              )}
            </div>
          ) : (
            <div className="spectre-user-text">{message.text}</div>
          )}
          {/* Show loading indicator for last assistant message when busy */}
          {message.role === 'assistant' &&
            busy &&
            isLastMessage && (
              <div
                style={{
                  marginTop: '8px',
                  opacity: 0.7,
                  fontSize: '12px',
                }}
              >
                ⏳ Processing...
              </div>
            )}
        </div>
      </div>
    );
  }

  /**
   * Renders the messages area with task list and message history.
   */
  private renderMessagesArea(): React.ReactNode {
    const { sessions, active } = this.stateData;
    const session = sessions[active];

    return (
      <div
        className="spectre-messages"
        data-spectre-scroll
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {this.renderTaskList()}
        {session.messages.length === 0 && this.renderEmptyState()}
        {session.messages.map((m, idx) =>
          this.renderMessage(m, idx, session.messages.length)
        )}
        <div data-spectre-anchor />
      </div>
    );
  }

  /**
   * Renders error message with optional retry button.
   */
  private renderErrorMessage(): React.ReactNode {
    const { error } = this.stateData;
    if (!error) return null;

    return (
      <div className="spectre-error-message">
        <div>{error}</div>
        {this.stateData.retryable && (
          <button
            className="spectre-retry-button"
            onClick={() => {
              this.setStateData({ error: undefined, retryable: false });
              this.send();
            }}
            aria-label="Retry failed request"
            style={{
              marginTop: '8px',
              padding: '4px 8px',
              border: '1px solid var(--theia-button-border)',
              background: 'var(--theia-button-background)',
              color: 'var(--theia-button-foreground)',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            🔄 Retry
          </button>
        )}
      </div>
    );
  }

  /**
   * Renders character limit warning when approaching or exceeding limit.
   */
  private renderCharacterLimitWarning(): React.ReactNode {
    const { input, busy } = this.stateData;
    const charLimit = this.getCharacterLimit();

    if (input.length <= charLimit * 0.9 || busy) return null;

    return (
      <div
        className={`spectre-warning ${
          input.length > charLimit ? 'error' : 'warning'
        }`}
        role="alert"
        aria-live="assertive"
      >
        {input.length > charLimit ? (
          <>
            ⚠️ Message exceeds limit by{' '}
            {(input.length - charLimit).toLocaleString()} characters. Please
            shorten to send.
          </>
        ) : (
          <>
            ⚠️ Approaching character limit ({input.length.toLocaleString()}/
            {charLimit.toLocaleString()})
          </>
        )}
      </div>
    );
  }

  /**
   * Gets CSS class for character count status chip.
   */
  private getCharCountStatusClass(inputLength: number, charLimit: number): string {
    if (inputLength > charLimit) {
      return 'error';
    }
    if (inputLength > charLimit * 0.9) {
      return 'warning';
    }
    return '';
  }

  /**
   * Gets CSS class for send button based on state.
   */
  private getSendButtonClass(busy: boolean, inputLength: number, charLimit: number): string {
    if (busy) {
      return 'spectre-inline-send spectre-stop';
    }
    if (inputLength > charLimit) {
      return 'spectre-inline-send spectre-send spectre-disabled';
    }
    return 'spectre-inline-send spectre-send';
  }

  /**
   * Gets aria-label for send button based on state.
   */
  private getSendButtonAriaLabel(busy: boolean, inputLength: number, charLimit: number): string {
    if (inputLength > charLimit) {
      return `Message too long (${inputLength}/${charLimit})`;
    }
    return busy ? 'Stop response' : 'Send message';
  }

  /**
   * Gets title tooltip for send button based on state.
   */
  private getSendButtonTitle(busy: boolean, inputLength: number, charLimit: number): string {
    if (inputLength > charLimit) {
      return `Message exceeds ${charLimit.toLocaleString()} character limit by ${(
        inputLength - charLimit
      ).toLocaleString()} characters. Please shorten your message.`;
    }
    return busy ? 'Stop response' : 'Send message';
  }

  /**
   * Gets icon/text for send button based on state.
   */
  private getSendButtonContent(busy: boolean, inputLength: number, charLimit: number): string {
    if (busy) return '■';
    if (inputLength > charLimit) return '⚠';
    return '➤';
  }

  /**
   * Renders the input area with textarea, status bar, and send button.
   */
  private renderInputArea(): React.ReactNode {
    const { input, busy } = this.stateData;
    const charLimit = this.getCharacterLimit();

    return (
      <div className="spectre-input">
        <div className="input-wrap">
          <textarea
            rows={3}
            value={input}
            placeholder={busy ? 'Thinking…' : 'Type a message…'}
            onChange={this.onInputChange}
            onKeyDown={this.onKeyDown}
            disabled={busy}
            ref={(el) => (this.inputRef = el)}
            aria-label="Message input"
            aria-describedby="char-count-status"
          />
          <div className="spectre-input-bar">
            <div className="spectre-status-left">
              <span className="spectre-chip compact">
                {this.prefs['arduino.spectre.mode'] === 'agent'
                  ? 'Agent'
                  : 'Basic'}
              </span>
              <span className="spectre-chip compact">
                {this.prefs['arduino.spectre.model']}
              </span>
              <span
                id="char-count-status"
                className={`spectre-chip compact ${this.getCharCountStatusClass(input.length, charLimit)}`}
                role="status"
                aria-live="polite"
                title={`Character count: ${input.length.toLocaleString()} / ${charLimit.toLocaleString()}`}
              >
                {input.length.toLocaleString()}/{charLimit.toLocaleString()}
              </span>
              {this.renderInlineQuota()}
            </div>
            <button
              className={this.getSendButtonClass(busy, input.length, charLimit)}
              onClick={() => {
                spectreLog('🖱️ Send button clicked:', { busy, inputLength: input.length });
                busy ? this.cancel() : this.send();
              }}
              disabled={!busy && (!input.trim() || input.length > charLimit)}
              aria-label={this.getSendButtonAriaLabel(busy, input.length, charLimit)}
              aria-pressed={busy}
              title={this.getSendButtonTitle(busy, input.length, charLimit)}
            >
              {this.getSendButtonContent(busy, input.length, charLimit)}
            </button>
          </div>
          {this.renderMemoryStats()}
        </div>
      </div>
    );
  }

  /**
   * Renders the main widget UI including chat sessions, message history,
   * input textarea, quota display, and agent task panel.
   */
  protected render(): React.ReactNode {
    return (
      <div className="content noselect arduino-spectre-widget" tabIndex={-1}>
        {this.renderSessionTabs()}
        {this.renderMessagesArea()}
        {this.renderErrorMessage()}
        {this.renderCharacterLimitWarning()}
        {this.renderInputArea()}
      </div>
    );
  }

  private deferScroll(): void {
    // Use rAF to ensure DOM updated before scrolling
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.scrollToBottom()); // Double rAF for reliability
    });
  }

  private scrollToBottom(): void {
    const container = this.node?.querySelector(
      '.spectre-messages'
    ) as HTMLElement | null;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }

  private renderInlineQuota(): React.ReactNode {
    const {
      quotaUsed,
      quotaCapacity,
      rpmUsed,
      rpmLimit,
      queueSize,
      nextAvailableMs,
      now,
    } = this.stateData;
    // Calculate percentage correctly: (used / capacity) * 100
    // Ensure we never exceed 100% even if server reports higher usage
    const pct = Math.min(100, Math.max(0, (quotaUsed / quotaCapacity) * 100));
    const remain = Math.max(0, nextAvailableMs - now);
    const clientRpm = this.calculateCurrentRpm(); // Our local 60s window calculation
    const dailyStats = this.getDailyStats();
    const model = this.prefs['arduino.spectre.model'];

    // Show queue if active, otherwise show server RPM vs limit
    const rpmDisplay =
      queueSize > 0
        ? `Q:${queueSize} ${(remain / 1000).toFixed(1)}s`
        : `${rpmUsed}/${rpmLimit} RPM`;

    const title =
      `Model: ${model}\n` +
      `TPM Usage: ${quotaUsed.toLocaleString()}/${quotaCapacity.toLocaleString()} tokens (${pct.toFixed(
        1
      )}%)\n` +
      `RPM: ${rpmUsed}/${rpmLimit}\n` +
      `Client RPM (60s): ${clientRpm}/${rpmLimit}\n` +
      `Daily (Pacific): ${
        dailyStats.requests
      } requests, ${dailyStats.tokens.toLocaleString()} tokens`;

    return (
      <div className="spectre-inline-quota" title={title}>
        <QuotaRing percent={pct} used={quotaUsed} cap={quotaCapacity} />
        <span className="spectre-inline-quota-text">{rpmDisplay}</span>
      </div>
    );
  }

  /**
   * Checks if memory stats should be hidden (empty or no data).
   */
  private shouldHideMemoryStats(
    memoryStats: typeof this.stateData.memoryStats
  ): boolean {
    return (
      !memoryStats ||
      (memoryStats.recentMessages === 0 && memoryStats.summaries === 0)
    );
  }

  /**
   * Renders memory statistics footer showing conversation memory status.
   * Displays recent messages, summaries, token usage, and summarization indicator.
   */
  private renderMemoryStats(): React.ReactNode {
    const { memoryStats } = this.stateData;

    // Don't show if no memory stats available
    if (this.shouldHideMemoryStats(memoryStats)) {
      return null;
    }

    // TypeScript narrowing: memoryStats is guaranteed to be defined here
    const { recentMessages, summaries, totalTokens, isSummarizing } =
      memoryStats!;
    const memoryBankCap = 50000; // From MemoryConfig.memoryBankTokenCap
    const percent = Math.min(
      100,
      Math.max(0, (totalTokens / memoryBankCap) * 100)
    );

    // Color coding based on usage
    let statusClass = 'memory-ok';
    if (percent >= 90) {
      statusClass = 'memory-high';
    } else if (percent >= 70) {
      statusClass = 'memory-medium';
    }

    const statusText =
      summaries > 0
        ? `${recentMessages} msgs + ${summaries} summaries`
        : `${recentMessages} messages`;

    const tokenText = `${TokenCounter.formatCount(
      totalTokens
    )}/${TokenCounter.formatCount(memoryBankCap)}`;

    return (
      <div
        className={`spectre-memory-footer ${statusClass}`}
        title={
          `Conversation Memory:\n` +
          `Recent Messages: ${recentMessages}\n` +
          `Summaries: ${summaries}\n` +
          `Total Tokens: ${totalTokens.toLocaleString()}/${memoryBankCap.toLocaleString()} (${percent.toFixed(
            1
          )}%)\n` +
          `\n` +
          `The AI maintains context by keeping recent messages and compressing older ones into summaries. ` +
          `This allows long conversations without hitting token limits.`
        }
      >
        <span className="memory-icon">💾</span>
        <span className="memory-text">
          {statusText} • {tokenText}
        </span>
        {isSummarizing && (
          <span
            className="memory-status"
            title="Compressing conversation history..."
          >
            ⏳ Summarizing...
          </span>
        )}
      </div>
    );
  }

  /**
   * Fetches current quota state from backend for the selected model.
   * Updates widget state with server-authoritative quota data.
   * Falls back to client-calculated RPM limit if backend is unavailable.
   */
  private async refreshQuotaForCurrentModel(): Promise<void> {
    try {
      const model = this.prefs['arduino.spectre.model'];
      const quota = await this.ai.getQuota(model);

      // Backend quota data is authoritative - update all quota state
      this.setStateData({
        quotaUsed: quota.usedTokens,
        quotaCapacity: quota.capacity,
        rpmUsed: quota.rpmUsed,
        rpmLimit: quota.rpmLimit, // Backend always returns correct RPM for model
        queueSize: quota.queued,
        nextAvailableMs: quota.nextAvailableMs,
      });
    } catch (error) {
      // Backend unavailable or error - use client-side calculated RPM limit
      // This ensures UI shows correct limit even if backend connection fails
      spectreWarn(
        'Failed to fetch quota from backend, using client-calculated RPM limit:',
        error
      );
      this.setStateData({
        rpmLimit: this.getRpmLimit(),
      });
    }
  }

  /**
   * Collects current sketch files (.ino, .cpp, .h) to provide context to AI.
   * Returns file paths and contents for better AI assistance.
   * Includes both saved and unsaved (dirty) files.
   */
  private async getCurrentSketchFiles(): Promise<
    Array<{ path: string; content: string }>
  > {
    const files: Array<{ path: string; content: string }> = [];

    try {
      const sketch = this.sketchesClient.tryGetCurrentSketch();

      if (!CurrentSketch.isValid(sketch)) {
        return this.collectOpenArduinoFiles();
      }

      const mainFileUri = sketch.mainFileUri || sketch.uri;
      const mainUri = new URI(mainFileUri);

      // Collect main file
      const mainFileAdded = this.addMainSketchFile(files, mainFileUri, mainUri);

      // Collect additional sketch files
      this.addAdditionalSketchFiles(files, mainFileUri, mainUri, mainFileAdded);
    } catch (error) {
      spectreWarn('Spectre: Failed to collect sketch files:', error);
    }

    return files;
  }

  /**
   * Collects all open Arduino files when no valid sketch is found.
   */
  private collectOpenArduinoFiles(): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = [];

    for (const editor of this.editorManager.all) {
      if (!editor.editor.uri || !editor.editor.document) continue;

      try {
        const editorUriStr = editor.editor.uri.toString();
        const decodedEditorUri = decodeURIComponent(editorUriStr);
        const editorUri = new URI(decodedEditorUri);

        if (this.isArduinoFileExtension(editorUri.path.ext)) {
          const content = editor.editor.document.getText();
          files.push({
            path: editorUri.path.name + editorUri.path.ext,
            content: content,
          });
        }
      } catch (e) {
        // Ignore URI processing errors
      }
    }

    return files;
  }

  /**
   * Adds the main sketch file to the files array.
   * Returns true if main file was successfully added.
   */
  private addMainSketchFile(
    files: Array<{ path: string; content: string }>,
    mainFileUri: string,
    mainUri: URI
  ): boolean {
    // Try to find main editor by URI matching
    const mainEditor = this.findMainEditor(mainFileUri, mainUri);

    if (mainEditor && mainEditor.editor.document) {
      const content = mainEditor.editor.document.getText();
      files.push({
        path: mainUri.path.name + mainUri.path.ext,
        content: content,
      });
      return true;
    }

    // Fallback: find by filename
    return this.addMainFileByName(files, mainUri);
  }

  /**
   * Finds the main editor by matching URIs.
   */
  private findMainEditor(mainFileUri: string, mainUri: URI) {
    return this.editorManager.all.find((editor) => {
      if (!editor.editor.uri) return false;
      const editorUriStr = editor.editor.uri.toString();

      // Try exact match first
      if (editorUriStr === mainFileUri || editorUriStr === mainUri.toString()) {
        return true;
      }

      // Try decoded comparison
      return this.matchDecodedUris(mainFileUri, editorUriStr);
    });
  }

  /**
   * Matches URIs after decoding them.
   */
  private matchDecodedUris(mainFileUri: string, editorUriStr: string): boolean {
    try {
      const decodedMainUri = decodeURIComponent(mainFileUri);
      const decodedEditorUri = decodeURIComponent(editorUriStr);
      
      if (decodedMainUri === decodedEditorUri) return true;

      // Try path-based comparison
      const mainPath = new URI(decodedMainUri).path.toString();
      const editorPath = new URI(decodedEditorUri).path.toString();
      return mainPath === editorPath;
    } catch (e) {
      return false;
    }
  }

  /**
   * Adds main file by searching for matching filename.
   * Returns true if file was found and added.
   */
  private addMainFileByName(
    files: Array<{ path: string; content: string }>,
    mainUri: URI
  ): boolean {
    const expectedMainFileName = mainUri.path.name + mainUri.path.ext;

    for (const editor of this.editorManager.all) {
      if (!editor.editor.uri || !editor.editor.document) continue;

      try {
        const editorUriStr = editor.editor.uri.toString();
        const decodedEditorUri = decodeURIComponent(editorUriStr);
        const editorUri = new URI(decodedEditorUri);
        const editorFileName = editorUri.path.name + editorUri.path.ext;

        if (this.fileNamesMatch(editorFileName, expectedMainFileName)) {
          const content = editor.editor.document.getText();
          files.push({
            path: expectedMainFileName,
            content: content,
          });
          return true;
        }
      } catch (e) {
        // Ignore URI processing errors
      }
    }

    return false;
  }

  /**
   * Checks if two filenames match (case-insensitive).
   */
  private fileNamesMatch(fileName1: string, fileName2: string): boolean {
    return (
      fileName1 === fileName2 ||
      fileName1.toLowerCase() === fileName2.toLowerCase()
    );
  }

  /**
   * Adds additional sketch files from open editors.
   */
  private addAdditionalSketchFiles(
    files: Array<{ path: string; content: string }>,
    mainFileUri: string,
    mainUri: URI,
    mainFileAdded: boolean
  ): void {
    for (const editor of this.editorManager.all) {
      if (!editor.editor.uri) continue;

      try {
        const editorUriStr = editor.editor.uri.toString();
        const decodedEditorUri = decodeURIComponent(editorUriStr);
        const editorUri = new URI(decodedEditorUri);

        // Skip if this is the main file
        if (
          this.isMainFile({
            editorUriStr,
            decodedEditorUri,
            editorUri,
            mainFileUri,
            mainUri,
            mainFileAdded,
          })
        ) {
          continue;
        }

        // Add if it's a relevant sketch file
        if (this.isRelevantSketchFile(editorUri, mainUri) && editor.editor.document) {
          const content = editor.editor.document.getText();
          files.push({
            path: editorUri.path.name + editorUri.path.ext,
            content: content,
          });
        }
      } catch (e) {
        // Ignore URI processing errors
      }
    }
  }

  /**
   * Checks if the given editor URI represents the main sketch file.
   */
  private isMainFile(params: {
    editorUriStr: string;
    decodedEditorUri: string;
    editorUri: URI;
    mainFileUri: string;
    mainUri: URI;
    mainFileAdded: boolean;
  }): boolean {
    const {
      editorUriStr,
      decodedEditorUri,
      editorUri,
      mainFileUri,
      mainUri,
      mainFileAdded,
    } = params;

    return (
      editorUriStr === mainFileUri ||
      decodedEditorUri === mainFileUri ||
      (mainFileAdded &&
        editorUri.path.name + editorUri.path.ext ===
          mainUri.path.name + mainUri.path.ext)
    );
  }

  /**
   * Checks if a file is a relevant Arduino sketch file.
   * Must be in the same directory and have a valid Arduino file extension.
   */
  private isRelevantSketchFile(editorUri: URI, mainUri: URI): boolean {
    return (
      editorUri.path.dir.toString() === mainUri.path.dir.toString() &&
      this.isArduinoFileExtension(editorUri.path.ext)
    );
  }

  /**
   * Checks if a file extension is valid for Arduino sketches.
   */
  private isArduinoFileExtension(ext: string): boolean {
    return ext === '.ino' || ext === '.cpp' || ext === '.h' || ext === '.c';
  }

  private autoGrow(el: HTMLTextAreaElement): void {
    if (!el) return;
    el.style.height = 'auto';
    const max = 300;
    const newH = Math.min(max, el.scrollHeight);
    el.style.height = newH + 'px';
  }
}

interface QuotaRingProps {
  percent: number;
  used: number;
  cap: number;
}

// eslint-disable-next-line react/prop-types
const QuotaRing: React.FC<QuotaRingProps> = ({ percent, used, cap }) => {
  const r = 12;
  const c = 2 * Math.PI * r;

  // Calculate arc length with minimum visibility (2% minimum so users can see something)
  const minPercent = percent > 0 && percent < 2 ? 2 : percent;
  const dash = (minPercent / 100) * c;

  // Dynamic color based on usage level
  let progressColor = 'var(--theia-charts-green, #89D185)'; // Green: 0-70%
  if (percent >= 90) {
    progressColor = 'var(--theia-errorForeground, #f48771)'; // Red: 90-100%
  } else if (percent >= 70) {
    progressColor = 'var(--theia-charts-orange, #d18616)'; // Orange: 70-89%
  }

  return (
    <svg width={30} height={30} viewBox="0 0 30 30" style={{ marginRight: 6 }}>
      {/* Background circle - more visible with darker stroke */}
      <circle
        cx={15}
        cy={15}
        r={r}
        stroke="var(--theia-input-border, rgba(128, 128, 128, 0.5))"
        strokeWidth={3}
        fill="none"
        opacity={0.3}
      />
      {/* Progress circle - dynamic color based on usage */}
      <circle
        cx={15}
        cy={15}
        r={r}
        stroke={progressColor}
        strokeWidth={3}
        fill="none"
        strokeDasharray={`${dash.toFixed(2)} ${c.toFixed(2)}`}
        strokeLinecap="round"
        transform="rotate(-90 15 15)"
        opacity={percent > 0 ? 1 : 0}
      />
      {/* Center percentage text */}
      <text
        x="15"
        y="19"
        fontSize="9"
        fontWeight="600"
        textAnchor="middle"
        fill="var(--theia-foreground)"
        style={{ userSelect: 'none' }}
      >
        {Math.round(percent)}
      </text>
      <title>{`TPM: ${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${Math.round(
        percent
      )}%)`}</title>
    </svg>
  );
};

function autoTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();

  // Handle very short inputs
  if (clean.length <= 3) return clean;

  // Detect and handle URLs/file paths
  if (clean.match(/^https?:\/\/|^\/|^[A-Z]:\\/)) {
    const urlMatch = clean.match(/\/([^\/]+)(?:\.[^\/]*)?$/);
    if (urlMatch) return `File: ${urlMatch[1]}`;
    return clean.length <= 50 ? clean : clean.slice(0, 47) + '…';
  }

  // Arduino/IoT-specific keywords to preserve
  const arduinoKeywords =
    /\b(arduino|esp32|esp8266|raspberry\s*pi|sensor|led|pwm|analog|digital|pin|i2c|spi|uart|servo|motor|wifi|bluetooth|mqtt|http|json|temperature|humidity|pressure|ultrasonic|gyro|accelerometer|magnetometer|gps|lcd|oled|display|relay|transistor|resistor|capacitor|voltage|current|ohm|amp|volt|watt|frequency|baud|rate|interrupt|timer|delay|millis|micros|setup|loop|void|int|float|double|char|string|array|struct|class|library|include|define|ifdef|ifndef|endif)\b/gi;

  // Technical terms and units to preserve
  const technicalTerms =
    /\b(\d+(?:\.\d+)?\s*(?:v|a|ma|ua|hz|khz|mhz|ghz|mm|cm|m|km|kg|g|mg|°c|°f|k|rpm|ppm|db|lux|pa|bar|psi|mb|gb|kb|bits?|bytes?|mbit|gbit)\b|\d+(?:k|m|g)?(?:hz|bit|byte)s?\b)/gi;

  // Code detection patterns
  const codePatterns = [
    /\/\/|\/\*|\*\/|#include|#define|#ifdef/,
    /\bfunction\s+\w+|def\s+\w+|class\s+\w+/,
    /\b(?:const|let|var)\s+\w+\s*=/,
    /\bvoid\s+setup|void\s+loop/,
    /digitalWrite|digitalRead|analogWrite|analogRead/,
    /Serial\.print|Serial\.begin/,
    /\bfor\s*\(|while\s*\(|if\s*\(/,
  ];

  const isCode = codePatterns.some((pattern) => pattern.test(clean));

  // Handle code snippets with detection
  if (isCode) {
    const lines = clean.split('\n');

    // Look for comments with meaningful content
    const comment = lines.find((line) => {
      const trimmed = line.trim();
      const commentContent = trimmed.replace(/^(\/\/|\/\*|\*|#)\s*/, '').trim();
      return (
        (trimmed.startsWith('//') ||
          trimmed.startsWith('#') ||
          trimmed.startsWith('/*') ||
          trimmed.startsWith('*')) &&
        commentContent.length > 5 &&
        !commentContent.match(/^-+$|^\*+$|^=+$/)
      );
    });

    if (comment) {
      const commentText = comment
        .replace(/^(\/\/|\/\*|\*|#)\s*/, '')
        .replace(/\*\/.*$/, '')
        .trim();
      return commentText.length <= 50
        ? commentText
        : commentText.slice(0, 47) + '…';
    }

    // Look for Arduino-specific function calls
    const arduinoMatch = clean.match(
      /(digitalWrite|digitalRead|analogWrite|analogRead|Serial\.print|pinMode)\s*\([^)]*\)/
    );
    if (arduinoMatch) {
      return `Arduino: ${arduinoMatch[1]}`;
    }

    // Look for function definitions with better parsing
    const funcMatch = clean.match(
      /\b(?:function|def|void|int|float|double|bool|char|String)\s+(\w+)\s*\(/
    );
    if (funcMatch) {
      return `Function: ${funcMatch[1]}`;
    }

    // Look for variable declarations
    const varMatch = clean.match(
      /\b(?:const|let|var|int|float|double|bool|char|String)\s+(\w+)/
    );
    if (varMatch) {
      return `Declare: ${varMatch[1]}`;
    }

    // Fallback to first meaningful code line
    const meaningfulLine = lines.find((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 5 &&
        !trimmed.match(/^[{}();,]*$/) &&
        !trimmed.match(/^\/\/\s*$|^#\s*$/)
      );
    });

    if (meaningfulLine) {
      const trimmed = meaningfulLine.trim();
      return trimmed.length <= 50 ? trimmed : trimmed.slice(0, 47) + '…';
    }
  }

  // Preserve important keywords and technical terms
  const preserveKeywords = (text: string): string => {
    const words = text.split(' ');
    const preserved: string[] = [];
    let totalLength = 0;

    for (const word of words) {
      // Always preserve Arduino/technical keywords
      if (word.match(arduinoKeywords) || word.match(technicalTerms)) {
        if (totalLength + word.length + 1 <= 45) {
          preserved.push(word);
          totalLength += word.length + 1;
        }
      } else if (preserved.length < 3 && totalLength + word.length + 1 <= 45) {
        // Include other important words up to limit
        preserved.push(word);
        totalLength += word.length + 1;
      }
    }

    return preserved.length > 0 ? preserved.join(' ') : text;
  };

  // More nuanced prefix removal for different content types
  let cleaned = clean;

  // Question patterns - be more selective
  if (
    clean.match(
      /^(how do i|how to|what is|can you explain|could you help|please help)/i
    )
  ) {
    cleaned = clean.replace(
      /^(how do i|how to|what is|can you explain|could you help|please help)\s*/i,
      ''
    );
  }

  // Remove trailing question marks and common endings
  cleaned = cleaned
    .replace(/\?+$/, '')
    .replace(/\s+(please|thanks?|thank you)\.?$/i, '');

  // Use cleaned version if it's substantial enough
  const result =
    cleaned.length > 5 && cleaned.length >= clean.length * 0.6
      ? cleaned
      : clean;

  // Apply keyword preservation
  const keywordPreserved = preserveKeywords(result);
  if (keywordPreserved !== result && keywordPreserved.length > 10) {
    return (
      keywordPreserved + (keywordPreserved.length < result.length ? '…' : '')
    );
  }

  // If already short enough, return as-is
  if (result.length <= 50) return result;

  // Smart truncation with better break points
  const breakPoints =
    /[.!?;:]|\s(?:and|or|but|with|for|in|on|at|to|from|using|via|by|of|about)\s/gi;
  let match;
  let lastGoodBreak = 0;

  while ((match = breakPoints.exec(result)) !== null) {
    if (match.index < 45 && match.index > 15) {
      // Ensure minimum meaningful length
      lastGoodBreak = match.index + match[0].length;
    } else if (match.index >= 45) {
      break;
    }
  }

  if (lastGoodBreak > 15) {
    const truncated = result.slice(0, lastGoodBreak).trim();
    return truncated + (truncated.length < result.length ? '…' : '');
  }

  // Smart word boundary truncation preserving important terms
  const words = result.split(' ');
  let title = '';
  let hasImportantTerm = false;

  for (const word of words) {
    const newLength = (title + ' ' + word).length;
    if (newLength > 47) {
      // If we haven't included any important terms yet, try to fit one more
      if (!hasImportantTerm && word.match(arduinoKeywords)) {
        title += (title ? ' ' : '') + word;
        hasImportantTerm = true;
      }
      break;
    }
    title += (title ? ' ' : '') + word;
    if (word.match(arduinoKeywords) || word.match(technicalTerms)) {
      hasImportantTerm = true;
    }
  }

  return title + (title.length < result.length ? '…' : '');
}
