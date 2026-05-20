/**
 * Main widget for the Spectre AI assistant.
 * Provides a chat UI for basic Q&A and an optional agent mode.
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
import { SpectreAiFrontendClient } from './clients/ai-frontend-client';
import { spectreWarn, spectreError } from '../../common/protocol/spectre-types';
import { BoardHelper } from './board/board-helpers';
import { StorageHelper } from './feature/storage-helper';
import * as SketchUtilities from './feature/sketch-utilities';
import * as RenderingHelpers from './ui/message-rendering';
import * as ConfigHelpers from './utils/model-config';
import * as WidgetUtilities from './ui/ui-utilities';
import * as AgentExecutionHelpers from './agent/agent-execution-router';
import * as AgentActions from './agent/agent-actions';
import * as AgentModeTools from './agent/agent-mode-tools';
import * as CodeBlockRendering from './ui/code-block-rendering';
import { SpectreView } from './ui/spectre-view';
import { StreamController } from './ui/stream-controller';
import * as ChatTools from './chat/chat-tools';
import * as SessionActions from './chat/chat-session-manager';
import type { ChatManagerState } from './chat/chat-session-manager';
import type { ChatSession } from './ui/widget-rendering';
import type { ConversationMemory } from './memory/memory-types';
import { AgentTask } from './agent/agent-utils';
import { Message } from '@theia/core/shared/@phosphor/messaging';

/**
 * Parameters for memory comparison operations.
 * Encapsulates memory update decision logic.
 */
interface MemoryComparisonParams {
  newText: string;
  oldText: string;
  memory: ConversationMemory | undefined;
}

/**
 * Strongly-typed shapes to avoid primitive-obsession by naming commonly-used
 * object structures instead of repeating inline anonymous types.
 */
/**
 * Semantic aliases to avoid primitive-obsession and document intent for commonly-used primitives.
 */
type FilePath = string;
type FileContent = string;
type AbortKey = string;
type MessageId = string;
type Metadata = Record<string, unknown>;

interface SketchFile {
  path: FilePath;
  content: FileContent;
}

/**
 * Use an explicit index signature interface for function args so the shape is named
 * (helps linters/static analysis avoid flagging primitive-obsession).
 */
type AgentFunctionArgs = Record<string, unknown>;

interface AgentFunctionCall {
  name: string;
  args: AgentFunctionArgs;
}

/**
 * Small value objects to avoid primitive-obsession: wrap common parameter groups
 * in named interfaces so call sites don't pass multiple unrelated primitives.
 */
interface AppendAssistantParams {
  text: string;
  requestSeq: number;
}

interface MutateLastAssistantParams {
  mutator: (text: string) => string;
  requestSeq: number;
  parts?: MessagePart[];
}

/**
 * Represents a structured part of an assistant message, e.g. a code block
 * or other rich content the assistant may add to a memory entry.
 */
interface MessagePart {
  type: string;
  content: string;
  // Optional structured metadata instead of an open index-signature to avoid primitive-obsession
  metadata?: Metadata;
}

/**
 * Strongly-typed memory message stored in ConversationMemory.recentMessages.
 */
enum Role {
  Assistant = 'assistant',
  User = 'user',
  System = 'system',
}

enum SpectreMode {
  Basic = 'basic',
  Agent = 'agent',
}

interface MemoryMessage {
  id?: MessageId;
  role: Role;
  text: string;
  parts?: MessagePart[];
  estimatedTokens?: number;
}

interface ExecutionResult {
  success: boolean;
  result?: string;
  error?: string;
}

/**
 * Event payload delivered by the AI streaming API callbacks.
 * Extracted into a named interface to avoid primitive-obsession (inline anonymous types).
 */
