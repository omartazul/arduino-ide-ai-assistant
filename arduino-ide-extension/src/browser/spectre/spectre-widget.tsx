/**
 * Main widget for Spectre AI assistant.
 * Provides chat interface with basic Q&A and autonomous agent mode.
 *
 * @author Tazul Islam
 * 
 * ARCHITECTURE:
 * Complex React widget with dependency injection for Arduino IDE integration.
 * Manages AI chat interface, agent mode automation, and IDE command execution.
 * 
 * Key Features:
 * - Dual mode: Basic Q&A and autonomous agent execution
 * - 19 agent actions (create sketch, verify, upload, board/library management)
 * - Dynamic memory system with conversation summarization
 * - Real-time streaming responses with quota tracking
 * - 18 helper modules for separation of concerns
 * 
 * Code Quality (December 2025):
 * - File size: ~5,400 lines (reduced from 7,627 via helper extraction)
 * - Compilation: 0 errors, 0 warnings ✓
 * - Debug logging: Removed (production-ready)
 * - Type safety: 10+ parameter objects for complex operations
 * - Dependencies: 15+ injected services (BoardsService, LibraryService, etc.)
 * 
 * CodeScene Warnings (Acceptable):
 * - "Number of Functions in a Single Module" - Agent actions require all dependencies
 * - "Primitive Obsession" - Mitigated with parameter objects where appropriate
 * 
 * The high method count is intentional: agent actions need access to all injected
 * dependencies. Extracting to separate services would require massive parameter
 * passing and harm maintainability.
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
  spectreWarn,
  spectreError,
  SKETCH_CONSTANTS,
  ValidationResult,
} from '../../common/protocol/spectre-types';
import { BoardHelper, BoardUrlHelper } from './board/board-helpers';
import { UploadHelper, COMPILATION_ERROR_PATTERNS, UPLOAD_ERROR_PATTERNS } from './feature/upload-helpers';
import { UIHelper } from './ui/ui-helpers';
import { MemoryHelper } from './memory/memory-helpers';
import { StorageHelper } from './feature/storage-helpers';
import { SketchFileHelper } from './feature/sketch-file-helpers';
import { ValidationHelper } from './utils/validation-helpers';
import * as RenderingHelpers from './ui/rendering-helpers';
import * as TaskHelpers from './agent/task-helpers';
import * as ConfigHelpers from './utils/config-helpers';
import * as WidgetRenderHelpers from './ui/widget-render-helpers';
import * as AgentExecutionHelpers from './agent/agent-execution-helpers';

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
 * Parameters for platform installation.
 */
interface PlatformInstallParams {
  platform: any;
  versionToInstall: string;
  platformId: string;
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
 * Parameters for platform validation operations.
 * Reduces primitive obsession by encapsulating platform operation context.
 */
interface PlatformValidationParams {
  platformId: string;
  operation: 'installation' | 'uninstallation';
}

/**
 * Parameters for platform resolution operations.
 * Encapsulates platform identification and version specification.
 */
interface PlatformResolveParams {
  platformId: string;
  version?: string;
}

/**
 * Parameters for board configuration updates.
 * Replaces multiple string parameters with a structured object.
 */
interface BoardConfigParams {
  targetFqbn: string;
  updatedFqbn: string;
}

/**
 * Parameters for markdown rendering operations.
 * Provides type safety for rendering components.
 */
interface RenderingParams {
  text: string;
  key: string;
}

/**
 * Parameters for memory comparison operations.
 * Encapsulates memory update decision logic.
 */
interface MemoryComparisonParams {
  newText: string;
  oldText: string;
  memory: any;
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
import { MemoryManager } from './memory/memory-manager';
import { ConversationMemory, RawMessage } from './memory/memory-types';
import { TokenCounter } from './utils/token-counter';
import { AgentLibraryHelper } from './agent/agent-helpers';

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
  private boardSearchCache: Map<string, import('./board/board-helpers').CachedBoard> | null = null;

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
    return ConfigHelpers.getPacificDate();
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
    return ConfigHelpers.calculateCurrentRpm(this.stateData.requestLogs, Date.now());
  }

