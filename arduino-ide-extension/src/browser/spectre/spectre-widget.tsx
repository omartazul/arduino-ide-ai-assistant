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
    // Validate that this event is for the current active request
    if (!this.currentAbortKey || event.key !== this.currentAbortKey) {
      // Event for a different or canceled request - ignore it
      return;
    }

    if (this.currentRequestSeq === undefined) {
      spectreWarn(
        'Received stream event for unknown request sequence - ignoring'
      );
      return;
    }

    if (event.error) {
      this.stopStreamTicker();
      this.mutateLastAssistant(
        (prev) => prev + `\n\nError: ${event.error}`,
        this.currentRequestSeq
      );
      this.setStateData({ busy: false, currentAbortKey: undefined });
      // Auto-focus input after error
      this.focusInput();
      return;
    }

    if (event.delta) {
      // Buffer deltas and reveal smoothly via ticker
      if (!this.streamStarted) this.streamStarted = true;
      this.streamBuffer += event.delta;
      this.startStreamTicker(this.currentRequestSeq);
    }

    if (event.done) {
      // If no ticker running, flush remaining buffer immediately
      if (!this.streamTicker) {
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
        // Ensure input is focused after completion
        this.focusInput();
      } else {
        // Let the ticker finish flushing, but set a timeout as fallback
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
  private getFileLanguage(filePath: string): string {
    const ext = filePath.toLowerCase().split('.').pop();
    switch (ext) {
      case 'ino':
      case 'cpp':
      case 'cc':
      case 'cxx':
        return 'cpp';
      case 'h':
      case 'hpp':
        return 'cpp';
      case 'c':
        return 'c';
      case 'js':
        return 'javascript';
      case 'py':
        return 'python';
      default:
        return '';
    }
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

    // First check if we already have a valid sketch open
    const currentSketch = await this.sketchesClient.currentSketch();

    if (CurrentSketch.isValid(currentSketch)) {
      spectreLog('🔧 Found existing sketch, using it:', currentSketch.name);

      if (code) {
        await this.agentModifySketch(
          `${currentSketch.uri}/${currentSketch.name}.ino`,
          code
        );
        return `✅ COMPLETED: Updated existing sketch "${currentSketch.name}" with the requested code. The sketch is now ready in the editor. DO NOT call create_sketch again - the task is complete.`;
      } else {
        // CRITICAL: Return a definitive message that the sketch ALREADY EXISTS
        // This prevents the agent from looping and trying to create it again
        return `✅ COMPLETED: Sketch "${currentSketch.name}" already exists and is open in the editor. DO NOT create it again - it is ready for use. If you need to modify it, use the code in the current sketch.`;
      }
    }

    spectreLog('🔧 No valid sketch found, creating new one...');

    // If no sketch exists, create a new one
    await this.commands.executeCommand('arduino-new-sketch');

    if (code) {
      spectreLog(
        '🔧 Waiting for new sketch to be created and editor to be ready...'
      );
      // Wait longer for the editor to open and become available
      await this.delay(WIDGET_TIMING.AGENT_ERROR_DELAY);

      let retries = SKETCH_CONSTANTS.MAX_SKETCH_CREATION_RETRIES;
      let sketch: any = null;

      // Retry getting the current sketch if it's not immediately available
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

      if (CurrentSketch.isValid(sketch)) {
        spectreLog('🔧 Sketch is ready, adding code to:', sketch.name);
        await this.agentModifySketch(`${sketch.uri}/${sketch.name}.ino`, code);
        return `✅ COMPLETED: Created new sketch "${sketch.name}" with your MQ-5 sensor code. The sketch is now open in the editor with all the code you requested. DO NOT call create_sketch again - the task is finished. If you need to verify or upload, use those specific functions.`;
      } else {
        spectreLog('❌ Could not get valid sketch after creation');
        // THROW ERROR instead of returning success message
        throw new Error(
          'Could not get valid sketch after creation - please create the sketch manually'
        );
      }
    }

    return `✅ COMPLETED: Created new sketch and opened in editor. DO NOT create another sketch - this one is ready.`;
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
    try {
      // Try modern async API first
      const managerAny = this.outputChannels as any;
      if (typeof managerAny.contentOfChannel === 'function') {
        return (await managerAny.contentOfChannel('Arduino')) || '';
      }
    } catch {
      // Fallback to direct channel access
    }

    const outputChannel = this.outputChannels.getChannel('Arduino');
    if (!outputChannel) {
      spectreWarn('Arduino output channel not found');
      return '';
    }

    try {
      // Try various getText methods based on API version
      if ('getText' in outputChannel) {
        return (outputChannel as any).getText();
      } else if ('text' in outputChannel) {
        return (outputChannel as any).text;
      } else if ('append' in outputChannel && 'clear' in outputChannel) {
        const channelImpl = outputChannel as any;
        if (channelImpl._lines) {
          return channelImpl._lines.join('\n');
        } else if (channelImpl.document?.getText) {
          return channelImpl.document.getText();
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
  private async checkCompilationErrors(): Promise<string | null> {
    try {
      const content = await this.readArduinoOutputChannel();
      if (!content) return null;

      spectreLog('📋 Output channel content length:', content.length);
      spectreLog(
        '📋 Last chars of output:',
        content.slice(-SKETCH_CONSTANTS.DEBUG_OUTPUT_CHAR_LIMIT)
      );

      // Get the last N lines to focus on recent output (uploads often write at the end)
      const lines = content.split('\n');
      const recentLines = lines.slice(
        -SKETCH_CONSTANTS.RECENT_OUTPUT_LINE_COUNT
      );

      // Error patterns for Arduino compilation and upload
      const compilationErrorPatterns = [
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

      // Generic upload error patterns for all platforms
      const uploadErrorPatterns = [
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

      const errorLines: string[] = [];
      const uploadErrorLines: string[] = [];

      // Check each line for errors
      for (const line of recentLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // Check for compilation errors
        if (
          compilationErrorPatterns.some((pattern: RegExp) =>
            pattern.test(trimmedLine)
          )
        ) {
          errorLines.push(trimmedLine);
        }

        // Check for upload errors (these are critical for agent mode)
        if (
          uploadErrorPatterns.some((pattern: RegExp) =>
            pattern.test(trimmedLine)
          )
        ) {
          uploadErrorLines.push(trimmedLine);
        }
      }

      // Upload errors take priority as they're more specific
      if (uploadErrorLines.length > 0) {
        spectreLog('🔴 Upload errors detected:', uploadErrorLines);
        return uploadErrorLines.join('\n');
      }

      if (errorLines.length > 0) {
        spectreLog('🔴 Compilation errors detected:', errorLines);
        return errorLines.join('\n');
      }

      // Additional check: look for any line containing "error" in the recent output
      const recentErrorLines = recentLines.filter(
        (line: string) =>
          line.toLowerCase().includes('error') ||
          line.toLowerCase().includes('failed') ||
          line.toLowerCase().includes('timeout')
      );

      if (recentErrorLines.length > 0) {
        spectreLog('🟡 Potential errors found:', recentErrorLines);
        return recentErrorLines.join('\n');
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

  private async agentUploadSketch(): Promise<string> {
    // Wait a moment to ensure any file operations are complete
    await this.delay(WIDGET_TIMING.SKETCH_SAVE_DELAY);

    const sketch = await this.sketchesClient.currentSketch();
    if (!CurrentSketch.isValid(sketch)) {
      throw new Error('No valid sketch is currently open');
    }

    spectreLog('🔍 Checking current board and port selection before upload...');

    // Validate both board and port selection for upload
    const validation = this.validateBoardAndPort(true);
    if (!validation.valid) {
      throw new Error(validation.message!);
    }

    spectreLog('🔧 Executing sketch upload...');

    // Analyzer with pattern matching for upload output
    const analyzeUploadOutput = (
      diff: string
    ): { success: boolean; error?: string; shouldRetry?: boolean } => {
      const lines = diff
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l);

      // Pre-compiled pattern categories for efficient single-pass matching
      // Eliminates O(n×m) nested filter+some operations
      const PATTERN_CATEGORIES = {
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
          /connecting\.\.\./i,
          /leaving\.\.\./i,
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

      // Single-pass line categorization: O(n×k) instead of O(n×m) multiple passes
      interface LineCategorization {
        criticalErrors: string[];
        portErrors: string[];
        uploadErrors: string[];
        successLines: string[];
        normalBuildLines: string[];
        genericErrors: string[];
      }

      const categorized: LineCategorization = {
        criticalErrors: [],
        portErrors: [],
        uploadErrors: [],
        successLines: [],
        normalBuildLines: [],
        genericErrors: [],
      };

      // Single pass through all lines
      for (const line of lines) {
        let categorizedThisLine = false;

        // Check critical errors first (highest priority)
        for (const pattern of PATTERN_CATEGORIES.criticalError) {
          if (pattern.test(line)) {
            categorized.criticalErrors.push(line);
            categorizedThisLine = true;
            break;
          }
        }
        if (categorizedThisLine) continue;

        // Check port errors
        for (const pattern of PATTERN_CATEGORIES.portError) {
          if (pattern.test(line)) {
            categorized.portErrors.push(line);
            categorizedThisLine = true;
            break;
          }
        }
        if (categorizedThisLine) continue;

        // Check upload errors
        for (const pattern of PATTERN_CATEGORIES.uploadError) {
          if (pattern.test(line)) {
            categorized.uploadErrors.push(line);
            categorizedThisLine = true;
            break;
          }
        }
        if (categorizedThisLine) continue;

        // Check success indicators
        for (const pattern of PATTERN_CATEGORIES.success) {
          if (pattern.test(line)) {
            categorized.successLines.push(line);
            categorizedThisLine = true;
            break;
          }
        }
        if (categorizedThisLine) continue;

        // Check normal build output
        for (const pattern of PATTERN_CATEGORIES.normalBuildOutput) {
          if (pattern.test(line)) {
            categorized.normalBuildLines.push(line);
            categorizedThisLine = true;
            break;
          }
        }
        if (categorizedThisLine) continue;

        // Check for generic errors (but ignore warnings)
        if (
          /\b(error|failed|failure|exception)\b/i.test(line) &&
          !/warning/i.test(line)
        ) {
          categorized.genericErrors.push(line);
        }
      }

      // Decision logic based on categorized results
      if (categorized.criticalErrors.length > 0) {
        return {
          success: false,
          error: categorized.criticalErrors.join('\n'),
          shouldRetry: false,
        };
      }

      const hasStrongSuccess = categorized.successLines.length > 0;

      if (categorized.portErrors.length > 0) {
        return {
          success: false,
          error: categorized.portErrors.join('\n'),
          shouldRetry: true,
        };
      }

      if (categorized.uploadErrors.length > 0 && !hasStrongSuccess) {
        return {
          success: false,
          error: categorized.uploadErrors.join('\n'),
          shouldRetry: false,
        };
      }

      if (hasStrongSuccess) {
        return { success: true, shouldRetry: false };
      }

      if (categorized.genericErrors.length > 0) {
        return {
          success: false,
          error: categorized.genericErrors.join('\n'),
          shouldRetry: false,
        };
      }

      // No clear success or error - for Arduino uploads, this often means success
      const hasAnyContent = lines.length > 0;
      if (!hasAnyContent) {
        spectreLog('🔍 Empty upload output - considering successful');
        return { success: true, shouldRetry: false };
      }

      if (categorized.normalBuildLines.length > 0) {
        // Has build output but no errors, likely successful
        spectreLog('🔍 Normal build output detected - considering successful');
        return { success: true, shouldRetry: false };
      }

      // If the upload command completed without throwing and we're just missing
      // explicit success indicators, it's likely successful
      const hasActualErrors = lines.some(
        (l) =>
          /\berror\b/i.test(l) ||
          /\bfailed\b/i.test(l) ||
          /\btimeout\b/i.test(l) ||
          /\bexception\b/i.test(l)
      );

      if (!hasActualErrors) {
        spectreLog(
          '🔍 No actual errors detected in upload output - considering successful'
        );
        return { success: true, shouldRetry: false };
      }

      // Truly ambiguous - no clear indicators either way
      return {
        success: false,
        error: 'Upload result unclear - no success confirmation found',
      };
    };

    const isPortRelated = (err: string, shouldRetry?: boolean): boolean => {
      // If analyzer explicitly says retry, trust it
      if (shouldRetry === true) return true;
      if (shouldRetry === false) return false;

      // Fallback check for port-related issues
      const s = err.toLowerCase();
      return (
        s.includes('timeout') ||
        s.includes('busy') ||
        s.includes("can't open") ||
        s.includes('cannot open') ||
        s.includes('access denied') ||
        s.includes('permission denied') ||
        s.includes('in use') ||
        s.includes('semaphore') ||
        s.includes('handle is invalid')
      );
    };

    // Close Serial Monitor if connected to free the port; restore after
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
      // Small delay to ensure OS releases the port
      await this.delay(WIDGET_TIMING.COMPILATION_CHECK_DELAY);
    }

    const attemptUpload = async (): Promise<{
      ok: boolean;
      errText?: string;
      diff?: string;
      shouldRetry?: boolean;
    }> => {
      const before = await this.readArduinoOutputChannel();
      try {
        spectreLog('🚀 Starting upload command...');
        await this.commands.executeCommand('arduino-upload-sketch');
      } catch (e) {
        const msg = e?.message || String(e);
        return { ok: false, errText: msg, shouldRetry: false };
      }
      // Allow time for output to flush
      await this.delay(WIDGET_TIMING.COMPILATION_TIMEOUT);
      const after = await this.readArduinoOutputChannel();
      const diff = after.startsWith(before)
        ? after.slice(before.length)
        : after;

      const analysis = analyzeUploadOutput(diff);

      if (analysis.success) {
        return { ok: true, diff, shouldRetry: false };
      }

      // Give extra time for slow operations or delayed logs
      await this.delay(WIDGET_TIMING.UPLOAD_START_DELAY);
      const after2 = await this.readArduinoOutputChannel();
      const diff2 = after2.startsWith(before)
        ? after2.slice(before.length)
        : after2;

      const analysis2 = analyzeUploadOutput(diff2);

      if (analysis2.success) {
        return { ok: true, diff: diff2, shouldRetry: false };
      }

      // Additional check: if upload command executed without throwing an exception
      // and we don't have clear error indicators, consider it successful
      // This is common with Arduino uploads that succeed silently
      if (
        !analysis2.error?.includes('error') &&
        !analysis2.error?.includes('failed') &&
        !analysis2.error?.includes('timeout')
      ) {
        spectreLog(
          '🔍 No clear errors detected, upload command completed successfully - assuming success'
        );
        return { ok: true, diff: diff2, shouldRetry: false };
      }

      const finalError =
        analysis2.error || analysis.error || 'Upload failed with unclear error';
      const shouldRetry =
        analysis2.shouldRetry ?? analysis.shouldRetry ?? false;

      spectreLog('🔴 Upload failed:', finalError, 'shouldRetry:', shouldRetry);
      return { ok: false, errText: finalError, diff: diff2, shouldRetry };
    };

    // Initial attempt on currently selected port
    let attempt = await attemptUpload();
    if (attempt.ok) {
      if (restoreMonitor) {
        try {
          await this.monitorManagerProxy.startMonitor();
        } catch (err) {
          spectreWarn('Monitor restart failed after upload:', err);
        }
      }
      spectreLog('✅ Upload successful');
      return `✅ Sketch uploaded successfully to board: ${sketch.name}`;
    }

    const firstErr = attempt.errText || '';
    const shouldRetryPorts = attempt.shouldRetry;
    spectreLog(
      '🔴 Upload failed on current port:',
      firstErr,
      'shouldRetry:',
      shouldRetryPorts
    );

    // Only try alternate ports if the error is port-related
    if (shouldRetryPorts || isPortRelated(firstErr, attempt.shouldRetry)) {
      const cfg = this.boardsServiceProvider.boardsConfig;
      const currentPort = cfg.selectedPort;
      const detected = Object.values(
        this.boardsServiceProvider.detectedPorts || {}
      );
      // Prefer serial ports and those different from current
      const candidates = detected
        .filter(
          (dp): dp is DetectedPort =>
            !!dp?.port &&
            dp.port.protocol === 'serial' &&
            (!currentPort || dp.port.address !== currentPort.address)
        )
        // Stable order by address for determinism
        .sort((a: DetectedPort, b: DetectedPort) =>
          (a.port.address || '').localeCompare(b.port.address || '')
        );

      if (candidates.length === 0) {
        if (restoreMonitor) {
          try {
            await this.monitorManagerProxy.startMonitor();
          } catch (err) {
            spectreWarn('Monitor restart failed (no alternates):', err);
          }
        }
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

        attempt = await attemptUpload();
        if (attempt.ok) {
          if (restoreMonitor) {
            try {
              await this.monitorManagerProxy.startMonitor();
            } catch (err) {
              spectreWarn('Monitor restart failed (alternate port):', err);
            }
          }
          return `✅ Sketch uploaded successfully on alternate port ${addr}.`;
        }

        // If we get a non-port error, stop retrying other ports
        if (
          attempt.shouldRetry === false ||
          !isPortRelated(attempt.errText || '', attempt.shouldRetry)
        ) {
          spectreLog('🛑 Non-port error encountered, stopping port retries');
          break;
        }

        // Limit retries to 2 alternates to avoid long loops
        if (tried.length >= 2) break;
      }

      if (restoreMonitor) {
        try {
          await this.monitorManagerProxy.startMonitor();
        } catch (err) {
          spectreWarn('Monitor restart failed (all ports exhausted):', err);
        }
      }
      const triedMsg = tried.length ? ` Tried ports: ${tried.join(', ')}.` : '';
      throw new Error(
        `Upload failed on all available ports.${triedMsg}\n\nLast error: ${
          attempt.errText || firstErr
        }`
      );
    }

    // Not a port error or retries disabled - return the captured message
    if (restoreMonitor) {
      try {
        await this.monitorManagerProxy.startMonitor();
      } catch (err) {
        spectreWarn('Monitor restart failed (non-port error):', err);
      }
    }

    if (firstErr) {
      // Provide specific guidance based on error type and THROW instead of returning
      if (
        firstErr.toLowerCase().includes('compilation terminated') ||
        firstErr.toLowerCase().includes('syntax error')
      ) {
        throw new Error(
          `Upload failed due to compilation errors:\n\n${firstErr}\n\n💡 Please fix the code errors and try again.`
        );
      } else if (firstErr.toLowerCase().includes('sketch too big')) {
        throw new Error(
          `Upload failed: Sketch is too large for the selected board.\n\n${firstErr}\n\n💡 Try optimizing your code or selecting a board with more memory.`
        );
      } else if (firstErr.toLowerCase().includes('exit status 1')) {
        throw new Error(
          `Upload failed: programmer error occurred.\n\n${firstErr}\n\n💡 Check:\n• Board/port selection is correct\n• Device connection is stable\n• No other programs using the port`
        );
      } else {
        throw new Error(`Upload failed:\n\n${firstErr}`);
      }
    }
    throw new Error('Upload failed with unknown error.');
  }

  private async agentInstallLibrary(libraryName: string): Promise<string> {
    try {
      spectreLog(`📦 Installing Arduino library: ${libraryName}`);

      // Validate library name
      if (!libraryName || libraryName.trim().length === 0) {
        return '❌ Cannot install library: library name is empty';
      }

      // Use LibraryService to install the library through the backend
      try {
        spectreLog(`🔍 Searching for library: "${libraryName}"`);

        // Search for the library in the Arduino library index
        const searchResults = await this.libraryService.search({
          query: libraryName,
        });

        if (!searchResults || searchResults.length === 0) {
          return `❌ Library "${libraryName}" not found in Arduino Library Manager\n\n💡 Common fixes:\n• Check spelling (library names are case-sensitive)\n• Try searching: https://www.arduino.cc/reference/en/libraries/\n• Some libraries have different names (e.g., "Servo" not "ServoLibrary")`;
        }

        spectreLog(`📦 Found ${searchResults.length} search results`);

        // Build case-insensitive Map for O(1) lookup with validation
        const libraryMap = new Map<string, any>();
        for (const lib of searchResults) {
          if (lib && lib.name) {
            libraryMap.set(lib.name.toLowerCase(), lib);
          }
        }

        spectreLog(`📦 Built library map with ${libraryMap.size} entries`);

        // Fail-fast if all results were malformed
        if (libraryMap.size === 0) {
          spectreError(
            '❌ All search results were malformed (missing name property)'
          );
          return `❌ Library search returned invalid data for "${libraryName}"

💡 This is an internal error. Please try again or search manually in Library Manager.`;
        }

        let libraryPackage = libraryMap.get(libraryName.toLowerCase());
        if (!libraryPackage) {
          // If no exact match, use the first valid result from Map
          libraryPackage = libraryMap.values().next().value;
          spectreLog(
            `📦 Using best match: "${libraryPackage.name}" for query "${libraryName}"`
          );
        } else {
          spectreLog(`📦 Found exact match: "${libraryPackage.name}"`);
        }

        // Check if already installed
        if (libraryPackage.installedVersion) {
          spectreLog(
            `✅ Library "${libraryPackage.name}" is already installed (version ${libraryPackage.installedVersion})`
          );
          return `✅ Library "${libraryPackage.name}" is already installed (version ${libraryPackage.installedVersion})`;
        }

        // Get the version that will be installed
        const versionToInstall = libraryPackage.availableVersions[0];
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
      } catch (error: any) {
        spectreError('❌ Library installation error:', error);
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
    } catch (error) {
      spectreError('❌ Library installation error:', error);
      return `❌ Failed to install library: ${error.message || error}`;
    }
  }

  private async agentUninstallLibrary(libraryName: string): Promise<string> {
    try {
      spectreLog(`🗑️ Uninstalling Arduino library: ${libraryName}`);

      // Validate library name
      if (!libraryName || libraryName.trim().length === 0) {
        return '❌ Cannot uninstall library: library name is empty';
      }

      // Use LibraryService to uninstall the library through the backend
      try {
        spectreLog(`🔍 Searching for installed library: "${libraryName}"`);

        // Search for the library to get its package info
        const searchResults = await this.libraryService.search({
          query: libraryName,
        });

        if (!searchResults || searchResults.length === 0) {
          return `❌ Library "${libraryName}" not found in library index`;
        }

        // Build Map for O(1) case-insensitive lookup with validation
        const libraryMap = new Map<string, any>();
        for (const lib of searchResults) {
          if (lib && lib.name) {
            libraryMap.set(lib.name.toLowerCase(), lib);
          }
        }

        // Fail-fast if all results were malformed
        if (libraryMap.size === 0) {
          spectreError(
            '❌ All search results were malformed (missing name property)'
          );
          return `❌ Library search returned invalid data for "${libraryName}"

💡 This is an internal error. Please try searching manually in Library Manager.`;
        }

        let libraryPackage = libraryMap.get(libraryName.toLowerCase());
        if (!libraryPackage) {
          // If no exact match, use the first valid result from Map
          libraryPackage = libraryMap.values().next().value;
          spectreLog(
            `📦 Using best match: "${libraryPackage.name}" for query "${libraryName}"`
          );
        }

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
      } catch (error: any) {
        spectreError('❌ Library uninstallation error:', error);
        const errorMsg = error.message || String(error);

        // Check for common errors
        if (
          errorMsg.toLowerCase().includes('not found') ||
          errorMsg.toLowerCase().includes('not installed')
        ) {
          return `❌ Library "${libraryName}" is not installed or could not be found`;
        } else {
          return `❌ Failed to uninstall library "${libraryName}"\n\nError: ${errorMsg}`;
        }
      }
    } catch (error) {
      spectreError('❌ Library uninstallation error:', error);
      return `❌ Failed to uninstall library: ${error.message || error}`;
    }
  }

  /**
   * Add a board manager URL to Arduino preferences.
   * Required for installing 3rd-party board platforms.
   * @param url Board manager package index URL
   * @returns Promise resolving to user-friendly status message
   */
  private async agentAddBoardUrl(url: string): Promise<string> {
    if (!url || !url.trim()) {
      return '❌ Board manager URL is required';
    }

    try {
      spectreLog(`🔗 Adding board manager URL: ${url}`);

      // Get current configuration
      const currentConfig = await this.configService.getConfiguration();
      if (!currentConfig.config) {
        return `❌ Failed to read configuration`;
      }

      const currentUrls = currentConfig.config.additionalUrls || [];

      // Check if URL already exists
      const urlAlreadyExists = currentUrls.includes(url);

      if (!urlAlreadyExists) {
        // Add new URL
        const updatedUrls = [...currentUrls, url];

        // Save to configuration
        await this.configService.setConfiguration({
          ...currentConfig.config,
          additionalUrls: updatedUrls,
        });

        spectreLog('✅ Board manager URL added to preferences');
      } else {
        spectreLog(`ℹ️ Board manager URL already configured: ${url}`);
      }

      spectreLog('🔄 Updating package indexes (this may take a moment)...');

      // Always update package indexes to ensure fresh data
      try {
        await this.commands.executeCommand('arduino-update-package-index');
        spectreLog('✅ Package index update command completed');

        // Poll to check if new platforms are discoverable (up to 10 seconds)
        const maxWaitTime = 10000; // 10 seconds max
        const pollInterval = WIDGET_TIMING.PACKAGE_INDEX_POLL_INTERVAL;
        const startTime = Date.now();
        let indexReady = false;

        spectreLog('🔍 Checking if package index is ready...');

        while (Date.now() - startTime < maxWaitTime) {
          try {
            // Try to search for any platform to verify index is loaded
            const testSearch = await this.boardsService.search({ query: '' });
            if (testSearch && testSearch.length > 0) {
              indexReady = true;
              const elapsedMs = Date.now() - startTime;
              spectreLog(`✅ Package index ready (took ${elapsedMs}ms)`);
              break;
            }
          } catch (e) {
            // Index not ready yet, continue polling
          }

          await this.delay(pollInterval);
        }

        if (!indexReady) {
          spectreWarn('⚠️ Package index update timed out after 10 seconds');
          return urlAlreadyExists
            ? `✅ Board manager URL was already configured. Package index update initiated but may still be processing.

💡 Wait a moment before installing board platforms`
            : `✅ Added board manager URL. Package index update initiated but may still be processing.

💡 Wait a moment before installing board platforms`;
        }
      } catch (updateError) {
        spectreWarn('⚠️ Package index update failed:', updateError);
        return urlAlreadyExists
          ? `✅ Board manager URL was already configured, but package index update failed

💡 Try waiting a moment and then install the board platform`
          : `✅ Added board manager URL, but package index update failed

💡 The Board Manager will refresh automatically`;
      }

      // Extract board name from URL for better instructions
      const urlMatch = url.match(/package_([^_]+)_/);
      const boardName = urlMatch ? urlMatch[1] : 'the board';

      return urlAlreadyExists
        ? `✅ Board manager URL was already configured. Package index has been refreshed and is ready.

💡 **NEXT STEP:** Use <action type="search_boards" query="${boardName}" /> to find the exact platform ID`
        : `✅ Added board manager URL and updated package index. Ready to install platforms.

💡 **NEXT STEP:** Use <action type="search_boards" query="${boardName}" /> to find the exact platform ID`;
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
      spectreLog(`🗑️ Removing board manager URL: ${urlOrName}`);

      // Get current configuration
      const currentConfig = await this.configService.getConfiguration();
      if (!currentConfig.config) {
        return `❌ Failed to read configuration`;
      }

      const currentUrls = currentConfig.config.additionalUrls || [];

      if (currentUrls.length === 0) {
        return `ℹ️ No board manager URLs configured in preferences`;
      }

      // Try to find matching URL(s)
      let urlsToRemove: string[] = [];
      const searchTerm = urlOrName.toLowerCase().trim();

      // Check if it's an exact URL match first
      if (currentUrls.includes(urlOrName)) {
        urlsToRemove = [urlOrName];
      } else {
        // Try fuzzy matching by board name (case-insensitive, partial match)
        // e.g., "minicore", "MiniCore", "esp32", "ESP32" should match relevant URLs
        urlsToRemove = currentUrls.filter((url) =>
          url.toLowerCase().includes(searchTerm)
        );
      }

      if (urlsToRemove.length === 0) {
        return `ℹ️ No matching board manager URLs found for: "${urlOrName}"

Current URLs:
${currentUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}

💡 Tip: You can say "remove MiniCore" or "remove ESP32" to match by board name`;
      }

      // If multiple matches found, list them and remove all
      if (urlsToRemove.length > 1) {
        const updatedUrls = currentUrls.filter(
          (u) => !urlsToRemove.includes(u)
        );

        // Save to configuration
        await this.configService.setConfiguration({
          ...currentConfig.config,
          additionalUrls: updatedUrls,
        });

        spectreLog(
          `✅ Removed ${urlsToRemove.length} board manager URLs from preferences`
        );

        // Update package indexes
        spectreLog('🔄 Updating package indexes to reflect changes...');
        try {
          await this.commands.executeCommand('arduino-update-package-index');
          spectreLog('✅ Package index updated');
        } catch (updateError) {
          spectreWarn('⚠️ Package index update failed:', updateError);
        }

        return `✅ Removed ${
          urlsToRemove.length
        } board manager URLs matching "${urlOrName}":

${urlsToRemove.map((u, i) => `${i + 1}. ${u}`).join('\n')}

⚠️ Note: This only removes the URLs. Installed platforms remain until explicitly uninstalled.

Remaining URLs: ${updatedUrls.length}`;
      }

      // Single URL to remove
      const urlToRemove = urlsToRemove[0];
      const updatedUrls = currentUrls.filter((u) => u !== urlToRemove);

      // Save to configuration
      await this.configService.setConfiguration({
        ...currentConfig.config,
        additionalUrls: updatedUrls,
      });

      spectreLog('✅ Board manager URL removed from preferences');

      // Update package indexes
      spectreLog('🔄 Updating package indexes to reflect changes...');
      try {
        await this.commands.executeCommand('arduino-update-package-index');
        spectreLog('✅ Package index updated');
      } catch (updateError) {
        spectreWarn('⚠️ Package index update failed:', updateError);
      }

      return `✅ Removed board manager URL from preferences:
${urlToRemove}

⚠️ Note: This only removes the URL. Installed platforms remain until explicitly uninstalled.

Remaining URLs: ${updatedUrls.length}`;
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
      spectreLog(`🔍 Fetching board URLs for: ${query}`);

      // Fetch the wiki page
      const response = await fetch(wikiUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch wiki: ${response.status} ${response.statusText}`
        );
      }

      const wikiContent = await response.text();

      // Parse the markdown content to extract URLs
      // The wiki format is typically: "Board Name - URL" or "- [Board Name](URL)"
      const lines = wikiContent.split('\n');
      const matches: Array<{ name: string; url: string }> = [];

      const searchTerm = query.toLowerCase().trim();

      for (const line of lines) {
        const lowerLine = line.toLowerCase();

        // Skip if line doesn't contain search term
        if (!lowerLine.includes(searchTerm)) {
          continue;
        }

        // Extract URLs from the line (match http/https URLs ending in .json)
        const urlMatch = line.match(/(https?:\/\/[^\s\)]+\.json)/i);
        if (urlMatch) {
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

          matches.push({ name, url });
        }
      }

      if (matches.length === 0) {
        return `❌ No board manager URLs found for "${query}"

💡 Try searching with a different term or check the Arduino Wiki manually:
https://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls`;
      }

      // Format the results
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
  private async agentInstallBoard(
    platformId: string,
    version?: string
  ): Promise<string> {
    if (!platformId || !platformId.trim()) {
      return '❌ Platform ID is required for board installation';
    }

    // Validate platform ID format
    const parts = platformId.split(':');
    if (parts.length !== 2) {
      return `❌ Invalid platform ID format: "${platformId}"

💡 Expected format: "vendor:architecture" (e.g., "vendor:arch")`;
    }

    try {
      const versionStr = version ? `@${version}` : ' (latest)';
      spectreLog(`📦 Installing board platform: ${platformId}${versionStr}`);

      // Search for the platform
      const searchResults = await this.boardsService.search({
        query: platformId,
      });

      if (!searchResults || searchResults.length === 0) {
        return `❌ Board platform "${platformId}" not found in Board Manager

💡 Common fixes:
• Run the ADD_BOARD_URL action first to add the board manager URL
• Wait a moment for the package index to download
• Check platform ID spelling (case-sensitive, usually format: "vendor:arch")
• Verify the board manager URL is correct

Try asking: "Add the board manager URL for [board name]"`;
      }

      spectreLog(
        `🔍 Found ${searchResults.length} search results for "${platformId}"`
      );
      searchResults.forEach((pkg) => spectreLog(`  - ${pkg.id} (${pkg.name})`));

      // Build Maps for O(1) exact and case-insensitive lookups with validation
      const exactMap = new Map<string, any>();
      const caseInsensitiveMap = new Map<string, any>();
      for (const pkg of searchResults) {
        if (pkg && pkg.id) {
          exactMap.set(pkg.id, pkg);
          caseInsensitiveMap.set(pkg.id.toLowerCase(), pkg);
        }
      }

      spectreLog(`📦 Built platform maps: ${exactMap.size} entries`);

      // Fail-fast if all results were malformed
      if (exactMap.size === 0) {
        spectreError(
          '❌ All search results were malformed (missing id property)'
        );
        return `❌ Platform search returned invalid data for "${platformId}"

💡 This is an internal error. Please try searching manually in Board Manager.`;
      }

      // Find exact match first, then case-insensitive
      let platform = exactMap.get(platformId);

      if (!platform) {
        // Try case-insensitive match
        platform = caseInsensitiveMap.get(platformId.toLowerCase());
      }

      if (!platform) {
        // Try partial match as last resort (this one needs linear search)
        platform = searchResults.find((pkg) =>
          pkg.id.toLowerCase().includes(platformId.toLowerCase())
        );
      }

      if (!platform) {
        const suggestions = searchResults
          .slice(0, 3)
          .map((p) => `${p.id} (${p.name})`)
          .join('\n• ');
        return `❌ Platform "${platformId}" not found

Found these similar platforms:
• ${suggestions}

💡 Use the exact platform ID shown above`;
      }

      // Check if already installed
      if (platform.installedVersion) {
        const installedVersion = platform.installedVersion;
        if (version && installedVersion !== version) {
          spectreLog(
            `ℹ️ Platform already installed with different version: ${installedVersion}, requested: ${version}`
          );
          return `ℹ️ Platform "${platform.name}" is already installed with version ${installedVersion}

💡 To install version ${version}, uninstall the current version first from Board Manager`;
        } else {
          return `✅ Platform "${platform.name}" already installed (version ${installedVersion})`;
        }
      }

      // Determine version to install
      const versionToInstall = version || platform.availableVersions[0];

      if (!versionToInstall) {
        return `❌ No versions available for platform "${platformId}"`;
      }

      spectreLog(`📦 Installing ${platform.name}@${versionToInstall}`);

      // Install the platform using BoardsService
      await this.boardsService.install({
        item: platform,
        version: versionToInstall,
        skipPostInstall: false,
      });

      // Write confirmation to Output panel
      const outputChannel = this.outputChannels.getChannel('Arduino');
      outputChannel.appendLine(
        `Installed ${platform.name}@${versionToInstall}`
      );

      spectreLog(
        `✅ Platform "${platform.name}" version ${versionToInstall} installed successfully`
      );
      return `✅ Platform "${platform.name}" version ${versionToInstall} installed successfully`;
    } catch (error) {
      spectreError(`❌ Failed to install platform "${platformId}":`, error);

      if (error instanceof Error) {
        if (
          error.message.includes('not found') ||
          error.message.includes('404')
        ) {
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
    if (!platformId || !platformId.trim()) {
      return '❌ Platform ID is required for board uninstallation';
    }

    // Validate platform ID format
    const parts = platformId.split(':');
    if (parts.length !== 2) {
      return `❌ Invalid platform ID format: "${platformId}"

💡 Expected format: "vendor:architecture" (e.g., "esp32:esp32", "MiniCore:avr")`;
    }

    try {
      spectreLog(`🗑️ Uninstalling board platform: ${platformId}`);

      // Search for the platform to get its full details
      const searchResults = await this.boardsService.search({
        query: platformId,
      });

      if (!searchResults || searchResults.length === 0) {
        return `❌ Board platform "${platformId}" not found in Board Manager

💡 Check platform ID spelling (case-sensitive)`;
      }

      // Build Maps for O(1) lookups with validation
      const exactMap = new Map<string, any>();
      const caseInsensitiveMap = new Map<string, any>();
      for (const pkg of searchResults) {
        if (pkg && pkg.id) {
          exactMap.set(pkg.id, pkg);
          caseInsensitiveMap.set(pkg.id.toLowerCase(), pkg);
        }
      }

      // Fail-fast if all results were malformed
      if (exactMap.size === 0) {
        spectreError(
          '❌ All search results were malformed (missing id property)'
        );
        return `❌ Platform search returned invalid data for "${platformId}"

💡 This is an internal error. Please try searching manually in Board Manager.`;
      }

      // Find exact match first, then case-insensitive, then partial
      let platform = exactMap.get(platformId);

      if (!platform) {
        platform = caseInsensitiveMap.get(platformId.toLowerCase());
      }

      if (!platform) {
        // Partial match as last resort
        platform = searchResults.find((pkg) =>
          pkg.id.toLowerCase().includes(platformId.toLowerCase())
        );
      }

      if (!platform) {
        const suggestions = searchResults
          .slice(0, 3)
          .map((p) => `${p.id} (${p.name})`)
          .join('\n• ');
        return `❌ Platform "${platformId}" not found

Found these similar platforms:
• ${suggestions}

💡 Use the exact platform ID shown above`;
      }

      // Check if actually installed
      if (!platform.installedVersion) {
        return `ℹ️ Platform "${platform.name}" is not installed

💡 Nothing to uninstall`;
      }

      const installedVersion = platform.installedVersion;
      spectreLog(`🗑️ Uninstalling ${platform.name}@${installedVersion}`);

      // Uninstall the platform using BoardsService
      await this.boardsService.uninstall({
        item: platform,
      });

      // Write confirmation to Output panel
      const outputChannel = this.outputChannels.getChannel('Arduino');
      outputChannel.appendLine(
        `Uninstalled ${platform.name}@${installedVersion}`
      );

      spectreLog(
        `✅ Platform "${platform.name}" version ${installedVersion} uninstalled successfully`
      );
      return `✅ Platform "${platform.name}" version ${installedVersion} uninstalled successfully`;
    } catch (error) {
      spectreError(`❌ Failed to uninstall platform "${platformId}":`, error);

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

      let editor = await this.editorManager.open(uri);

      // If editor is not available, wait and try again with longer timeout
      if (!editor) {
        spectreLog('⏳ Editor not ready, waiting longer...');
        await this.delay(WIDGET_TIMING.SERVICE_READY_WAIT);
        editor = await this.editorManager.open(uri);
      }

      if (editor) {
        // Wait for the editor to be fully initialized
        await this.delay(WIDGET_TIMING.PORT_SELECTION_DELAY);

        const monacoEditor = editor.editor;
        if ('getControl' in monacoEditor) {
          const control = (monacoEditor as any).getControl();
          const model = control.getModel();
          if (model) {
            // Capture old code before modification
            const oldCode = model.getValue();

            if (oldCode !== content) {
              await this.showInlineDiff(uri, filePath, oldCode, content);
              return `✅ Applied changes to: ${filePath}\n\n💡 Click "Keep" to accept or "Undo" to revert`;
            }

            // No changes needed
            return `✅ Code is already up to date: ${filePath}`;
          }
        }
        return '❌ Could not access Monaco editor model - editor may not be fully loaded';
      } else {
        return '❌ Could not open file in editor - please ensure the sketch is open and try pasting the code manually';
      }
    } catch (error) {
      spectreError('Sketch modification error:', error);
      return `❌ Failed to modify sketch content: ${error.message || error}`;
    }
  }

  /**
   * Shows inline diff editor like VS Code with Keep/Undo buttons
   * Shows removed lines inline (red, no line numbers) above added lines (green, with numbers)
   */
  private async showInlineDiff(
    uri: any,
    filePath: string,
    oldCode: string,
    newCode: string
  ): Promise<void> {
    try {
      // Get the current editor
      const editor = await this.editorManager.open(uri);
      if (!editor) {
        spectreError('Could not open editor');
        return;
      }

      const monacoEditor = editor.editor;
      if (!('getControl' in monacoEditor)) {
        spectreError('Not a Monaco editor');
        return;
      }

      const control = (monacoEditor as any).getControl();
      const model = control.getModel();
      if (!model) {
        spectreError('No model found');
        return;
      }

      // Compute diff to find changed lines
      const oldLines = oldCode.split('\n');
      const newLines = newCode.split('\n');

      // Apply the new content first
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

      // Now add decorations to show the diff
      const decorations: any[] = [];
      const contentWidgets: any[] = [];

      let oldIdx = 0;
      let newIdx = 0;

      while (oldIdx < oldLines.length || newIdx < newLines.length) {
        if (oldIdx >= oldLines.length) {
          // Remaining lines are additions (green)
          decorations.push({
            range: {
              startLineNumber: newIdx + 1,
              startColumn: 1,
              endLineNumber: newIdx + 1,
              endColumn: 1000,
            },
            options: {
              isWholeLine: true,
              className: 'spectre-diff-line-added',
              glyphMarginClassName: 'spectre-diff-glyph-add',
            },
          });
          newIdx++;
        } else if (newIdx >= newLines.length) {
          // Skip remaining old lines (already gone)
          oldIdx++;
        } else if (oldLines[oldIdx] === newLines[newIdx]) {
          // Lines match - no decoration
          oldIdx++;
          newIdx++;
        } else {
          // Lines differ - show removed line above added line
          let foundMatch = false;

          // Check if old line was deleted
          for (
            let lookahead = 1;
            lookahead <= 3 && newIdx + lookahead < newLines.length;
            lookahead++
          ) {
            if (oldLines[oldIdx] === newLines[newIdx + lookahead]) {
              // Old line found later - lines were added
              for (let i = 0; i < lookahead; i++) {
                decorations.push({
                  range: {
                    startLineNumber: newIdx + i + 1,
                    startColumn: 1,
                    endLineNumber: newIdx + i + 1,
                    endColumn: 1000,
                  },
                  options: {
                    isWholeLine: true,
                    className: 'spectre-diff-line-added',
                    glyphMarginClassName: 'spectre-diff-glyph-add',
                  },
                });
              }
              newIdx += lookahead;
              foundMatch = true;
              break;
            }
          }

          if (!foundMatch) {
            // Check if new line was added
            for (
              let lookahead = 1;
              lookahead <= 3 && oldIdx + lookahead < oldLines.length;
              lookahead++
            ) {
              if (newLines[newIdx] === oldLines[oldIdx + lookahead]) {
                // Show removed lines as content widgets above current line
                for (let i = 0; i < lookahead; i++) {
                  const removedLine = oldLines[oldIdx + i];
                  contentWidgets.push({
                    lineNumber: newIdx + 1,
                    text: removedLine,
                  });
                }
                oldIdx += lookahead;
                foundMatch = true;
                break;
              }
            }
          }

          if (!foundMatch) {
            // Direct replacement
            contentWidgets.push({
              lineNumber: newIdx + 1,
              text: oldLines[oldIdx],
            });
            decorations.push({
              range: {
                startLineNumber: newIdx + 1,
                startColumn: 1,
                endLineNumber: newIdx + 1,
                endColumn: 1000,
              },
              options: {
                isWholeLine: true,
                className: 'spectre-diff-line-added',
                glyphMarginClassName: 'spectre-diff-glyph-add',
              },
            });
            oldIdx++;
            newIdx++;
          }
        }
      }

      // Apply decorations for added lines (green)
      const decorationIds = control.deltaDecorations([], decorations);

      // Use Monaco's ViewZones API for removed lines
      const zoneIds: string[] = [];

      control.changeViewZones((changeAccessor: any) => {
        for (const widget of contentWidgets) {
          try {
            // Create DOM node for the removed line
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

            // Add view zone (like VS Code's inline diff)
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

      control.pushUndoStop();
      control.focus();

      // Auto-remove decorations and view zones after 30 seconds
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
    } catch (error) {
      spectreError('Error showing inline diff:', error);
      // Fallback
      const editor = await this.editorManager.open(uri);
      if (editor) {
        const monacoEditor = editor.editor;
        if ('getControl' in monacoEditor) {
          const control = (monacoEditor as any).getControl();
          const model = control.getModel();
          if (model) {
            this.applySimpleEdit(control, model, newCode);
          }
        }
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

    // Build cache if needed
    if (!this.isBoardCacheValid()) {
      this.buildBoardCache(boards);
    }

    // Split input into words (normalize once)
    const inputWords = inputName
      .toLowerCase()
      .split(/[\s\-_]+/)
      .filter((w: string) => w.length >= 2);
    spectreLog('Input words:', inputWords);

    // Try exact matching first (no typos) - using cached normalized data
    for (const cached of this.boardSearchCache!.values()) {
      // Check if ALL input words are in this board name (exact)
      const allWordsMatch = inputWords.every((inputWord: string) => {
        return cached.normalizedName.includes(inputWord);
      });

      if (allWordsMatch) {
        spectreLog('✅ EXACT MATCH:', cached.board.name);
        spectreLog('   FQBN:', cached.board.fqbn);
        return cached.board;
      }
    }

    spectreLog('⚠️ No exact match, trying fuzzy matching...');

    // Try fuzzy matching (allows 1-2 character differences per word)
    for (const cached of this.boardSearchCache!.values()) {
      // Check if ALL input words have a close match in board name
      const allWordsFuzzyMatch = inputWords.every((inputWord: string) => {
        // Try exact match first
        if (cached.normalizedName.includes(inputWord)) return true;

        // Try fuzzy match against each cached board word
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

    spectreLog('❌ No board found (tried exact and fuzzy matching)');
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

      // Wait for boards service to be ready
      await this.boardsServiceProvider.ready;

      // Get ALL installed boards
      const installedBoards = await this.boardsService.getInstalledBoards();
      const allBoards = installedBoards.filter(
        (board: any) => board.fqbn && board.name
      );

      // Find the board by name matching
      const normalizedInput = input.toLowerCase().trim();
      const matchedBoard = this.findBoardByName(normalizedInput, allBoards);

      if (!matchedBoard) {
        return `❌ Board not found: "${input}". Check installed boards in Tools → Board menu.`;
      }

      spectreLog('✅ MATCHED BOARD:', matchedBoard.name);
      spectreLog('✅ FQBN:', matchedBoard.fqbn);

      // Check if this board is already selected
      let currentConfig = this.boardsServiceProvider.boardsConfig;
      if (currentConfig?.selectedBoard?.fqbn === matchedBoard.fqbn) {
        spectreLog('✅ Board is already selected');
        return `✅ Board already selected: ${matchedBoard.name} (${matchedBoard.fqbn}). No action needed - board configuration is ready.`;
      }

      // Select the board using its FQBN
      this.boardsServiceProvider.updateConfig({
        name: matchedBoard.name,
        fqbn: matchedBoard.fqbn,
      });

      // Wait for selection to propagate
      await this.delay(WIDGET_TIMING.BOARD_SELECTION_DELAY);

      // Validate selection
      currentConfig = this.boardsServiceProvider.boardsConfig;
      if (currentConfig?.selectedBoard?.fqbn === matchedBoard.fqbn) {
        spectreLog('✅ BOARD SELECTED SUCCESSFULLY');
        return `✅ Board selected: ${matchedBoard.name} (${matchedBoard.fqbn})`;
      } else {
        spectreWarn('⚠️ Selection validation failed');
        return `⚠️ Board selected but validation failed: ${matchedBoard.name}`;
      }
    } catch (error) {
      spectreError('❌ Board selection error:', error);
      return `❌ Failed to select board: ${error.message || error}`;
    }
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
    } catch (error) {
      spectreError('❌ Port selection error:', error);
      return `❌ Failed to select port: ${error.message || error}`;
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
    } catch (error) {
      return `❌ Failed to get board list: ${error.message || error}`;
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
    } catch (error) {
      spectreError('❌ Port listing error:', error);
      return `❌ Failed to list ports: ${error.message || error}`;
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
    } catch (error) {
      spectreError('❌ Board config error:', error);
      return `❌ Failed to get board configuration: ${error.message || error}`;
    }
  }

  private async agentSetBoardConfig(
    fqbn: string | undefined,
    options: string
  ): Promise<string> {
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

      spectreLog('🔧 Setting board configuration:', targetFqbn, options);

      // Parse the options string (format: "option1=value1,option2=value2")
      const optionsToUpdate = options.split(',').map((opt) => {
        const [option, selectedValue] = opt.trim().split('=');
        if (!option || !selectedValue) {
          throw new Error(
            `Invalid option format: "${opt}". Use format: option=value`
          );
        }
        return { option: option.trim(), selectedValue: selectedValue.trim() };
      });

      // Apply the configuration changes
      const success = await this.boardsDataStore.selectConfigOption({
        fqbn: targetFqbn,
        optionsToUpdate,
      });

      if (!success) {
        return `❌ Failed to update board configuration. Please check that the options exist and values are valid.`;
      }

      // Get the updated FQBN with configuration options
      const updatedFqbn = await this.boardsDataStore.appendConfigToFqbn(
        targetFqbn
      );

      // Update the board selection with the new configuration
      if (updatedFqbn) {
        // Get the proper board name from board details or search results
        let boardName =
          this.boardsServiceProvider.boardsConfig.selectedBoard?.name;

        if (!boardName || boardName === 'Unknown') {
          // Try to get the board name from board details
          try {
            const boardDetails = await this.boardsService.getBoardDetails({
              fqbn: targetFqbn,
            });
            if (boardDetails) {
              // Try to find the board name from search results
              // Search using the board ID part of FQBN, handling any FQBN format
              const searchParts = targetFqbn.split(':');
              const searchTerm =
                searchParts.length >= 3 ? searchParts[2] : targetFqbn;
              const searchResults = await this.boardsService.searchBoards({
                query: searchTerm,
              });
              const platformPrefix = searchParts
                .slice(0, Math.min(3, searchParts.length))
                .join(':');
              const matchingBoard = searchResults.find(
                (b: any) =>
                  b.fqbn === targetFqbn || b.fqbn?.startsWith(platformPrefix)
              );
              // Try to extract a meaningful name from FQBN or use board name
              const fqbnParts = targetFqbn.split(':');
              const boardId =
                fqbnParts.length >= 3
                  ? fqbnParts[2]
                  : fqbnParts[fqbnParts.length - 1];
              boardName = matchingBoard?.name || boardId || 'Platform Board';
            }
          } catch (e) {
            spectreWarn('Could not get board details for name resolution:', e);
            // Extract a meaningful name from FQBN without assuming structure
            const fqbnParts = targetFqbn.split(':');
            const boardId =
              fqbnParts.length >= 3
                ? fqbnParts[2]
                : fqbnParts[fqbnParts.length - 1];
            boardName = boardId || 'Platform Board';
          }
        }

        this.boardsServiceProvider.updateConfig({
          name: boardName || 'Platform Board',
          fqbn: updatedFqbn,
        });
      }

      const optionsText = optionsToUpdate
        .map((o) => `${o.option}=${o.selectedValue}`)
        .join(', ');
      return `✅ Board configuration updated: ${optionsText}\n\nFull FQBN: ${
        updatedFqbn || targetFqbn
      }`;
    } catch (error) {
      spectreError('❌ Board config update error:', error);
      return `❌ Failed to set board configuration: ${error.message || error}`;
    }
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
  private focusInput(): void {
    const tryFocus = () => {
      const input = this.inputRef;
      if (input && !input.disabled && input.offsetParent !== null) {
        input.focus();
        // Place caret at end
        try {
          input.selectionStart = input.selectionEnd = input.value.length;
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

  /**
   * Extracts Arduino code from text (looks for code blocks or detects Arduino patterns)
   */
  private extractArduinoCode(
    text: string
  ): Array<{ code: string; type: 'block' | 'inline'; language?: string }> {
    const codeBlocks: Array<{
      code: string;
      type: 'block' | 'inline';
      language?: string;
    }> = [];

    // First, try to find explicit code blocks (```cpp, ```c, ```arduino, ```ino, or plain ```)
    const codeBlockRegex = /```(?:(cpp|c|arduino|ino))?\n?([\s\S]*?)\n?```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const language = match[1] || 'arduino';
      const code = match[2].trim();
      if (
        code &&
        (language.match(/^(cpp|c|arduino|ino)$/) ||
          this.containsArduinoCode(code))
      ) {
        codeBlocks.push({ code, type: 'block', language });
      }
    }

    // If we found code blocks, return them
    if (codeBlocks.length > 0) {
      return codeBlocks;
    }

    // If no explicit code blocks, try to extract code from the entire text
    if (!this.containsArduinoCode(text)) {
      return [];
    }

    // Try to intelligently extract code sections from mixed text
    const lines = text.split('\n');
    const codeLines: string[] = [];
    let inCodeSection = false;
    let codeStarted = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Strong indicators this is a code line
      const isCodeLine =
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
        /^\s*\w+\s*=/.test(line);

      // Check if this looks like explanatory text
      const isExplanation =
        trimmed.length > 0 &&
        /^[A-Z]/.test(trimmed) &&
        !isCodeLine &&
        !trimmed.startsWith('#') &&
        trimmed.includes(' ') &&
        trimmed.split(' ').length > 3;

      if (isCodeLine) {
        inCodeSection = true;
        codeStarted = true;
        codeLines.push(line);
      } else if (
        inCodeSection &&
        (trimmed === '' || trimmed.startsWith('*') || trimmed.startsWith('//'))
      ) {
        // Continue section for empty lines or comments
        codeLines.push(line);
      } else if (isExplanation && codeStarted) {
        // Stop at explanatory text after we've found code
        inCodeSection = false;
      } else if (inCodeSection && !isExplanation) {
        // Continue if it's not clearly explanatory text
        codeLines.push(line);
      } else {
        inCodeSection = false;
      }
    }

    // Clean up the extracted code
    if (codeLines.length > 3) {
      let cleanCode = codeLines.join('\n').trim();

      // Remove leading/trailing empty lines
      cleanCode = cleanCode.replace(/^\n+|\n+$/g, '');

      if (cleanCode && this.containsArduinoCode(cleanCode)) {
        codeBlocks.push({ code: cleanCode, type: 'inline' });
      }
    }

    return codeBlocks;
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
      }

      // Fallback: copy to clipboard and focus editor
      spectreWarn(
        'Could not access Monaco editor directly, falling back to clipboard'
      );
      const success = await this.copyToClipboard(code);
      if (success) {
        textEditor.focus();
      }
      return success;
    } catch (error) {
      spectreWarn(
        'Failed to paste to editor, falling back to clipboard:',
        error
      );
      // Fallback: copy to clipboard and focus editor
      const success = await this.copyToClipboard(code);
      if (success) {
        const editor = this.editorManager.currentEditor;
        if (editor && editor.editor) {
          editor.editor.focus();
        }
      }
      return success;
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
    // Find code block positions in the original text
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
        parts.push(
          <div key={`text-${blockIndex}`} style={{ marginBottom: '8px' }}>
            {ReactMarkdownLazy && ReactMarkdownLazy !== null ? (
              <ReactMarkdownLazy>{beforeCode}</ReactMarkdownLazy>
            ) : (
              <pre>{beforeCode}</pre>
            )}
          </div>
        );
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

    // If no explicit code blocks were found, render inline code blocks
    if (parts.length === 0 && codeBlocks.length > 0) {
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
    const model = this.prefs['arduino.spectre.model'] || '';
    if (
      model.toLowerCase().includes('flash') &&
      !model.toLowerCase().includes('lite')
    ) {
      return 100000; // Gemini 2.5 Flash
    } else if (model.toLowerCase().includes('lite')) {
      return 66000; // Gemini 2.5 Flash Lite (rounded down for safety)
    }
    return 50000; // Default fallback for unknown models
  }

  /**
   * Gets the RPM (requests per minute) limit based on the selected model.
   */
  private getRpmLimit(): number {
    const model = this.prefs['arduino.spectre.model'] || '';
    if (
      model.toLowerCase().includes('flash') &&
      !model.toLowerCase().includes('lite')
    ) {
      return 10; // Gemini 2.5 Flash: 10 requests/min
    } else if (model.toLowerCase().includes('lite')) {
      return 15; // Gemini 2.5 Flash Lite: 15 requests/min
    }
    return 10; // Default fallback
  }

  /**
   * Sends a message using the new function calling approach (agent mode).
   * Implements ReAct loop: Think → Act → Observe → Repeat
   */
  private async sendMessageWithFunctionCalling(
    text: string,
    requestSeq: number,
    abortKey: string,
    model: string,
    sketchFiles: Array<{ path: string; content: string }>
  ): Promise<void> {
    const MAX_ITERATIONS = 10;
    let iteration = 0;

    // Build initial context
    const contextParts: string[] = [];
    contextParts.push(
      `Here are my current Arduino sketch files:\n\n${
        sketchFiles.length > 0
          ? sketchFiles
              .map(
                (file) =>
                  `**${file.path}:**\n\`\`\`${this.getFileLanguage(
                    file.path
                  )}\n${file.content}\n\`\`\``
              )
              .join('\n\n')
          : 'No Arduino sketch is currently open in the IDE.'
      }`
    );
    const contextualPrompt =
      contextParts.length > 0
        ? `${contextParts.join('\n\n')}\n\n**User request:** ${text}`
        : text;

    // Initialize conversation history using new memory system
    const conversationHistory: Array<{
      role: 'user' | 'model' | 'function';
      text?: string;
      name?: string;
      response?: any;
    }> = [];

    // Get session and ensure memory is initialized
    const session = this.stateData.sessions[this.stateData.active];
    if (session) {
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
      this.saveSessionMemory(session.id); // Persist memory after adding user message
      this.updateMemoryStats();

      // Build conversation history from memory system
      // INCREASED: Taking advantage of Gemini 2.5's 1M context window
      const isFlashLite = model === 'gemini-2.5-flash-lite';
      const targetBudget = isFlashLite ? 30_000 : 50_000; // Increased from 16k/25k

      const sketchContext =
        sketchFiles.length > 0
          ? sketchFiles
              .map(
                (file) =>
                  `**${file.path}:**\n\`\`\`${this.getFileLanguage(
                    file.path
                  )}\n${file.content}\n\`\`\``
              )
              .join('\n\n')
          : '';

      const { prompt: _prompt, tokenCount } = this.memoryManager.assemblePrompt(
        session.memory,
        {
          currentPrompt: text,
          additionalContext: sketchContext,
          targetTokenBudget: targetBudget,
        }
      );

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

      // Build conversation history properly for Gemini API
      // FIXED: Summaries should be treated as historical context, not as direct user messages
      if (session.memory.memoryBank.summaries.length > 0) {
        const historicalContext = session.memory.memoryBank.summaries
          .map((s) => s.summary)
          .join('\n\n---\n\n');

        // Add as a single user message with clear labeling
        conversationHistory.push({
          role: 'user',
          text: `[HISTORICAL CONTEXT FROM PREVIOUS CONVERSATION]:\n${historicalContext}\n\n---\n\n[CURRENT SESSION CONTINUES BELOW]`,
        });

        // Add model acknowledgment to establish context separation
        conversationHistory.push({
          role: 'model',
          text: 'I understand the historical context. Ready to continue our conversation.',
        });
      }

      // Add recent messages (excluding the current one we just added)
      const recentMessages = session.memory.recentMessages.slice(0, -1);
      for (const msg of recentMessages) {
        conversationHistory.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          text: msg.text,
        });
      }

      // Add current user message with full context
      conversationHistory.push({ role: 'user', text: contextualPrompt });

      // Log conversation structure for debugging
      spectreLog(
        `💬 [Agent Mode] Conversation history: ${conversationHistory.length} messages (${session.memory.memoryBank.summaries.length} summaries, ${recentMessages.length} recent)`
      );
    } else {
      // Fallback: no session context
      conversationHistory.push({ role: 'user', text: contextualPrompt });
    }

    // Create initial assistant message without noisy headers
    // Users will see task updates and function results instead
    await this.appendAssistant('', requestSeq);

    // Loop detection using circular buffer and hash-based tracking
    interface ActionRecord {
      signature: string;
      normalizedSignature: string; // For semantic similarity detection
      timestamp: number;
      functionName: string;
      args: any;
      result?: { success: boolean; error?: string }; // Track results for failure detection
    }

    const actionHistory: ActionRecord[] = [];
    const LOOP_DETECTION_WINDOW = 5; // Track last N actions
    const MAX_IDENTICAL_ACTIONS = 1; // STOP IMMEDIATELY on first repetition (was 2)

    /**
     * Normalize function arguments for better semantic similarity detection.
     * Handles case differences, whitespace, and common variations.
     */
    const normalizeArgs = (name: string, args: any): any => {
      const normalized: any = {};

      for (const key in args) {
        let value = args[key];

        // Normalize string values
        if (typeof value === 'string') {
          value = value.toLowerCase().trim().replace(/\s+/g, ' ');

          // Function-specific normalization
          if (name === 'select_board' || name === 'search_boards') {
            // Remove "Arduino" prefix and normalize board names
            value = value.replace(/^arduino\s+/i, '').trim();
          } else if (
            name === 'install_library' ||
            name === 'uninstall_library'
          ) {
            // Library names: case-insensitive, no extra whitespace
            value = value.trim();
          } else if (name === 'select_port') {
            // Port addresses: normalize format
            value = value.trim();
          }
        }

        normalized[key] = value;
      }

      return normalized;
    };

    /**
     * Loop detection with semantic similarity and failure tracking.
     * Detects:
     * 1. Identical actions (exact match)
     * 2. Semantically similar actions (normalized match)
     * 3. Repeated failures (same function failing multiple times)
     *
     * Returns ActionRecord if loop detected, null otherwise.
     */
    const detectLoop = (
      functionCalls: Array<{ name: string; args: any }>
    ): ActionRecord | null => {
      // Create both exact and normalized signatures
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

      const record: ActionRecord = {
        signature: exactSig,
        normalizedSignature: normalizedSig,
        timestamp: Date.now(),
        functionName: functionCalls[0]?.name || 'unknown',
        args: functionCalls[0]?.args || {},
      };

      // Add to history with sliding window
      actionHistory.push(record);
      if (actionHistory.length > LOOP_DETECTION_WINDOW) {
        actionHistory.shift();
      }

      // Check 1: Repeated failures (same function failed 3+ times)
      const functionName = functionCalls[0]?.name;
      if (functionName) {
        const recentFailures = actionHistory
          .slice(-5) // Last 5 actions
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

      // Check 2: Count normalized signature occurrences
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

      // Check 3: Exact signature match (original behavior)
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

    // Track error state for finally block
    let agentError: any = null;

    try {
      // ReAct Loop: Think → Act → Observe → Repeat
      while (iteration < MAX_ITERATIONS) {
        iteration++;

        spectreLog(
          `🤖 Agent Iteration ${iteration}/${MAX_ITERATIONS} starting...`
        );

        if (requestSeq !== this.stateData.requestSeq) {
          spectreLog('🤖 Agent loop canceled by user');
          break; // Request was canceled
        }

        // Log iteration internally but don't show to users
        // Users see task progress and function results instead of iteration counts

        try {
          // CRITICAL FIX FOR LOOP ISSUE:
          // After first iteration, the AI should continue from conversation history
          // without repeating the original user request. Repeating the request makes
          // the AI think the user wants it done again, causing infinite loops.
          const currentPrompt =
            iteration === 1
              ? text // First iteration: use original user request
              : 'Continue with the next step based on the function results above. If all tasks are complete, respond with confirmation and no function calls.'; // Subsequent iterations: continuation instruction

          const response = await this.ai.generate({
            prompt: currentPrompt,
            model: model as any,
            enableAgentMode: true, // Enable function calling
            context: {
              conversation: conversationHistory.map((m) => {
                // Convert function responses to Gemini's expected format
                if (m.role === 'function') {
                  return {
                    role: 'function' as const,
                    parts: [
                      {
                        functionResponse: {
                          name: m.name!,
                          response: m.response,
                        },
                      },
                    ],
                  };
                }
                // Regular user/model messages
                return {
                  role: m.role as 'user' | 'model',
                  text: m.text || '',
                };
              }) as any, // Type assertion needed for union type
            },
            generationConfig: {
              maxOutputTokens: 65536,
              // Temperature dynamically set by backend based on mode and model
              topP: 0.9,
            },
            abortKey,
          });

          // Add AI's response to conversation and display
          if (response.text) {
            conversationHistory.push({ role: 'model', text: response.text });

            // Clean up the response for display: remove internal markers
            let cleanText = response.text;

            // Remove agent mode headers (users see agent badge instead)
            cleanText = cleanText.replace(
              /^##?\s*🤖\s*Agent Mode\s*\n*/gim,
              ''
            );

            // Remove iteration markers (internal debugging only)
            cleanText = cleanText.replace(
              /^###?\s*🔄\s*Iteration\s+\d+\/\d+\s*\n*/gim,
              ''
            );

            // Remove "analyzing" messages (show actual results instead)
            cleanText = cleanText.replace(
              /^\*Analyzing your request.*?\*\s*\n*/gim,
              ''
            );

            // Don't echo whole code back: Users see code in editor, not chat
            // Remove large code blocks from agent responses
            cleanText = this.suppressRedundantCodeBlocks(cleanText);

            // Extract task list to panel, remove from message
            // Tasks go in sidebar panel, not chat
            cleanText = this.extractTasksToPanel(cleanText, response.text);

            // Show thinking process summary if available (Claude-style transparency)
            if (
              response.meta?.thoughtsTokens &&
              response.meta.thoughtsTokens > 0
            ) {
              const thinkingBadge = `*💭 Used ${response.meta.thoughtsTokens} thinking tokens*\n\n`;
              cleanText = thinkingBadge + cleanText;
            }

            // Remove multiple consecutive line breaks
            cleanText = cleanText.replace(/\n{3,}/g, '\n\n');

            // Remove leading/trailing separators and whitespace
            cleanText = cleanText.replace(/^[\s\-]+|[\s\-]+$/g, '');

            // Only add non-empty clean text
            if (cleanText.trim()) {
              this.mutateLastAssistant((prev) => {
                // Add separator if there's already content and this isn't the first response
                const separator = prev.trim() ? '\n\n' : '';
                return prev + separator + cleanText;
              }, requestSeq);
            }
          }

          // Check if AI wants to call functions
          if (
            response.requiresAction &&
            response.functionCalls &&
            response.functionCalls.length > 0
          ) {
            spectreLog(
              `🔧 Agent wants to call ${response.functionCalls.length} function(s):`,
              response.functionCalls.map((fc) => fc.name)
            );

            // Loop detection to prevent infinite recursion
            const loopDetected = detectLoop(response.functionCalls);

            if (loopDetected) {
              const prettyArgs = JSON.stringify(loopDetected.args, null, 2);
              spectreError(
                `🔴 Infinite loop detected: ${loopDetected.signature}`
              );

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
                  `**Action Taken:** Stopped after ${
                    MAX_IDENTICAL_ACTIONS + 1
                  } identical attempts to prevent wasted API calls.\n\n` +
                  `**Recommendation:** Rephrase your request or manually perform the action.\n`,
                requestSeq
              );
              break;
            }

            // Show function execution quietly - results speak for themselves
            // Only add header if multiple functions (for clarity)
            if (response.functionCalls!.length > 1) {
              const functionSection = `\n**Executing ${
                response.functionCalls!.length
              } actions...**\n\n`;
              this.mutateLastAssistant((prev) => {
                const separator = prev.trim() ? '\n\n' : '';
                return prev + separator + functionSection;
              }, requestSeq);
            }

            // Execute each function call
            for (let i = 0; i < response.functionCalls.length; i++) {
              const functionCall = response.functionCalls[i];

              if (requestSeq !== this.stateData.requestSeq) {
                break; // Canceled
              }

              // Show concise function info without verbose args
              // Users care about results, not implementation details
              const funcIcon = this.getFunctionIcon(functionCall.name);
              const funcLabel = this.getFunctionLabel(functionCall.name);

              this.mutateLastAssistant((prev) => {
                const separator =
                  prev.trim() && !prev.endsWith('\n\n') ? '\n' : '';
                return prev + `${separator}${funcIcon} ${funcLabel}...`;
              }, requestSeq);

              // Execute the function with error handling
              let result: { success: boolean; result?: string; error?: string };
              try {
                result = await this.executeFunctionCall(functionCall);
              } catch (funcError) {
                // Function execution threw an error - treat as failure
                spectreError(
                  `Function ${functionCall.name} threw error:`,
                  funcError
                );
                result = {
                  success: false,
                  error:
                    funcError instanceof Error
                      ? funcError.message
                      : String(funcError),
                };
              }

              // Update action history with result for better loop detection
              const lastAction = actionHistory[actionHistory.length - 1];
              if (lastAction && lastAction.functionName === functionCall.name) {
                lastAction.result = result;
              }

              // Display result with status indicator (inline, not verbose)
              if (result.success) {
                this.mutateLastAssistant((prev) => prev + ' ✓\n', requestSeq);
              } else {
                const errorMsg = result.error || 'Unknown error';
                const shortError =
                  errorMsg.length > 100
                    ? errorMsg.substring(0, 100) + '...'
                    : errorMsg;
                this.mutateLastAssistant(
                  (prev) => prev + ` ✗ (${shortError})\n`,
                  requestSeq
                );
              }

              // Add function result to conversation history with CLEAR STATUS
              // This helps the AI understand what happened and avoid loops
              const functionResponse = {
                success: result.success,
                result: result.result,
                error: result.error,
                // Add explicit status message for AI clarity
                status: result.success
                  ? `✅ SUCCESS: Function ${functionCall.name} completed successfully.`
                  : `❌ FAILED: Function ${functionCall.name} failed. Error: ${
                      result.error || 'Unknown error'
                    }`,
                // Add explicit instruction for AI
                instruction: result.success
                  ? `This function succeeded. DO NOT call it again. Move to the next step or finish.`
                  : `This function failed. Analyze the error and try a DIFFERENT approach. DO NOT retry the same function with the same arguments.`,
              };

              conversationHistory.push({
                role: 'function',
                name: functionCall.name,
                response: functionResponse,
              });
            }

            // Continue loop - AI will see function results and decide next step
            continue;
          }

          // No function calls - AI is done!
          spectreLog('✅ Agent completed task - no more function calls needed');

          // Check if AI provided a completion message
          const hasCompletionIndicators =
            response.text &&
            (response.text.toLowerCase().includes('created') ||
              response.text.toLowerCase().includes('completed') ||
              response.text.toLowerCase().includes('done') ||
              response.text.toLowerCase().includes('ready') ||
              response.text.toLowerCase().includes('finished'));

          // Check if we had successful actions
          const hadSuccessfulActions = actionHistory.some(
            (action) => action.result?.success === true
          );

          // If AI says it's done AND we had successful actions, definitely stop
          if (hasCompletionIndicators && hadSuccessfulActions) {
            spectreLog(
              '✅ AI provided completion message after successful actions - task is complete'
            );
          }

          // Mark all remaining tasks as completed
          const currentTasks = this.stateData.tasks || [];
          if (currentTasks.length > 0) {
            const completedTasks = currentTasks.map((task) => ({
              ...task,
              status: 'completed' as const,
            }));
            this.setStateData({ tasks: completedTasks });
          }

          this.mutateLastAssistant(
            (prev) =>
              prev +
              `\n\n---\n\n### ✅ Task Completed\n\nCompleted in **${iteration}** iteration${
                iteration > 1 ? 's' : ''
              }.\n`,
            requestSeq
          );
          break;
        } catch (iterationError) {
          // Error in this specific iteration - show to user and capture for finally
          spectreError(`Agent iteration ${iteration} error:`, iterationError);

          this.mutateLastAssistant(
            (prev) =>
              prev +
              `\n\n⚠️ **Error in iteration ${iteration}:** ${
                iterationError instanceof Error
                  ? iterationError.message
                  : String(iterationError)
              }\n`,
            requestSeq
          );

          // Store error for finally block
          agentError = iterationError;

          // Stop agent loop on generation/function error
          break;
        }
      }

      if (iteration >= MAX_ITERATIONS) {
        this.mutateLastAssistant(
          (prev) =>
            prev +
            `\n\n---\n\n### ⚠️ Maximum Iterations Reached\n\nStopped after **${MAX_ITERATIONS}** iterations for safety.\n`,
          requestSeq
        );
      }
    } catch (outerError: any) {
      // Catch errors from loop setup or unexpected errors not caught by inner try-catch
      spectreError('Agent mode outer error:', outerError);

      this.mutateLastAssistant(
        (prev) =>
          prev +
          `\n\n❌ **Error:** ${outerError.message || String(outerError)}\n`,
        requestSeq
      );

      // Store error for finally block
      agentError = outerError;
    } finally {
      // Always cleanup, whether success or error
      // This guarantees state is reset even if cleanup code throws
      try {
        this.setStateData({
          busy: false,
          currentAbortKey: undefined,
          error: agentError
            ? agentError.message || String(agentError)
            : undefined,
        });
        this.persist();
        this.deferScroll();
      } catch (cleanupError) {
        // Cleanup itself failed - log but don't throw (already handling error)
        spectreError('Agent cleanup error:', cleanupError);

        // Last-ditch effort: at least set busy to false
        try {
          this.setStateData({ busy: false, currentAbortKey: undefined });
        } catch {
          // If even this fails, widget is in bad state - nothing more we can do
          spectreError('Critical: Failed to reset busy state');
        }
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
    const { name, args } = functionCall;

    try {
      let result: string;

      switch (name) {
        // FIXED FUNCTIONS: These now throw errors instead of returning ❌ strings
        // If they return, they succeeded
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

        // LEGACY FUNCTIONS: Still use the old ❌ pattern
        case 'get_boards':
          result = await this.agentGetBoardsList();
          return { success: !result.includes('❌'), result };

        case 'select_board':
          result = await this.agentSelectBoard(args.name);
          return { success: !result.includes('❌'), result };

        case 'search_boards':
          result = await this.agentSearchBoards(args.query);
          return { success: !result.includes('❌'), result };

        case 'install_board':
          result = await this.agentInstallBoard(args.platform, args.version);
          return { success: !result.includes('❌'), result };

        case 'uninstall_board':
          result = await this.agentUninstallBoard(args.platform);
          return { success: !result.includes('❌'), result };

        case 'add_board_url':
          result = await this.agentAddBoardUrl(args.url);
          return { success: !result.includes('❌'), result };

        case 'remove_board_url':
          result = await this.agentRemoveBoardUrl(args.url);
          return { success: !result.includes('❌'), result };

        case 'fetch_board_urls':
          result = await this.agentFetchBoardUrls(args.query);
          return { success: !result.includes('❌'), result };

        case 'get_board_config':
          result = await this.agentGetBoardConfig(args.fqbn);
          return { success: !result.includes('❌'), result };

        case 'set_board_config':
          result = await this.agentSetBoardConfig(args.fqbn, args.options);
          return { success: !result.includes('❌'), result };

        case 'get_ports':
          result = await this.agentGetPortsList();
          return { success: !result.includes('❌'), result };

        case 'select_port':
          result = await this.agentSelectPort(args.address);
          return { success: !result.includes('❌'), result };

        case 'install_library':
          result = await this.agentInstallLibrary(args.name);
          return { success: !result.includes('❌'), result };

        case 'uninstall_library':
          result = await this.agentUninstallLibrary(args.name);
          return { success: !result.includes('❌'), result };

        default:
          return {
            success: false,
            error: `Unknown function: ${name}`,
          };
      }
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
  async send(): Promise<void> {
    const text = this.stateData.input.trim();
    if (!text || this.stateData.busy || this.sending) return;

    // Validate input with dynamic limit based on model
    const charLimit = this.getCharacterLimit();
    if (text.length > charLimit) {
      this.setStateData({
        error: `Message too long. Please limit to ${charLimit.toLocaleString()} characters for ${
          this.prefs['arduino.spectre.model']
        }.`,
      });
      return;
    }

    const now = Date.now();
    if (now - this.lastSendAt < 350) return;
    this.lastSendAt = now;
    this.sending = true;

    const sessions = this.stateData.sessions.slice();
    const current = sessions[this.stateData.active];

    // Add message to memory system (async summarization if needed)
    if (!current.memory) {
      // Initialize memory if missing (shouldn't happen but defensive)
      current.memory = this.memoryManager.createConversation(
        current.id.toString()
      );
    }

    await this.memoryManager.addMessage(current.memory, 'user', text);
    this.saveSessionMemory(current.id); // Persist memory after adding user message

    // Sync memory back to messages array for UI compatibility
    sessions[this.stateData.active] = {
      ...current,
      messages: [
        ...current.messages,
        { id: `msg-${Date.now()}-user`, role: 'user', text },
      ],
    };

    const requestSeq = this.stateData.requestSeq + 1;
    this.setStateData({
      sessions,
      input: '',
      busy: true,
      error: undefined,
      requestSeq,
    });
    this.updateMemoryStats(); // Update stats after adding message
    this.persist();
    this.deferScroll(); // Scroll after adding user message

    // Prepare variables needed for both modes
    const model = this.prefs['arduino.spectre.model'];
    const abortKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.setStateData({ currentAbortKey: abortKey });

    // Collect current sketch files for context (both basic and agent modes need this)
    const sketchFiles = await this.getCurrentSketchFiles();

    const agentMode = this.prefs['arduino.spectre.mode'] === 'agent';

    // Use new function calling approach for agent mode
    if (agentMode) {
      await this.sendMessageWithFunctionCalling(
        text,
        requestSeq,
        abortKey,
        model,
        sketchFiles
      );
      this.sending = false;
      return;
    }

    // Create empty assistant message and attach stream listener for basic mode
    this.appendAssistant('', requestSeq);
    this.attachStreamListener(abortKey, requestSeq);

    // Build context message for AI
    let contextualPrompt = text;

    // Add sketch file context if available (only in agent mode for efficiency)
    if (agentMode && sketchFiles.length > 0) {
      const fileContext = sketchFiles
        .map(
          (file) =>
            `**${file.path}:**\n\`\`\`${this.getFileLanguage(file.path)}\n${
              file.content
            }\n\`\`\``
        )
        .join('\n\n');
      contextualPrompt = `Here are my current Arduino sketch files:\n\n${fileContext}\n\n**User request:** ${text}`;
    } else if (!agentMode && sketchFiles.length > 0) {
      // In basic mode, provide minimal context about sketch existence
      contextualPrompt = `I have an Arduino sketch open.\n\n**User question:** ${text}`;
    }

    // Get conversation history for proper context using new memory system
    const session = this.stateData.sessions[this.stateData.active];
    let conversationHistory: Array<{ role: 'user' | 'model'; text: string }> =
      [];

    if (session?.memory) {
      // Use new memory system to build prompt with optimal token allocation
      // INCREASED: Taking advantage of Gemini 2.5's 1M context window
      const isFlashLite = model === 'gemini-2.5-flash-lite';
      const targetBudget = isFlashLite ? 30_000 : 50_000; // Increased from 16k/25k

      const sketchContext =
        sketchFiles.length > 0
          ? sketchFiles
              .map(
                (file) =>
                  `**${file.path}:**\n\`\`\`${this.getFileLanguage(
                    file.path
                  )}\n${file.content}\n\`\`\``
              )
              .join('\n\n')
          : '';

      const { prompt: _prompt, tokenCount } = this.memoryManager.assemblePrompt(
        session.memory,
        {
          currentPrompt: text,
          additionalContext: sketchContext,
          targetTokenBudget: targetBudget,
        }
      );

      // Log token usage for monitoring
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

      // Build conversation history properly for Gemini API
      // FIXED: Summaries should be treated as historical context, not as direct user messages
      conversationHistory = [];

      // Add memory bank summaries as historical context if they exist
      if (session.memory.memoryBank.summaries.length > 0) {
        const historicalContext = session.memory.memoryBank.summaries
          .map((s) => s.summary)
          .join('\n\n---\n\n');

        // Add as a single user message with clear labeling
        conversationHistory.push({
          role: 'user',
          text: `[HISTORICAL CONTEXT FROM PREVIOUS CONVERSATION]:\n${historicalContext}\n\n---\n\n[CURRENT SESSION CONTINUES BELOW]`,
        });

        // Add model acknowledgment to establish context separation
        conversationHistory.push({
          role: 'model',
          text: 'I understand the historical context. Ready to continue our conversation.',
        });
      }

      // Add recent messages in proper alternating order
      for (const msg of session.memory.recentMessages) {
        conversationHistory.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          text: msg.text,
        });
      }

      // Log conversation structure for debugging
      spectreLog(
        `💬 Conversation history: ${conversationHistory.length} messages (${session.memory.memoryBank.summaries.length} summaries, ${session.memory.recentMessages.length} recent)`
      );
    }

    // Calculate token estimate based on actual prompt being sent
    const estTokens = conversationHistory.reduce(
      (sum, msg) => sum + TokenCounter.fastEstimate(msg.text),
      TokenCounter.fastEstimate(contextualPrompt)
    );

    try {
      // Configure thinking mode - always enabled for better reasoning
      const isFlashLite = model === 'gemini-2.5-flash-lite';

      // Flash Lite shows thinking steps, Flash processes internally
      // Thinking mode enabled for all queries to ensure consistent high-quality responses
      const enableThinking = true; // Always enabled
      const includeThoughts = isFlashLite && enableThinking;

      // Start the generation without awaiting - let streaming handle the response
      this.ai
        .generate({
          prompt: contextualPrompt,
          model,
          generationConfig: {
            maxOutputTokens: 65536, // Increased to max to allow longer responses
            // Temperature dynamically set by backend based on mode and model
            topP: 0.9,
          },
          includeThoughts,
          abortKey,
          thinkingBudget: -1, // -1 = unlimited thinking (always enabled)
          enableGoogleSearch: true, // Enable Google Search for real-time Arduino/hardware info
          context: {
            conversation:
              conversationHistory.length > 0 ? conversationHistory : undefined,
          },
        })
        .then(async (res) => {
          if (requestSeq !== this.stateData.requestSeq) {
            return;
          }

          // Log successful request with actual token usage for our local tracking
          const actualTokensUsed = res.meta?.totalTokens || estTokens;
          this.logRequest(actualTokensUsed, model, true);

          // Note: Server sends authoritative quota updates via onQuota callback.
          // If streaming did not arrive for any reason, ensure busy is cleared and message is present.
          if (this.currentAbortKey === abortKey) {
            this.setStateData({ busy: false, currentAbortKey: undefined });
            if (res.text && !this.streamStarted) {
              // Replace the empty assistant message with the full response
              this.mutateLastAssistant(() => res.text, requestSeq);
            }
          }
          const after = this.stateData.sessions.slice();
          const cur = after[this.stateData.active];
          // Update title from first user message, or if it's still "New Chat"
          const shouldUpdateTitle =
            current.messages.length === 1 || cur.title === 'New Chat';
          const newTitle = shouldUpdateTitle ? autoTitle(text) : cur.title;
          after[this.stateData.active] = { ...cur, title: newTitle };
          this.setStateData({ sessions: after });

          this.persist();
          this.deferScroll(); // Scroll after AI response is complete
        })
        .catch((err) => {
          spectreError('Spectre AI generation failed:', err.message || err);

          if (requestSeq !== this.stateData.requestSeq) {
            return;
          }

          // Log failed request (still counts toward rate limits)
          this.logRequest(estTokens, model, false);

          // Error handling with user-friendly messages
          let errorMessage = 'An error occurred while generating response.';
          let shouldRetry = false;

          if (err?.message) {
            const msg = err.message.toLowerCase();
            if (
              msg.includes('network') ||
              msg.includes('fetch') ||
              msg.includes('connection')
            ) {
              errorMessage =
                'Network error. Please check your connection and try again.';
              shouldRetry = true;
            } else if (
              msg.includes('api key') ||
              msg.includes('authentication')
            ) {
              errorMessage =
                'API key error. Please check your Spectre settings.';
            } else if (msg.includes('quota') || msg.includes('limit')) {
              errorMessage =
                'API quota exceeded. Please wait before sending another message.';
              shouldRetry = true;
            } else if (msg.includes('timeout')) {
              errorMessage = 'Request timed out. Please try again.';
              shouldRetry = true;
            } else {
              errorMessage = err.message;
            }
          }

          // Add failed message to show user what didn't work
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
          this.deferScroll(); // Scroll after error message
        });
    } catch (err: any) {
      // Handle immediate errors (e.g., validation errors before the request is sent)
      if (requestSeq !== this.stateData.requestSeq) return;

      this.logRequest(estTokens, model, false);

      const errorMessage = err?.message || 'Failed to start request';
      const sessions = this.stateData.sessions.slice();
      const current = sessions[this.stateData.active];
      const messages = [
        ...current.messages,
        {
          id: `msg-${Date.now()}-assistant-error`,
          role: 'assistant' as const,
          text: `❌ **Error:** ${errorMessage}`,
        },
      ];
      sessions[this.stateData.active] = { ...current, messages };

      this.setStateData({
        sessions,
        busy: false,
        error: errorMessage,
        currentAbortKey: undefined,
        retryable: true,
      });
      this.deferScroll();
    } finally {
      this.sending = false;
    }
  }

  private startStreamTicker(requestSeq?: number): void {
    if (this.streamTicker) return;
    const seq = requestSeq ?? this.currentRequestSeq;
    if (seq === undefined) return;
    const TICK_MS = 25; // adjust for faster/slower reveal
    this.streamTicker = window.setInterval(() => {
      // Abort if request changed or stream was canceled
      if (seq !== this.currentRequestSeq || !this.currentAbortKey) {
        this.stopStreamTicker();
        return;
      }
      if (this.streamBuffer.length > 0) {
        // Adaptive chunk size based on buffer size
        let step = 24;
        const len = this.streamBuffer.length;
        if (len > 1000) step = 120;
        else if (len > 500) step = 80;
        else if (len > 150) step = 40;
        const take = this.streamBuffer.slice(0, step);
        this.streamBuffer = this.streamBuffer.slice(step);
        this.mutateLastAssistant((prev) => prev + take, seq);
      } else if (this.streamDone) {
        // Flush complete; finalize
        this.stopStreamTicker();
        this.setStateData({ busy: false, currentAbortKey: undefined });
        // Auto-focus input after response completes
        this.focusInput();
      }
    }, TICK_MS);
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
      if (newText !== last.text && newText.trim() !== '' && cur.memory) {
        // Find and update the corresponding message in memory
        const memoryMsg =
          cur.memory.recentMessages[cur.memory.recentMessages.length - 1];
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

        if (checkbox === 'x' || checkbox === '✓' || checkbox === '✔') {
          status = 'completed';
        } else if (checkbox === 'o' || checkbox === '~' || checkbox === '⏳') {
          status = 'in-progress';
        } else if (
          checkbox === '!' ||
          (checkbox === 'x' && description.toLowerCase().includes('failed'))
        ) {
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

  private renderTaskList(): React.ReactNode {
    const { tasks, tasksExpanded, tasksClosed } = this.stateData;
    if (!tasks || tasks.length === 0 || tasksClosed) {
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
   * Renders the main widget UI including chat sessions, message history,
   * input textarea, quota display, and agent task panel.
   */
  protected render(): React.ReactNode {
    const { sessions, active, input, busy, error } = this.stateData;
    const session = sessions[active];
    const charLimit = this.getCharacterLimit();
    return (
      <div className="content noselect arduino-spectre-widget" tabIndex={-1}>
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
        <div
          className="spectre-messages"
          data-spectre-scroll
          role="log"
          aria-live="polite"
          aria-label="Chat messages"
        >
          {this.renderTaskList()}
          {session.messages.length === 0 && (
            <div className="spectre-empty">
              {this.prefs['arduino.spectre.mode'] === 'agent' ? (
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
          )}
          {session.messages.map((m, idx) => {
            const isUser = m.role === 'user';
            return (
              <div
                key={m.id}
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
                  {m.role === 'assistant' ? (
                    <div style={{ position: 'relative' }}>
                      {this.renderAssistantMessage(
                        m.text,
                        busy && idx === session.messages.length - 1
                      )}
                    </div>
                  ) : (
                    <div className="spectre-user-text">{m.text}</div>
                  )}
                  {/* Show loading indicator for last assistant message when busy */}
                  {m.role === 'assistant' &&
                    busy &&
                    idx === session.messages.length - 1 && (
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
          })}
          <div data-spectre-anchor />
        </div>
        {error && (
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
        )}
        {input.length > charLimit * 0.9 && !busy && (
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
        )}
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
                  className={`spectre-chip compact ${
                    input.length > charLimit
                      ? 'error'
                      : input.length > charLimit * 0.9
                      ? 'warning'
                      : ''
                  }`}
                  role="status"
                  aria-live="polite"
                  title={`Character count: ${input.length.toLocaleString()} / ${charLimit.toLocaleString()}`}
                >
                  {input.length.toLocaleString()}/{charLimit.toLocaleString()}
                </span>
                {this.renderInlineQuota()}
              </div>
              <button
                className={
                  busy
                    ? 'spectre-inline-send spectre-stop'
                    : input.length > charLimit
                    ? 'spectre-inline-send spectre-send spectre-disabled'
                    : 'spectre-inline-send spectre-send'
                }
                onClick={() => (busy ? this.cancel() : this.send())}
                disabled={!busy && (!input.trim() || input.length > charLimit)}
                aria-label={
                  input.length > charLimit
                    ? `Message too long (${input.length}/${charLimit})`
                    : busy
                    ? 'Stop response'
                    : 'Send message'
                }
                aria-pressed={busy}
                title={
                  input.length > charLimit
                    ? `Message exceeds ${charLimit.toLocaleString()} character limit by ${(
                        input.length - charLimit
                      ).toLocaleString()} characters. Please shorten your message.`
                    : busy
                    ? 'Stop response'
                    : 'Send message'
                }
              >
                {busy ? '■' : input.length > charLimit ? '⚠' : '➤'}
              </button>
            </div>
            {this.renderMemoryStats()}
          </div>
        </div>
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
   * Renders memory statistics footer showing conversation memory status.
   * Displays recent messages, summaries, token usage, and summarization indicator.
   */
  private renderMemoryStats(): React.ReactNode {
    const { memoryStats } = this.stateData;

    // Don't show if no memory stats available
    if (
      !memoryStats ||
      (memoryStats.recentMessages === 0 && memoryStats.summaries === 0)
    ) {
      return null;
    }

    const { recentMessages, summaries, totalTokens, isSummarizing } =
      memoryStats;
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
        // Alternative approach: look for any open Arduino file in editors
        for (const editor of this.editorManager.all) {
          if (!editor.editor.uri || !editor.editor.document) continue;

          try {
            const editorUriStr = editor.editor.uri.toString();
            const decodedEditorUri = decodeURIComponent(editorUriStr);
            const editorUri = new URI(decodedEditorUri);

            // Check if it's an Arduino-related file
            if (
              editorUri.path.ext === '.ino' ||
              editorUri.path.ext === '.cpp' ||
              editorUri.path.ext === '.h' ||
              editorUri.path.ext === '.c'
            ) {
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

      // Get main sketch file - use mainFileUri if available, otherwise construct from uri
      const mainFileUri = sketch.mainFileUri || sketch.uri;
      const mainUri = new URI(mainFileUri);

      // Try multiple approaches to find the main editor
      const mainEditor = this.editorManager.all.find((editor) => {
        if (!editor.editor.uri) return false;
        const editorUriStr = editor.editor.uri.toString();

        // Try exact match first
        if (editorUriStr === mainFileUri) return true;
        if (editorUriStr === mainUri.toString()) return true;

        // Try decoded comparison
        try {
          const decodedMainUri = decodeURIComponent(mainFileUri);
          const decodedEditorUri = decodeURIComponent(editorUriStr);
          if (decodedMainUri === decodedEditorUri) return true;

          // Try path-based comparison
          const mainPath = new URI(decodedMainUri).path.toString();
          const editorPath = new URI(decodedEditorUri).path.toString();
          if (mainPath === editorPath) return true;
        } catch (e) {
          // Ignore decode errors
        }

        return false;
      });

      let mainFileAdded = false;

      // Include main file whether saved or unsaved
      if (mainEditor && mainEditor.editor.document) {
        const content = mainEditor.editor.document.getText();
        files.push({
          path: mainUri.path.name + mainUri.path.ext,
          content: content,
        });
        mainFileAdded = true;
      } else {
        // Fallback: try to find the main file by name among open editors
        const expectedMainFileName = mainUri.path.name + mainUri.path.ext;

        for (const editor of this.editorManager.all) {
          if (!editor.editor.uri || !editor.editor.document) continue;

          try {
            // Try both encoded and decoded URIs
            const editorUriStr = editor.editor.uri.toString();
            const decodedEditorUri = decodeURIComponent(editorUriStr);
            const editorUri = new URI(decodedEditorUri);
            const editorFileName = editorUri.path.name + editorUri.path.ext;

            if (
              editorFileName === expectedMainFileName ||
              editorFileName.toLowerCase() ===
                expectedMainFileName.toLowerCase()
            ) {
              const content = editor.editor.document.getText();
              files.push({
                path: expectedMainFileName,
                content: content,
              });
              mainFileAdded = true;
              break;
            }
          } catch (e) {
            // Ignore URI processing errors
          }
        }
      }

      // Get additional sketch files that are open in editors
      for (const editor of this.editorManager.all) {
        if (!editor.editor.uri) continue;

        try {
          const editorUriStr = editor.editor.uri.toString();
          const decodedEditorUri = decodeURIComponent(editorUriStr);
          const editorUri = new URI(decodedEditorUri);

          // Skip if this is the main file (check by URI and filename)
          const isMainFile =
            editorUriStr === mainFileUri ||
            decodedEditorUri === mainFileUri ||
            (mainFileAdded &&
              editorUri.path.name + editorUri.path.ext ===
                mainUri.path.name + mainUri.path.ext);

          if (isMainFile) {
            continue;
          }

          // Check if file is in same directory and is a relevant file type
          if (
            editorUri.path.dir.toString() === mainUri.path.dir.toString() &&
            (editorUri.path.ext === '.ino' ||
              editorUri.path.ext === '.cpp' ||
              editorUri.path.ext === '.h' ||
              editorUri.path.ext === '.c')
          ) {
            // Include both saved and unsaved content
            if (editor.editor.document) {
              const content = editor.editor.document.getText();
              files.push({
                path: editorUri.path.name + editorUri.path.ext,
                content: content,
              });
            }
          }
        } catch (e) {
          // Ignore URI processing errors
        }
      }
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