interface StreamEvent {
  key: AbortKey;
  delta?: string;
  done?: boolean;
  error?: string;
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

const PREF_KEYS = {
  MODE: 'arduino.spectre.mode',
  MODEL: 'arduino.spectre.model',
  THINKING_LEVEL: 'arduino.spectre.thinkingLevel',
  GROUNDING: 'arduino.spectre.grounding',
} as const;

import { ArduinoPreferences } from '../arduino-preferences';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { SketchesServiceClientImpl } from '../sketches-service-client-impl';
import { CommandService } from '@theia/core/lib/common/command';
import { OutputChannelManager } from '../theia/output/output-channel';
import { EditorManager } from '../theia/editor/editor-manager';
import { BoardsServiceProvider } from '../boards/boards-service-provider';
import { BoardsDataStore } from '../boards/boards-data-store';
import { BoardsService } from '../../common/protocol/boards-service';
import { MonitorManagerProxyClient } from '../../common/protocol';
import { LibraryService } from '../../common/protocol/library-service';
import { ConfigService } from '../../common/protocol/config-service';
import { MemoryManager } from './memory/memory-manager';
import { TokenCounter } from './utils/token-counter';

// ChatMessage/ChatSession types live in `ui/widget-rendering.tsx`.

// RequestLog/DailyTracker types live in `chat/chat-tools.ts`.

interface SpectreState extends ChatManagerState {
  input: string;
  busy: boolean;
  retryable?: boolean;
  requestSeq: number;
  currentAbortKey?: AbortKey;
  requestSessionId?: number;
  quotaUsed: number;
  quotaCapacity: number;
  rpmUsed: number;
  rpmLimit: number;
  queueSize: number;
  nextAvailableMs: number;
  now: number;
  tasksExpanded: boolean;
  tasksClosed: boolean;
  tasks: AgentTask[];
  codeDiff?: {
    oldCode: string;
    newCode: string;
    timestamp: number;
    expanded: boolean;
  };
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

  @inject(SpectreAiService) private readonly ai!: SpectreAiService;
  @inject(SpectreAiFrontendClient)
  private readonly aiClient!: SpectreAiFrontendClient;
  @inject(ArduinoPreferences) private readonly prefs!: ArduinoPreferences;
  @inject(StorageService) private readonly storage!: StorageService;
  @inject(SketchesServiceClientImpl)
  private readonly sketchesClient!: SketchesServiceClientImpl;
  @inject(CommandService) private readonly commands!: CommandService;
  @inject(OutputChannelManager)
  private readonly outputChannels!: OutputChannelManager;
  @inject(EditorManager) private readonly editorManager!: EditorManager;
  @inject(BoardsServiceProvider)
  private readonly boardsServiceProvider!: BoardsServiceProvider;
  @inject(BoardsService) private readonly boardsService!: BoardsService;
  @inject(BoardsDataStore) private readonly boardsDataStore!: BoardsDataStore;
  @inject(MonitorManagerProxyClient)
  private readonly monitorManagerProxy!: MonitorManagerProxyClient;
  @inject(LibraryService) private readonly libraryService!: LibraryService;
  @inject(ConfigService) private readonly configService!: ConfigService;
  @inject(MemoryManager) private readonly memoryManager!: MemoryManager;

  // Cache normalized board data for O(1) lookups
  private boardSearchCache: ReturnType<
    typeof BoardHelper.buildBoardCache
  > | null = null;