  /**
   * Gets the programming language for syntax highlighting based on file extension.
   */
  private getFileLanguage(filePath: string): string {
    return UIHelper.getFileLanguage(filePath);
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
    const currentSketch = await this.sketchesClient.currentSketch();

    if (CurrentSketch.isValid(currentSketch)) {
      return await this.handleExistingSketch(currentSketch, code);
    }

    await this.commands.executeCommand('arduino-new-sketch');

    if (code) {
      return await this.createNewSketchWithCode(code);
    }

    return `✅ COMPLETED: New blank sketch created and ready in the editor. DO NOT call create_sketch again. If you need to add code, use modify_sketch.`;
  }

  private async handleExistingSketch(currentSketch: any, code?: string): Promise<string> {
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
    await this.delay(WIDGET_TIMING.AGENT_ERROR_DELAY);

    const sketch = await this.waitForSketchReady();

    if (CurrentSketch.isValid(sketch)) {
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
    const currentSketch = await this.sketchesClient.currentSketch();

    if (!CurrentSketch.isValid(currentSketch)) {
      throw new Error(
        'No sketch is currently open. Please create or open a sketch first.'
      );
    }

    const currentEditor = this.editorManager.currentEditor;
    if (!currentEditor) {
      throw new Error('No editor is currently active.');
    }

    const document = currentEditor.editor.document;
    const code = document.getText();

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
   * Scans lines for errors using provided patterns.
   */
  private scanLinesForErrors(
    lines: string[],
    patterns: RegExp[]
  ): string[] {
    return UploadHelper.scanLinesForErrors(lines, patterns);
  }

  /**
   * Checks for potential error keywords in lines.
   */
  private findPotentialErrors(lines: string[]): string[] {
    return UploadHelper.findPotentialErrors(lines);
  }

  private async checkCompilationErrors(): Promise<string | null> {
    try {
      const content = await this.readArduinoOutputChannel();
      if (!content) return null;
      const lines = content.split('\n');
      const recentLines = lines.slice(
        -SKETCH_CONSTANTS.RECENT_OUTPUT_LINE_COUNT
      );

      const uploadErrorLines = this.scanLinesForErrors(
        recentLines,
        UPLOAD_ERROR_PATTERNS
      );
      const compilationErrorLines = this.scanLinesForErrors(
        recentLines,
        COMPILATION_ERROR_PATTERNS
      );

      if (uploadErrorLines.length > 0) {
        return uploadErrorLines.join('\n');
      }

      if (compilationErrorLines.length > 0) {
        return compilationErrorLines.join('\n');
      }

      const potentialErrors = this.findPotentialErrors(recentLines);

      if (potentialErrors.length > 0) {
        return potentialErrors.join('\n');
      }

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


    // Validate board selection (port is optional for verification)
    const validation = this.validateBoardAndPort(false);
    if (!validation.valid) {
      throw new Error(validation.message!);
    }


    // Execute verification and wait for completion
    await this.commands.executeCommand('arduino-verify-sketch');

    // Give more time for any output to appear
    await this.delay(WIDGET_TIMING.COMPILATION_TIMEOUT);

    // Check output channel for errors multiple times
    let verificationErrors = await this.checkCompilationErrors();

    // If no errors found immediately, wait a bit more and check again
    if (!verificationErrors) {
        await this.delay(WIDGET_TIMING.UPLOAD_PREPARATION_DELAY);
      verificationErrors = await this.checkCompilationErrors();
    }

    if (verificationErrors) {
        throw new Error(
        `Sketch verification failed with errors:\n\n${verificationErrors}\n\n⚠️ Please fix these compilation errors before proceeding.`
      );
    }

    return `✅ Sketch verification completed successfully for: ${sketch.name}`;
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
    const analysis = UploadHelper.analyzeUploadOutput(diff);

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

  private hasNoErrorIndicators(error: string | undefined): boolean {
    if (!error) return true;
    const errorLower = error.toLowerCase();
    return !errorLower.includes('error') && !errorLower.includes('failed') && !errorLower.includes('timeout');
  }

  private buildFinalUploadResult(analysis: any, previousAttempt: any, diff: string): any {
    const finalError = analysis.error || previousAttempt.analysis?.error || 'Upload failed with unclear error';
    const shouldRetry = analysis.shouldRetry ?? previousAttempt.analysis?.shouldRetry ?? false;
    return { ok: false, errText: finalError, diff, shouldRetry };
  }

  private getAlternateSerialPorts(): DetectedPort[] {
    const cfg = this.boardsServiceProvider.boardsConfig;
    const currentPort = cfg.selectedPort;
    const detected = Object.values(this.boardsServiceProvider.detectedPorts || {});
    
    const serialPorts = detected.filter(
      (dp): dp is DetectedPort =>
        !!dp?.port &&
        dp.port.protocol === 'serial'
    );
    
    return BoardHelper.getAlternateSerialPorts(serialPorts, currentPort?.address);
  }

  private isPortRelatedError(errText: string, shouldRetry?: boolean): boolean {
    return BoardHelper.isPortRelatedError(errText, shouldRetry);
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

  private async agentUploadSketch(): Promise<string> {
    await this.delay(WIDGET_TIMING.SKETCH_SAVE_DELAY);

    const sketch = await this.validateCurrentSketch();
    this.validateUploadEnvironment();


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
    const validation = this.validateBoardAndPort(true);
    if (!validation.valid) {
      throw new Error(validation.message!);
    }
  }

  private async executeUploadWithRetry(sketch: any): Promise<string> {
    const attempt = await this.attemptUploadOnCurrentPort();
    if (attempt.ok) {
        return `✅ Sketch uploaded successfully to board: ${sketch.name}`;
    }

    return await this.handleUploadFailure(attempt, sketch);
  }

  private async handleUploadFailure(attempt: any, sketch: any): Promise<string> {
    const firstErr = attempt.errText || '';

    if (attempt.shouldRetry || this.isPortRelatedError(firstErr, attempt.shouldRetry)) {
      const retryResult = await this.retryUploadOnAlternatePorts(
        firstErr,
        attempt.shouldRetry ?? false
      );
      if (retryResult.ok) {
        return `✅ Sketch uploaded successfully on alternate port ${retryResult.address}.`;
      }
    }

    throw ValidationHelper.formatUploadError(firstErr || 'Upload failed with unknown error.');
  }

  /**
   * Builds a case-insensitive map of libraries for efficient lookup.
   */
  private async agentInstallLibrary(libraryName: string): Promise<string> {
    try {
  
      const validationError = AgentLibraryHelper.validateLibraryName({
        name: libraryName,
        operation: 'install',
      });
      if (validationError) return validationError;

      const searchResults = await this.libraryService.search({ query: libraryName });
      const result = AgentLibraryHelper.processSearchResults({
        name: libraryName,
        searchResults,
      });
      
      if (!result.success) return result.error;
      const libraryPackage = result.package;

      // Check if already installed
      if (libraryPackage.installedVersion) {
        const message = AgentLibraryHelper.formatLibraryMessage({
          name: libraryPackage.name,
          version: libraryPackage.installedVersion,
          type: 'alreadyInstalled',
        });
            return message;
      }

      // Get the version that will be installed
      const versionToInstall = libraryPackage.availableVersions?.[0];
      if (!versionToInstall) {
        return AgentLibraryHelper.formatLibraryMessage({
          name: libraryPackage.name,
          type: 'noVersions',
        });
      }
  
      // Install the library using the backend service
      await this.libraryService.install({
        item: libraryPackage,
        // Upstream API: install dependencies by default; `noDeps: true` skips.
        noDeps: false,
      });

      const successMessage = AgentLibraryHelper.formatLibraryMessage({
        name: libraryPackage.name,
        type: 'installSuccess',
      });
        return successMessage;
    } catch (error: unknown) {
      spectreError('❌ Library installation error:', error);
      return ValidationHelper.formatLibraryInstallError(libraryName, error);
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
  
      const validationError = AgentLibraryHelper.validateLibraryName({
        name: libraryName,
        operation: 'uninstall',
      });
      if (validationError) return validationError;

      const searchResults = await this.libraryService.search({ query: libraryName });
      const result = AgentLibraryHelper.processSearchResults({
        name: libraryName,
        searchResults,
      });
      
      if (!result.success) return result.error;
      const libraryPackage = result.package;

      // Check if the library is actually installed
      if (!libraryPackage.installedVersion) {
        const message = AgentLibraryHelper.formatLibraryMessage({
          name: libraryPackage.name,
          type: 'notInstalled',
        });
            return message;
      }

  
      // Uninstall the library using the backend service
      await this.libraryService.uninstall({
        item: libraryPackage,
      });

      // Write confirmation to Output panel
      const outputChannel = this.outputChannels.getChannel('Arduino');
      outputChannel.appendLine(
        `Uninstalled ${libraryPackage.name}@${libraryPackage.installedVersion}`
      );

      const successMessage = AgentLibraryHelper.formatLibraryMessage({
        name: libraryPackage.name,
        type: 'uninstallSuccess',
      });
        return successMessage;
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


    while (Date.now() - startTime < maxWaitTime) {
      try {
        const testSearch = await this.boardsService.search({ query: '' });
        if (testSearch && testSearch.length > 0) {
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
  
      const indexReady = await this.pollForPackageIndexReady(10000);
      return { success: indexReady, timedOut: !indexReady };
    } catch (updateError) {
      spectreWarn('⚠️ Package index update failed:', updateError);
      return { success: false, timedOut: false };
    }
  }

  private async agentAddBoardUrl(url: string): Promise<string> {
    if (!url || !url.trim()) {
      return '❌ Board manager URL is required';
    }

    try {
  
      const { urlAlreadyExists } = await BoardUrlHelper.addToConfiguration(
        this.configService,
        url
      );

      const updateResult = await this.updateAndWaitForPackageIndex();

      return BoardUrlHelper.formatBoardUrlMessage({
        type: 'addResult',
        url,
        urlAlreadyExists,
        updateResult,
      });
    } catch (error) {
      spectreError('❌ Failed to add board manager URL:', error);
      return `❌ Failed to add board manager URL: ${error}`;
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
  
      const currentConfig = await this.configService.getConfiguration();
      if (!currentConfig.config) {
        return `❌ Failed to read configuration`;
      }

      const currentUrls = currentConfig.config.additionalUrls || [];
      if (currentUrls.length === 0) {
        return `ℹ️ No board manager URLs configured in preferences`;
      }

      const urlsToRemove = BoardUrlHelper.findUrlsToRemove(urlOrName, currentUrls);
      if (urlsToRemove.length === 0) {
        return BoardUrlHelper.formatBoardUrlMessage({
          type: 'noMatch',
          urlOrName,
          currentUrls,
        });
      }

      const updatedUrls = await BoardUrlHelper.removeUrlsFromConfiguration(
        this.configService,
        this.commands,
        urlsToRemove,
        currentUrls
      );

      if (urlsToRemove.length > 1) {
        return BoardUrlHelper.formatBoardUrlMessage({
          type: 'multipleRemoval',
          urlsToRemove,
          urlOrName,
          remainingCount: updatedUrls.length,
        });
      }

      return BoardUrlHelper.formatBoardUrlMessage({
        type: 'singleRemoval',
        url: urlsToRemove[0],
        remainingCount: updatedUrls.length,
      });
    } catch (error) {
      spectreError('❌ Failed to remove board manager URL:', error);
      return `❌ Failed to remove board manager URL: ${error}`;
    }
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
  
      // Fetch the wiki page
      const response = await fetch(wikiUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch wiki: ${response.status} ${response.statusText}`
        );
      }

      const wikiContent = await response.text();

      // Parse the wiki content
      const matches = BoardHelper.parseWikiForBoardUrls(wikiContent, query);

      if (matches.length === 0) {
        return `❌ No board manager URLs found for "${query}"

💡 Try searching with a different term or check the Arduino Wiki manually:
https://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls`;
      }

      return BoardHelper.formatBoardUrlResults(matches, query);
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
    return BoardHelper.buildPlatformLookupMaps(searchResults);
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
    return BoardHelper.findMatchingPlatform(platformId, searchResults, exactMap, caseInsensitiveMap);
  }

  /**
   * Shared helper: Format platform search error with suggestions.
   * Used by both install and uninstall operations.
   */
  private formatPlatformSearchError(platformId: string, searchResults: any[]): { error: string } {
    return {
      error: BoardHelper.formatPlatformSearchError(platformId, searchResults),
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

  private async agentInstallBoard(
    platformId: string,
    version?: string
  ): Promise<string> {
    // Use shared validation helper to maintain consistency
    const validation = this.validatePlatformId({ platformId, operation: 'installation' });
    if (validation) {
      return validation;
    }

    try {
      const platform = await this.resolvePlatformForInstall({ platformId, version });
      if (typeof platform === 'string') {
        return platform;
      }

      return await this.installPlatform({
        platform: platform.item,
        versionToInstall: platform.version,
        platformId,
      });
    } catch (error) {
      spectreError(`❌ Failed to install platform "${platformId}":`, error);
      return ValidationHelper.formatInstallationError(platformId, error);
    }
  }

  /**
   * Shared helper: Validate platform ID format.
   * Used by both install and uninstall operations.
   */
  private validatePlatformId(params: PlatformValidationParams): string | null {
    return BoardHelper.validatePlatformId(params.platformId, params.operation);
  }

  private async resolvePlatformForInstall(params: PlatformResolveParams): Promise<{ item: any; version: string } | string> {
    const { platformId, version } = params;
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

  private async installPlatform(params: PlatformInstallParams): Promise<string> {
    const { platform, versionToInstall } = params;

    await this.boardsService.install({
      item: platform,
      version: versionToInstall,
      skipPostInstall: false,
    });

    this.outputChannels
      .getChannel('Arduino')
      .appendLine(`Installed ${platform.name}@${versionToInstall}`);

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
  
      const searchResults = await this.boardsService.search({ query });

      if (!searchResults || searchResults.length === 0) {
        return `❌ No board platforms found for "${query}"

💡 Try:
• Different search terms (manufacturer name, board name, etc.)
• Adding the board manager URL first if it's a 3rd-party board`;
      }      // Format results with clear platform IDs that AI can extract
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
  
      const platform = await this.findPlatformForUninstall(platformId);
      if (typeof platform === 'string') {
        return platform;
      }

      return await this.uninstallPlatform(platform);
    } catch (error) {
      spectreError(`❌ Failed to uninstall platform "${platformId}":`, error);
      return ValidationHelper.formatUninstallError(platformId, error);
    }
  }

  private validateUninstallRequest(platformId: string): string | null {
    return this.validatePlatformId({ platformId, operation: 'uninstallation' });
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

    await this.boardsService.uninstall({ item: platform });

    const outputChannel = this.outputChannels.getChannel('Arduino');
    outputChannel.appendLine(`Uninstalled ${platform.name}@${installedVersion}`);

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
   * Opens editor with retry logic.
   */
  private async openEditorWithRetry(uri: any): Promise<any> {
    let editor = await this.editorManager.open(uri);

    // If editor is not available, wait and try again with longer timeout
    if (!editor) {
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
    return UIHelper.computeDiffElements(oldLines, newLines);
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
      const zoneIds = UIHelper.createViewZones(control, contentWidgets);

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
    this.boardSearchCache = BoardHelper.buildBoardCache(boards);
  }

  /**
   * Check if board cache is valid.
   */
  private isBoardCacheValid(): boolean {
    return BoardHelper.isBoardCacheValid(this.boardSearchCache);
  }

  /**
   * Find board by name - SMART matching with typo tolerance.
   * Uses cached normalized data for O(1) lookups.
   * Returns the FIRST board where ALL input words appear in the board name (with fuzzy matching).
   */
  private findBoardByName(inputName: string, boards: any[]): any | null {

    if (!this.isBoardCacheValid()) {
      this.buildBoardCache(boards);
    }

    const result = BoardHelper.findBoardByName(inputName, this.boardSearchCache!);
    
    if (result.board) {      } else {
      }
    
    return result.board;
  }

  /**
   * Agent board selection - SIMPLE AND DIRECT
   * User provides board NAME → we find it → we select it
   * NO FQBN BULLSHIT - just match the name and select the board
   */
  private async agentSelectBoard(input: string): Promise<string> {
    try {
    
      await this.boardsServiceProvider.ready;
      const allBoards = await this.getInstalledBoards();
      const matchedBoard = this.findBoardByName(input.toLowerCase().trim(), allBoards);

      if (!matchedBoard) {
        return `❌ Board not found: "${input}". Check installed boards in Tools → Board menu.`;
      }

    
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
        return `✅ Board already selected: ${matchedBoard.name} (${matchedBoard.fqbn}). No action needed - board configuration is ready.`;
    }

    this.boardsServiceProvider.updateConfig({
      name: matchedBoard.name,
      fqbn: matchedBoard.fqbn,
    });

    await this.delay(WIDGET_TIMING.BOARD_SELECTION_DELAY);

    const updatedConfig = this.boardsServiceProvider.boardsConfig;
    if (updatedConfig?.selectedBoard?.fqbn === matchedBoard.fqbn) {
        return `✅ Board selected: ${matchedBoard.name} (${matchedBoard.fqbn})`;
    }

    spectreWarn('⚠️ Selection validation failed');
    return `⚠️ Board selected but validation failed: ${matchedBoard.name}`;
  }

  private async agentSelectPort(port: string): Promise<string> {
    try {
  
      // Find the port in detected ports
      const detectedPorts = Object.values(
        this.boardsServiceProvider.detectedPorts
      );
      const targetPort = detectedPorts.find(
        (dp: any) => dp.port.address === port
      );

      if (targetPort) {
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
    return BoardHelper.parseConfigOptions(options);
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

    return BoardHelper.extractBoardIdFromFqbn(fqbn);
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

    const boardId = BoardHelper.extractBoardIdFromFqbn(fqbn);
    return boardId;
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
      await this.updateBoardProviderConfig({ targetFqbn, updatedFqbn });
    }

    return { updatedFqbn };
  }

  private async updateBoardProviderConfig(params: BoardConfigParams): Promise<void> {
    const { targetFqbn, updatedFqbn } = params;
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
    return ConfigHelpers.getDailyStats(this.stateData.dailyTracker);
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
        } catch (err) {        }
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
        try {
          input!.selectionStart = input!.selectionEnd = input!.value.length;
        } catch (err) {
          // Cursor positioning failed silently
        }
      }
    };
    // Small delay to ensure DOM is ready and any state updates have finished
    setTimeout(tryFocus, WIDGET_TIMING.FOCUS_INPUT_DELAY);
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

  private shouldUpdateMemory(params: MemoryComparisonParams): boolean {
    const { newText, oldText, memory } = params;
    return newText !== oldText && newText.trim() !== '' && !!memory;
  }

  private canSendMessage(text: string, busy: boolean, sending: boolean): boolean {
    return !!text && !busy && !sending;
  }

  private isNetworkError(message: string): boolean {
    const msg = message.toLowerCase();
    return msg.includes('network') || msg.includes('fetch') || msg.includes('connection');
  }

  /**
   * Extracts Arduino code from text (looks for code blocks or detects Arduino patterns)
   */
  private extractArduinoCode(
    text: string
  ): Array<{ code: string; type: 'block' | 'inline'; language?: string }> {
    return UIHelper.extractArduinoCode(text);
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
    const hasValidEditor = success && editor?.editor;
    if (hasValidEditor) {
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
  private renderMarkdownText(params: RenderingParams): React.ReactNode {
    const { text, key } = params;
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
        parts.push(this.renderMarkdownText({ text: beforeCode, key: `text-${blockIndex}` }));
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
    const { language, lineCount } = UIHelper.getCodeBlockMetadata(codeBlock);

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
    await StorageHelper.persistAll({
      storage: this.storage,
      sketchKey: this.stateData.sketchKey,
      sessions: this.stateData.sessions,
      requestLogs: this.stateData.requestLogs,
      dailyTracker: this.stateData.dailyTracker,
    });
  }

  /**
   * Persists request tracking data to global storage.
   */
  private async persistTrackingData(): Promise<void> {
    await StorageHelper.persistTrackingData(
      this.storage,
      this.stateData.requestLogs,
      this.stateData.dailyTracker
    );
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
    MemoryHelper.saveSessionMemory(sessionId, session.memory);
  }

  /**
   * Loads session memory from localStorage when restoring a session.
   * Returns undefined if no saved memory exists.
   */
  private loadSessionMemory(sessionId: number): ConversationMemory | undefined {
    return MemoryHelper.loadSessionMemory(sessionId, this.memoryManager);
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
      return;
    }
    this.setStateData({ input: value });
    this.autoGrow(e.target);
  };
  private onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
    return ConfigHelpers.getCharacterLimit(this.getModelName());
  }

  /**
   * Gets the RPM (requests per minute) limit based on the selected model.
   */
  private getRpmLimit(): number {
    return ConfigHelpers.getRpmLimit(this.getModelName());
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

    this.memoryManager.assemblePrompt(session.memory, {
      currentPrompt: text,
      additionalContext: sketchContext,
      targetTokenBudget: targetBudget,
    });

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
    conversationHistory.push({ role: 'user', text: contextualPrompt });    return conversationHistory;
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
    const { functionCalls, detectLoop, actionHistory, conversationHistory, requestSeq } = params;    if (this.handleLoopDetection(detectLoop(functionCalls), requestSeq)) {
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

    if (this.taskCompletedSuccessfully(responseText, actionHistory)) {
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
  
      if (requestSeq !== this.stateData.requestSeq) {
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

  private requiresFunctionCalling(response: any): boolean {
    return !!(response.functionCalls && response.functionCalls.length > 0);
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
   * Executes a function call from the AI agent by routing to the appropriate agent method.
   */
  private async executeFunctionCall(functionCall: {
    name: string;
    args: Record<string, any>;
  }): Promise<{ success: boolean; result?: string; error?: string }> {
    return AgentExecutionHelpers.executeFunctionCall(
      functionCall,
      {
        // Sketch handlers
        agentCreateSketch: (name, code) => this.agentCreateSketch(name, code),
        agentReadSketch: () => this.agentReadSketch(),
        agentVerifySketch: () => this.agentVerifySketch(),
        agentUploadSketch: () => this.agentUploadSketch(),
        // Board handlers
        agentGetBoardsList: () => this.agentGetBoardsList(),
        agentSelectBoard: (name) => this.agentSelectBoard(name),
        agentSearchBoards: (query) => this.agentSearchBoards(query),
        agentInstallBoard: (platform, version) => this.agentInstallBoard(platform, version),
        agentUninstallBoard: (platform) => this.agentUninstallBoard(platform),
        agentAddBoardUrl: (url) => this.agentAddBoardUrl(url),
        agentRemoveBoardUrl: (url) => this.agentRemoveBoardUrl(url),
        agentFetchBoardUrls: (query) => this.agentFetchBoardUrls(query),
        agentGetBoardConfig: (fqbn) => this.agentGetBoardConfig(fqbn),
        agentSetBoardConfig: (fqbn, options) => this.agentSetBoardConfig(fqbn, options),
        // Port and library handlers
        agentGetPortsList: () => this.agentGetPortsList(),
        agentSelectPort: (address) => this.agentSelectPort(address),
        agentInstallLibrary: (name) => this.agentInstallLibrary(name),
        agentUninstallLibrary: (name) => this.agentUninstallLibrary(name),
      },
      spectreError
    );
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
    
    if (!this.canSendMessage(text, this.stateData.busy, this.sending)) {
        return null;
    }

    const charLimit = this.getCharacterLimit();
    if (text.length > charLimit) {
        this.setStateData({
        error: `Message too long. Please limit to ${charLimit.toLocaleString()} characters for ${
          this.prefs['arduino.spectre.model']
        }.`,
      });
      return null;
    }

    const now = Date.now();
    if (now - this.lastSendAt < 350) {
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

    this.memoryManager.assemblePrompt(session.memory, {
      currentPrompt: text,
      additionalContext: sketchContext,
      targetTokenBudget: targetBudget,
    });

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
    }    return conversationHistory;
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

  async send(): Promise<void> {    try {
      const prepared = await this.validateAndPrepareMessage();
      if (!prepared) {
            return;
      }

      // Set sending flag AFTER validation succeeds
      this.sending = true;

      const { text, requestSeq, abortKey, model, sessions } = prepared;      const current = sessions[this.stateData.active];

      // Collect current sketch files for context (both basic and agent modes need this)
      const sketchFiles = await this.getCurrentSketchFiles();

      const agentMode = this.prefs['arduino.spectre.mode'] === 'agent';
  
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
      if (this.shouldUpdateMemory({ newText, oldText: last.text, memory: cur.memory })) {
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
   */
  private parseTasksFromResponse(text: string): AgentTask[] {
    return TaskHelpers.parseTasksFromResponse(text);
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
    return RenderingHelpers.suppressRedundantCodeBlocks(text);
  }

  /**
   * Gets a friendly icon for a function name.
   * Makes the UI more visual and easier to scan.
   */
  private getFunctionIcon(functionName: string): string {
    return RenderingHelpers.getFunctionIcon(functionName);
  }

  /**
   * Gets a friendly label for a function name.
   * Makes technical function names human-readable.
   */
  private getFunctionLabel(functionName: string): string {
    return RenderingHelpers.getFunctionLabel(functionName);
  }

  /**
   * Checks if task list should be hidden.
   */
  private renderTaskList(): React.ReactNode {
    return WidgetRenderHelpers.renderTaskList({
      tasks: this.stateData.tasks,
      tasksExpanded: this.stateData.tasksExpanded,
      tasksClosed: this.stateData.tasksClosed,
      onToggleExpand: () => this.setStateData({ tasksExpanded: !this.stateData.tasksExpanded }),
      onClose: () => this.setStateData({ tasksClosed: true }),
    });
  }



  /**
   * Renders session tab navigation.
   */
  private renderSessionTabs(): React.ReactNode {
    return WidgetRenderHelpers.renderSessionTabs({
      sessions: this.stateData.sessions,
      active: this.stateData.active,
      onSetActive: (i) => this.setActive(i),
    });
  }

  /**
   * Renders empty state message when no messages exist.
   */
  private renderEmptyState(): React.ReactNode {
    return WidgetRenderHelpers.renderEmptyState({
      isAgentMode: this.prefs['arduino.spectre.mode'] === 'agent',
    });
  }

  /**
   * Renders a single message bubble (user or assistant).
   */
  private renderMessage(
    message: ChatMessage,
    idx: number,
    sessionLength: number
  ): React.ReactNode {
    return WidgetRenderHelpers.renderMessage({
      message,
      idx,
      sessionLength,
      busy: this.stateData.busy,
      renderAssistantMessage: (text, isStreaming) => this.renderAssistantMessage(text, isStreaming),
    });
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
    return WidgetRenderHelpers.renderErrorMessage({
      error: this.stateData.error,
      retryable: this.stateData.retryable,
      onRetry: () => {
        this.setStateData({ error: undefined, retryable: false });
        this.send();
      },
    });
  }

  /**
   * Renders character limit warning when approaching or exceeding limit.
   */
  private renderCharacterLimitWarning(): React.ReactNode {
    return WidgetRenderHelpers.renderCharacterLimitWarning({
      inputLength: this.stateData.input.length,
      charLimit: this.getCharacterLimit(),
      busy: this.stateData.busy,
    });
  }

  /**
   * Renders the input area with textarea, status bar, and send button.
   */
  private renderInputArea(): React.ReactNode {
    return WidgetRenderHelpers.renderInputArea({
      input: this.stateData.input,
      busy: this.stateData.busy,
      mode: this.prefs['arduino.spectre.mode'] as 'agent' | 'basic',
      model: this.prefs['arduino.spectre.model'],
      charLimit: this.getCharacterLimit(),
      onInputChange: this.onInputChange,
      onKeyDown: this.onKeyDown,
      onSendClick: () => {
            this.send();
      },
      onCancelClick: () => this.cancel(),
      inputRef: (el) => (this.inputRef = el),
      inlineQuota: this.renderInlineQuota(),
      memoryStats: this.renderMemoryStats(),
    });
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
        return SketchFileHelper.collectOpenArduinoFiles(this.editorManager);
      }

      const mainFileUri = sketch.mainFileUri || sketch.uri;
      const mainUri = new URI(mainFileUri);

      // Collect main file
      const mainFileAdded = SketchFileHelper.addMainSketchFile(files, this.editorManager, mainFileUri, mainUri);

      // Collect additional sketch files
      SketchFileHelper.addAdditionalSketchFiles(files, this.editorManager, mainFileUri, mainUri, mainFileAdded);
    } catch (error) {
      spectreWarn('Spectre: Failed to collect sketch files:', error);
    }

    return files;
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