  private stateData: SpectreState = {
    sessions: [{ id: Date.now(), title: 'New Chat', messages: [] }],
    active: 0,
    input: '',
    busy: false,
    requestSeq: 0,
    requestSessionId: undefined,
    quotaUsed: 0,
    quotaCapacity: 250000,
    rpmUsed: 0,
    rpmLimit: 10, // Placeholder, set correctly in postConstruct
    queueSize: 0,
    nextAvailableMs: Date.now(),
    now: Date.now(),
    requestLogs: [],
    dailyTracker: {
      date: ConfigHelpers.getPacificDate(),
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

  private readonly streamController = new StreamController({
    streamFallbackTimeoutMs: WIDGET_TIMING.STREAM_FALLBACK_TIMEOUT,
    setBusyDone: () =>
      this.setStateData({
        busy: false,
        currentAbortKey: undefined,
        requestSessionId: undefined,
      }),
    focusInput: () => this.focusInput(),
    mutateLastAssistant: (mutator, requestSeq) =>
      this.mutateLastAssistant({ mutator, requestSeq }),
  });

  // Timer tracking for proper cleanup and memory leak prevention
  private readonly feedbackTimers: Set<number> = new Set(); // Button feedback animations
  private readonly decorationTimers: Set<number> = new Set(); // Editor decoration auto-remove

  /**
   * SpectreAiClient callback for receiving streaming AI response chunks.
   * Buffers text deltas and uses a ticker to smoothly reveal them in the UI.
   * Handles errors and completion signals.
   */
  onStream(event: StreamEvent): void {
    this.streamController.onStream(event);
  }

  onQuota(update: SpectreQuotaUpdate): void {
    this.setStateData({
      quotaUsed: update.usedTokens,
      quotaCapacity: update.capacity,
      rpmUsed: update.rpmUsed,
      rpmLimit: update.rpmLimit,
      queueSize: update.queued,
      nextAvailableMs: update.nextAvailableMs,
    });
  }

  /**
   * Lifecycle: Called after dependency injection completes, before widget attachment.
   * Initializes state that requires injected dependencies.
   * Sets the correct RPM limit immediately based on the persisted model preference.
   */
  @postConstruct()
  protected init(): void {
    this.id = SpectreWidget.ID;
    this.title.label = SpectreWidget.LABEL;
    this.title.caption = SpectreWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = 'spectre-icon';
    this.addClass('arduino-spectre-widget');

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
    this.streamController.stop();

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
   * Lifecycle: Called when widget is attached to the DOM.
   * Establishes backend connection and syncs quota state.
   */
  protected override async onAfterAttach(msg: Message): Promise<void> {
    super.onAfterAttach(msg);

    // Subscribe to AI client events for streaming responses and quota updates
    this.toDispose.push(this.aiClient.onStreamEvent((e) => this.onStream(e)));
    this.toDispose.push(this.aiClient.onQuotaEvent((u) => this.onQuota(u)));

    // Start clock ticker for UI updates (time-based displays)
    this.startClock();

    // Establish backend connection and sync initial quota state
    // This triggers backend's setClient() which pushes current quota immediately
    await WidgetUtilities.refreshQuotaForCurrentModel({
      ai: this.ai,
      model: this.prefs[PREF_KEYS.MODEL],
      getFallbackRpmLimit: () => this.getRpmLimit(),
      setStateData: (patch) => this.setStateData(patch),
    });

    // Listen for model preference changes to refresh quota when user switches models
    const prefDisposable = (
      this.prefs as unknown as {
        onPreferenceChanged?: (cb: (e: { preferenceName: string }) => void) => {
          dispose: () => void;
        };
      }
    ).onPreferenceChanged?.((e) => {
      if (e.preferenceName === PREF_KEYS.MODEL) {
        // Update RPM limit immediately when model changes
        this.setStateData({ rpmLimit: this.getRpmLimit() });
        // Then refresh quota from backend
        WidgetUtilities.refreshQuotaForCurrentModel({
          ai: this.ai,
          model: this.prefs[PREF_KEYS.MODEL],
          getFallbackRpmLimit: () => this.getRpmLimit(),
          setStateData: (patch) => this.setStateData(patch),
        });
      }
    });
    if (prefDisposable) {
      this.toDispose.push(prefDisposable);
    }

    // Also update RPM limit immediately after attach in case preferences loaded late
    // This ensures correct display even if backend sync is delayed
    this.setStateData({ rpmLimit: this.getRpmLimit() });
  }
  protected override onBeforeDetach(msg: Message): void {
    super.onBeforeDetach(msg);

    // Widget detach cleanup
    this.streamController.detach();
    this.stopClock();
  }

  protected override onBeforeShow(msg: Message): void {
    super.onBeforeShow(msg);
  }

  /**
   * Called when the widget is activated (gains focus).
   * Focuses the input textarea, lazy-loads react-markdown library,
   * and hooks into sketch change events for context awareness.
   */
  protected override async onActivateRequest(msg: Message): Promise<void> {
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
        } catch (err) {}
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
    if (RenderingHelpers.ReactMarkdownLazy === undefined) {
      try {
        RenderingHelpers.setReactMarkdownLazy(
          (await import('react-markdown')).default
        );
        this.update();
      } catch (error) {
        spectreWarn(
          'Failed to load react-markdown, using fallback rendering:',
          error
        );
        RenderingHelpers.setReactMarkdownLazy(null); // Signal to use fallback
        this.update();
      }
    }
    await this.hookSketchChanges();
  }

  /**
   * Focuses the input textarea and places the caret at the end.
   * Retries with requestAnimationFrame to handle timing issues.
   */
  private isInputFocusable(
    input: HTMLTextAreaElement | null | undefined
  ): boolean {
    return !!input && !input.disabled && input.offsetParent !== null;
  }

  private focusInput(): void {
    const tryFocus = () => {
      const input = this.inputRef;
      if (this.isInputFocusable(input) && input) {
        input.focus();
        try {
          // Only move cursor to end if input is empty (after send/clear)
          // Otherwise preserve current position for user editing
          if (input.value.length === 0) {
            input.selectionStart = input.selectionEnd = input.value.length;
          }
        } catch (err) {
          // Cursor positioning failed silently
        }
      }
    };
    // Small delay to ensure DOM is ready and any state updates have finished
    setTimeout(tryFocus, WIDGET_TIMING.FOCUS_INPUT_DELAY);
  }

  private shouldUpdateMemory(params: MemoryComparisonParams): boolean {
    const { newText, oldText, memory } = params;
    return newText !== oldText && newText.trim() !== '' && !!memory;
  }

  private isNetworkError(message: string): boolean {
    const msg = message.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('fetch') ||
      msg.includes('connection')
    );
  }

  private getSpectreMode(): SpectreMode {
    // Read the explicit 'arduino.spectre.mode' preference and map to the enum,
    // avoiding fragile string checks and ensuring the correct preference key is used.
    const raw = (this.prefs[PREF_KEYS.MODE] || '').toString().toLowerCase();
    switch (raw) {
      case 'agent':
        return SpectreMode.Agent;
      case 'basic':
      default:
        return SpectreMode.Basic;
    }
  }

  /**
   * Renders assistant message content with integrated Arduino code blocks
   */
  private renderAssistantMessage(
    text: string,
    isStreaming: boolean
  ): React.ReactNode {
    return CodeBlockRendering.renderAssistantMessage({
      deps: {
        editorManager: this.editorManager,
        feedbackTimers: this.feedbackTimers,
        copyFeedbackDurationMs: WIDGET_TIMING.COPY_FEEDBACK_DURATION,
        isBasicMode: this.getSpectreMode() !== SpectreMode.Agent,
      },
      text,
      isStreaming,
    });
  }

  private startClock(): void {
    this.clockTicker = WidgetUtilities.restartClock({
      existingTicker: this.clockTicker,
      stateData: this.stateData,
      getPacificDate: () => ConfigHelpers.getPacificDate(),
      persistTrackingData: () => this.persistTrackingData(),
      update: () => this.update(),
    });
  }
  private stopClock(): void {
    WidgetUtilities.stopClock(this.clockTicker);
    this.clockTicker = undefined;
  }

  private async hookSketchChanges(): Promise<void> {
    const loadDeps = {
      sketchesClient: this.sketchesClient,
      storage: this.storage,
      getPacificDate: () => ConfigHelpers.getPacificDate(),
      setStateData: (patch: Partial<ChatManagerState>) =>
        this.setStateData(patch),
      updateMemoryStats: () => this.updateMemoryStats(),
      migrateSessions: (oldSessions: ChatSession[]) =>
        this.migrateSessions(oldSessions),
      createSessionWithMemory: (sessionId?: number) =>
        this.createSessionWithMemory(sessionId),
    };

    await SessionActions.loadForCurrentSketch(loadDeps);
    this.toDispose.push(
      this.sketchesClient.onCurrentSketchDidChange(() =>
        SessionActions.loadForCurrentSketch(loadDeps)
      )
    );
  }

  /**
   * Persists both chat sessions and tracking data to storage.
   */
  private async persistSessions(): Promise<void> {
    await StorageHelper.persistAll({
      storage: this.storage,
      sketchKey: this.stateData.sketchKey,
      sessions: this.stateData.sessions,
      requestLogs: this.stateData.requestLogs,
      dailyTracker: this.stateData.dailyTracker,
    });
  }

  private persist(): void {
    void this.persistSessions();
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
    return SessionActions.migrateSessions({
      deps: this.getSessionMemoryDeps(),
      oldSessions,
    });
  }

  /**
   * Creates a new chat session with memory system initialized.
   * Attempts to load persisted memory if available.
   */
  private async createSessionWithMemory(
    sessionId?: number
  ): Promise<ChatSession> {
    return SessionActions.createSessionWithMemory({
      deps: this.getSessionMemoryDeps(),
      sessionId,
    });
  }

  /**
   * Saves session memory to localStorage for persistence across reloads.
   * Called after each message is added to memory.
   */
  private saveSessionMemory(sessionId: number): void {
    SessionActions.saveSessionMemory({
      deps: this.getSessionMemoryDeps(),
      sessionId,
    });
  }

  /**
   * Updates memory stats in state for UI display.
   */
  private updateMemoryStats(): void {
    SessionActions.updateMemoryStats({ deps: this.getSessionMemoryDeps() });
  }

  private getSessionMemoryDeps(): SessionActions.SessionMemoryToolsDeps {
    return {
      memoryManager: this.memoryManager,
      getStateData: () => ({
        sessions: this.stateData.sessions,
        active: this.stateData.active,
        memoryStats: this.stateData.memoryStats,
      }),
      setStateData: (patch) => this.setStateData(patch),
    };
  }

  private setStateData(patch: Partial<SpectreState>): void {
    // Atomic state update to prevent race conditions
    this.stateData = { ...this.stateData, ...patch };
    this.update();
  }

  /**
   * Creates a new chat session and switches to it.
   * Called by the "New Chat" toolbar button.
   */
  async newChat(): Promise<void> {
    return SessionActions.newChat({
      createSessionWithMemory: () => this.createSessionWithMemory(),
      stateData: this.stateData,
      setStateData: (patch) => this.setStateData(patch),
      updateMemoryStats: () => this.updateMemoryStats(),
      persist: () => this.persist(),
    });
  }

  /**
   * Clears all messages in the current chat session.
   * Called by the "Clear Chat" toolbar button.
   */
  async clearChat(): Promise<void> {
    return SessionActions.clearChat({
      memoryManager: this.memoryManager,
      stateData: this.stateData,
      setStateData: (patch) => this.setStateData(patch),
      updateMemoryStats: () => this.updateMemoryStats(),
      persist: () => this.persist(),
    });
  }

  /**
   * Closes the current chat session. If it's the last session,
   * creates a new default session to ensure at least one always exists.
   * Called by the "Close Chat" toolbar button.
   */
  async closeChat(): Promise<void> {
    return SessionActions.closeChat({
      stateData: this.stateData,
      createSessionWithMemory: () => this.createSessionWithMemory(),
      setStateData: (patch) => this.setStateData(patch),
      updateMemoryStats: () => this.updateMemoryStats(),
      persist: () => this.persist(),
    });
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
    WidgetUtilities.autoGrowTextArea(e.target, 300);
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
    return (this.prefs[PREF_KEYS.MODEL] || '').toLowerCase();
  }

  /**
   * Sends a message using the new function calling approach (agent mode).
   * Implements ReAct loop: Think → Act → Observe → Repeat
   */
  private async sendMessageWithFunctionCalling(
    params: AgentModeTools.FunctionCallingParams
  ): Promise<void> {
    return AgentModeTools.sendMessageWithFunctionCalling({
      deps: {
        ai: this.ai,
        memoryManager: this.memoryManager,
        stateData: this.stateData,
        getStateData: () => this.stateData,
        setStateData: (patch) => this.setStateData(patch),
        appendAssistant: (text, seq) => this.appendAssistant({ text, requestSeq: seq }),
        mutateLastAssistant: (mutator, seq) =>
          this.mutateLastAssistant({ mutator, requestSeq: seq }),
        focusInput: () => this.focusInput(),
        persist: () => this.persist(),
        deferScroll: () => this.deferScroll(),
        saveSessionMemory: (id) => this.saveSessionMemory(id),
        updateMemoryStats: () => this.updateMemoryStats(),
        executeFunctionCall: (functionCall) =>
          this.executeFunctionCall(functionCall),
      },
      input: params,
    });
  }

  /**
   * Executes a function call from the AI agent by routing to the appropriate agent method.
   */
  private async executeFunctionCall(functionCall: AgentFunctionCall): Promise<ExecutionResult> {
    return AgentExecutionHelpers.executeFunctionCall(
      functionCall,
      AgentActions.createAgentActions({
        sketchesClient: this.sketchesClient,
        commands: this.commands,
        editorManager: this.editorManager,
        outputChannels: this.outputChannels,
        boardsServiceProvider: this.boardsServiceProvider,
        boardsService: this.boardsService,
        boardsDataStore: this.boardsDataStore,
        monitorManagerProxy: this.monitorManagerProxy,
        libraryService: this.libraryService,
        configService: this.configService,
        decorationTimers: this.decorationTimers,
        getErrorMessage: (error) => this.getErrorMessage(error),
        getBoardSearchCache: () => this.boardSearchCache,
        setBoardSearchCache: (cache) => {
          this.boardSearchCache = cache;
        },
        timing: WIDGET_TIMING,
      }),
      spectreError
    );
  }

  private async validateAndPrepareMessage(): Promise<ChatTools.ValidateAndPrepareResult | null> {
    const lastSendAtRef = { value: this.lastSendAt };
    const result = await ChatTools.validateAndPrepareMessage({
      stateData: this.stateData,
      prefs: this.prefs,
      sending: this.sending,
      lastSendAtRef,
      inputElement: this.inputRef,
      memoryManager: this.memoryManager,
      canSendMessage: (text, busy, sending) => !!text && !busy && !sending,
      getCharacterLimit: () => this.getCharacterLimit(),
      setStateData: (patch) => this.setStateData(patch),
      saveSessionMemory: (id) => this.saveSessionMemory(id),
      updateMemoryStats: () => this.updateMemoryStats(),
      persist: () => this.persist(),
      deferScroll: () => this.deferScroll(),
    });
    this.lastSendAt = lastSendAtRef.value;
    return result;
  }

  async send(): Promise<void> {
    try {
      const prepared = await this.validateAndPrepareMessage();
      if (!prepared) {
        return;
      }

      // Set sending flag AFTER validation succeeds
      this.sending = true;

      const { text, requestSeq, abortKey, model } = prepared;

      // Collect current sketch files for context (both basic and agent modes need this)
      const sketchFiles = await this.getCurrentSketchFiles();

      const agentMode = this.getSpectreMode() === SpectreMode.Agent;

      // Use new function calling approach for agent mode
      if (agentMode) {
        await this.sendMessageWithFunctionCalling({
          text,
          requestSeq,
          abortKey,
          model,
          sketchFiles,
          thinkingLevel: this.prefs[PREF_KEYS.THINKING_LEVEL],
          enableGoogleSearch: this.prefs[PREF_KEYS.GROUNDING] === true,
        });
        return; // finally block will reset this.sending
      }

      // Basic mode: Create empty assistant message and attach stream listener
      ChatTools.startBasicModeGeneration({
        deps: {
          ai: this.ai,
          getStateData: () => this.stateData,
          memoryManager: this.memoryManager,
          prefs: this.prefs, // Add this line
          getPacificDate: () => ConfigHelpers.getPacificDate(),
          persistTrackingData: () => this.persistTrackingData(),
          isNetworkError: (message) => this.isNetworkError(message),
          streamAttach: (key, seq) => this.streamController.attach(key, seq),
          appendAssistant: (t, seq) => this.appendAssistant({ text: t, requestSeq: seq }),
          mutateLastAssistant: (mutator, seq, parts) =>
            this.mutateLastAssistant({ mutator, requestSeq: seq, parts }),
          streamHasStarted: () => this.streamController.hasStreamStarted(),
          setStateData: (patch) => this.setStateData(patch),
          persist: () => this.persist(),
          deferScroll: () => this.deferScroll(),
          focusInput: () => this.focusInput(),
          buildSketchContext: (files) =>
            SketchUtilities.buildSketchContext(files),
        },
        prepared,
        sketchFiles,
      });
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

  /**
   * Appends an assistant message to the conversation.
   * Also adds to memory system for long-term retention.
   */
  private async appendAssistant(params: AppendAssistantParams): Promise<void> {
    const { text, requestSeq } = params;
    if (requestSeq !== this.stateData.requestSeq) return;

    const sessions = this.stateData.sessions.slice();
    const requestedId = this.stateData.requestSessionId;
    const idx = requestedId
      ? sessions.findIndex((s) => s.id === requestedId)
      : this.stateData.active;
    const cur = sessions[idx];
    if (!cur) {
      return;
    }

    // Add to messages array for UI
    sessions[idx] = {
      ...cur,
      messages: [
        ...cur.messages,
        { id: `msg-${Date.now()}-assistant`, role: Role.Assistant, text },
      ],
    };

    // Add to memory system (only if text is not empty - empty is placeholder)
    if (text.trim() !== '' && cur.memory) {
      await this.memoryManager.addMessage(cur.memory, Role.Assistant, text);
      this.saveSessionMemory(cur.id); // Persist memory after adding assistant response
      this.updateMemoryStats();
    }

    this.setStateData({ sessions });
    this.persist();
    this.deferScroll();
  }

  private async mutateLastAssistant(params: MutateLastAssistantParams): Promise<void> {
    const { mutator, requestSeq, parts } = params;
    // Double-check request sequence to prevent race conditions
    if (requestSeq !== this.stateData.requestSeq) return;

    const sessions = this.stateData.sessions.slice();
    const requestedId = this.stateData.requestSessionId;
    const idx = requestedId
      ? sessions.findIndex((s) => s.id === requestedId)
      : this.stateData.active;
    const cur = sessions[idx];
    if (!cur) return;

    const msgs = cur.messages.slice();
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== Role.Assistant) return;

    // Mutate last assistant text in UI
    const newText = mutator(last.text);
    msgs[msgs.length - 1] = { id: last.id, role: Role.Assistant, text: newText };
    sessions[idx] = { ...cur, messages: msgs };

    // Move memory update logic into a helper to reduce nesting/complexity
    await this.updateAssistantMemoryIfNeeded(cur, newText, last.text, parts);

    this.setStateData({ sessions });
    this.persist();
    this.deferScroll();
  }

  private async updateAssistantMemoryIfNeeded(
    cur: ChatSession,
    newText: string,
    oldText: string,
    parts?: MessagePart[]
  ): Promise<void> {
    // Guard: no memory associated with session
    if (!cur.memory) return;

    const hasParts = this.partsAreNonEmpty(parts);
    const trimmed = newText.trim();

    const shouldUpdateText = this.shouldUpdateMemory({
      newText,
      oldText,
      memory: cur.memory,
    });

    const recent = cur.memory.recentMessages ?? [];
    const lastMemoryMsg = recent[recent.length - 1] as MemoryMessage | undefined;

    // Create a new assistant memory entry when none exists and we have content
    if (!this.hasAssistantMemoryEntry(lastMemoryMsg)) {
      if (trimmed === '' && !hasParts) return;
      await this.memoryManager.addMessage(cur.memory, Role.Assistant, newText, parts);
      this.saveSessionMemory(cur.id);
      this.updateMemoryStats();
      return;
    }

    // Nothing meaningful changed (no substantive text change and no new parts)
    if (!shouldUpdateText && !hasParts) return;

    // Apply the in-place update to the existing assistant memory message
    this.applyUpdateToLastMemory(lastMemoryMsg!, newText, parts);

    // Persist only for final updates that include parts to avoid excessive writes
    if (hasParts) {
      this.saveSessionMemory(cur.id);
      this.updateMemoryStats();
    }
  }

  private partsAreNonEmpty(parts?: MessagePart[]): boolean {
    return Array.isArray(parts) && parts.length > 0;
  }

  private hasAssistantMemoryEntry(lastMemoryMsg: MemoryMessage | undefined): boolean {
    return !!lastMemoryMsg && lastMemoryMsg.role === Role.Assistant;
  }

  private applyUpdateToLastMemory(lastMemoryMsg: MemoryMessage, newText: string, parts?: MessagePart[]): void {
    // Use a mutable partial type to avoid index-signature hacks and make intent explicit
    const mutableLast: Partial<MemoryMessage> = lastMemoryMsg;
    mutableLast.text = newText;
    if (this.partsAreNonEmpty(parts)) {
      mutableLast.parts = parts;
    } else {
      // Delete the optional property explicitly when there are no parts
      delete (mutableLast as any).parts;
    }
    mutableLast.estimatedTokens = TokenCounter.estimate(newText, 'natural');
  }

  private cancel(): void {
    const key = this.stateData.currentAbortKey;
    const newSeq = this.stateData.requestSeq + 1;
    this.setStateData({
      busy: false,
      requestSeq: newSeq,
      currentAbortKey: undefined,
      requestSessionId: undefined,
    });
    this.sending = false;
    this.streamController.detach();
    if (key)
      this.ai.cancel(key).catch(() => {
        /* ignore */
      });
    // Auto-focus input after stopping generation
    this.focusInput();
  }

  /**
   * Renders the main widget UI including chat sessions, message history,
   * input textarea, quota display, and agent task panel.
   */
  protected render(): React.ReactNode {
    return SpectreView({
      mode: this.getSpectreMode(),
      model: this.prefs['arduino.spectre.model'],
      busy: this.stateData.busy,
      sessions: this.stateData.sessions,
      active: this.stateData.active,
      input: this.stateData.input,
      charLimit: this.getCharacterLimit(),
      error: this.stateData.error,
      retryable: !!this.stateData.retryable,
      tasks: this.stateData.tasks,
      tasksExpanded: this.stateData.tasksExpanded,
      tasksClosed: this.stateData.tasksClosed,
      quotaUsed: this.stateData.quotaUsed,
      quotaCapacity: this.stateData.quotaCapacity,
      rpmUsed: this.stateData.rpmUsed,
      rpmLimit: this.stateData.rpmLimit,
      queueSize: this.stateData.queueSize,
      nextAvailableMs: this.stateData.nextAvailableMs,
      now: this.stateData.now,
      clientRpm: ConfigHelpers.calculateCurrentRpm(
        this.stateData.requestLogs,
        Date.now()
      ),
      dailyStats: ConfigHelpers.getDailyStats(this.stateData.dailyTracker),
      memoryStats: this.stateData.memoryStats,
      onSetActive: (i) => this.setActive(i),
      onToggleTasksExpand: () =>
        this.setStateData({ tasksExpanded: !this.stateData.tasksExpanded }),
      onCloseTasks: () => this.setStateData({ tasksClosed: true }),
      onRetry: () => {
        this.setStateData({ error: undefined, retryable: false });
        this.send();
      },
      onSendClick: () => this.send(),
      onCancelClick: () => this.cancel(),
      onInputChange: this.onInputChange,
      onKeyDown: this.onKeyDown,
      inputRef: (el) => (this.inputRef = el),
      renderAssistantMessage: (text, isStreaming) =>
        this.renderAssistantMessage(text, isStreaming),
    });
  }

  private deferScroll(): void {
    WidgetUtilities.deferScrollToBottom(this.node, '.spectre-messages');
  }

  /**
   * Collects current sketch files (.ino, .cpp, .h) to provide context to AI.
   * Returns file paths and contents for better AI assistance.
   * Includes both saved and unsaved (dirty) files.
   */
  private async getCurrentSketchFiles(): Promise<SketchFile[]> {
    return SketchUtilities.getCurrentSketchFiles({
      sketchesClient: this.sketchesClient,
      editorManager: this.editorManager,
    });
  }
}
