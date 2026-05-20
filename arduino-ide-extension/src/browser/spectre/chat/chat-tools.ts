/**
 * Core chat utilities for Spectre (rate limiting, session updates, streaming helpers).
 *
 * @author Tazul Islam
 */

import type { MemoryManager } from '../memory/memory-manager';
import type {
  SpectreAiService,
  SpectreAiRequest,
  SpectreAiResponse,
} from '../../../common/protocol/spectre-ai-service';
import { spectreError } from '../../../common/protocol/spectre-types';
import type { ChatSession } from '../ui/widget-rendering';
import { TokenCounter } from '../utils/token-counter';
import { autoTitle } from '../utils/auto-title';
import * as UiUtilities from '../ui/ui-utilities';
import { normalizeThinkingLevel } from '../../../common/spectre-utils';

/**
 * Tracks individual API requests for quota and rate limit monitoring.
 */
export interface RequestLog {
  timestamp: number;
  tokensUsed: number;
  model: string;
  success: boolean;
}

/**
 * Aggregates daily API usage statistics for quota tracking.
 */
export interface DailyTracker {
  date: string; // YYYY-MM-DD in Pacific Time
  requestCount: number;
  tokenCount: number;
}

export interface ValidateAndPrepareResult {
  text: string;
  requestSeq: number;
  abortKey: string;
  model: string;
  sessions: ChatSession[];
}

export interface BasicChatStateData {
  sessions: ChatSession[];
  active: number;
  input: string;
  busy: boolean;
  error?: string;
  retryable?: boolean;
  requestSeq: number;
  currentAbortKey?: string;
  requestSessionId?: number;
  requestLogs: RequestLog[];
  dailyTracker: DailyTracker;
}

export interface ValidateAndPrepareDeps {
  stateData: BasicChatStateData;
  prefs: {
    ['arduino.spectre.model']: string;
    ['arduino.spectre.thinkingLevel']: string;
    ['arduino.spectre.grounding']: boolean;
  };
  sending: boolean;
  lastSendAtRef: { value: number };
  inputElement?: HTMLTextAreaElement | null;
  memoryManager: MemoryManager;

  canSendMessage: (text: string, busy: boolean, sending: boolean) => boolean;
  getCharacterLimit: () => number;

  setStateData: (patch: Partial<BasicChatStateData>) => void;
  saveSessionMemory: (sessionId: number) => void;
  updateMemoryStats: () => void;
  persist: () => void;
  deferScroll: () => void;
}

export function validateAndPrepareMessage(
  deps: ValidateAndPrepareDeps
): Promise<ValidateAndPrepareResult | null> {
  return validateAndPrepareMessageImpl(deps);
}

async function validateAndPrepareMessageImpl(
  deps: ValidateAndPrepareDeps
): Promise<ValidateAndPrepareResult | null> {
  const text = deps.stateData.input.trim();

  if (!canSendMessageNow(deps, text)) {
    return null;
  }

  const tooLongError = validateCharacterLimit(deps, text);
  if (tooLongError) {
    deps.setStateData({ error: tooLongError });
    return null;
  }

  if (!applyRateLimit(deps.lastSendAtRef)) {
    return null;
  }

  const sessions = await appendUserMessageToSessions(deps, text);
  const { requestSeq, model, abortKey } = createRequestMeta(deps);

  clearInputElement(deps.inputElement);
  setBusyState(deps, sessions, requestSeq, abortKey);
  finalizePreparation(deps);

  return { text, requestSeq, abortKey, model, sessions };
}

function canSendMessageNow(
  deps: ValidateAndPrepareDeps,
  text: string
): boolean {
  return deps.canSendMessage(text, deps.stateData.busy, deps.sending);
}

function validateCharacterLimit(
  deps: ValidateAndPrepareDeps,
  text: string
): string | undefined {
  const charLimit = deps.getCharacterLimit();
  if (text.length <= charLimit) {
    return undefined;
  }

  return `Message too long. Please limit to ${charLimit.toLocaleString()} characters for ${
    deps.prefs['arduino.spectre.model']
  }.`;
}

function applyRateLimit(lastSendAtRef: { value: number }): boolean {
  const now = Date.now();
  if (now - lastSendAtRef.value < 350) {
    return false;
  }
  lastSendAtRef.value = now;
  return true;
}

async function appendUserMessageToSessions(
  deps: ValidateAndPrepareDeps,
  text: string
): Promise<ChatSession[]> {
  const sessions = deps.stateData.sessions.slice();
  const current = sessions[deps.stateData.active];
  if (!current) {
    return sessions;
  }

  if (!current.memory) {
    current.memory = deps.memoryManager.createConversation(
      current.id.toString()
    );
  }

  if (current.memory) {
    await deps.memoryManager.addMessage(current.memory, 'user', text);
    deps.saveSessionMemory(current.id);
  }

  const shouldUpdateTitle =
    current.messages.length === 0 || current.title === 'New Chat';
  const newTitle = shouldUpdateTitle ? autoTitle(text) : current.title;

  sessions[deps.stateData.active] = {
    ...current,
    title: newTitle,
    messages: [
      ...current.messages,
      { id: `msg-${Date.now()}-user`, role: 'user', text },
    ],
  };

  return sessions;
}

function createRequestMeta(deps: ValidateAndPrepareDeps): {
  requestSeq: number;
  model: string;
  abortKey: string;
} {
  return {
    requestSeq: deps.stateData.requestSeq + 1,
    model: deps.prefs['arduino.spectre.model'],
    abortKey: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

function clearInputElement(inputElement?: HTMLTextAreaElement | null): void {
  if (!inputElement) {
    return;
  }
  inputElement.value = '';
  UiUtilities.autoGrowTextArea(inputElement, 300);
}

function setBusyState(
  deps: ValidateAndPrepareDeps,
  sessions: ChatSession[],
  requestSeq: number,
  abortKey: string
): void {
  const requestSessionId = sessions[deps.stateData.active]?.id;
  deps.setStateData({
    sessions,
    input: '',
    busy: true,
    error: undefined,
    requestSeq,
    currentAbortKey: abortKey,
    requestSessionId,
  });
}

function finalizePreparation(deps: ValidateAndPrepareDeps): void {
  deps.updateMemoryStats();
  deps.persist();
  deps.deferScroll();
}

export interface BasicModeSendDeps {
  ai: SpectreAiService;
  getStateData: () => BasicChatStateData;
  memoryManager: MemoryManager;

  prefs: {
    ['arduino.spectre.model']: string;
    ['arduino.spectre.thinkingLevel']: string;
    ['arduino.spectre.grounding']: boolean;
  };
  getPacificDate: () => string;
  persistTrackingData: () => Promise<void> | void;
  isNetworkError: (message: string) => boolean;

  // streaming + UI updates
  streamAttach: (abortKey: string, requestSeq: number) => void;
  appendAssistant: (text: string, requestSeq: number) => Promise<void>;
  mutateLastAssistant: (
    mutator: (text: string) => string,
    requestSeq: number,
    parts?: any[]
  ) => Promise<void>;
  streamHasStarted: () => boolean;

  setStateData: (
    patch: Partial<BasicChatStateData> & { sessions?: ChatSession[] }
  ) => void;
  persist: () => void;
  deferScroll: () => void;
  focusInput: () => void;

  buildSketchContext: (
    files: Array<{ path: string; content: string }>
  ) => string;
}

export function startBasicModeGeneration(params: {
  deps: BasicModeSendDeps;
  prepared: ValidateAndPrepareResult;
  sketchFiles: Array<{ path: string; content: string }>;
}): void {
  const { deps, prepared, sketchFiles } = params;
  const { text, requestSeq, abortKey, model, sessions } = prepared;

  const state = deps.getStateData();
  const requestedId = state.requestSessionId;
  const idx = requestedId
    ? sessions.findIndex((s) => s.id === requestedId)
    : state.active;
  const current = sessions[idx];

  // Basic mode: Create empty assistant message and attach stream listener
  void deps.appendAssistant('', requestSeq);
  deps.streamAttach(abortKey, requestSeq);

  // Build context prompt
  const contextualPrompt = buildBasicModeContext({
    text,
    sketchFiles,
    buildSketchContext: deps.buildSketchContext,
  });

  // Build conversation history from memory system
  const session = requestedId
    ? state.sessions.find((s) => s.id === requestedId)
    : state.sessions[state.active];
  const conversationHistory = buildConversationHistory({
    memoryManager: deps.memoryManager,
    buildSketchContext: deps.buildSketchContext,
    session,
    text,
    sketchFiles,
    model,
  });

  // Calculate token estimate
  const estTokens = conversationHistory.reduce(
    (sum, msg) => sum + TokenCounter.fastEstimate(msg.text),
    TokenCounter.fastEstimate(contextualPrompt)
  );

  const genConfig = createGenerationConfig({
    contextualPrompt,
    model,
    abortKey,
    conversationHistory,
    thinkingLevel: normalizeThinkingLevel(
      deps.prefs['arduino.spectre.thinkingLevel']
    ),
    enableGoogleSearch: deps.prefs['arduino.spectre.grounding'] === true,
  });

  deps.ai
    .generate(genConfig)
    .then(
      (res) =>
        void handleGenerationSuccess({
          deps,
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
      handleGenerationError({ deps, err, requestSeq, model, estTokens })
    );
}

function buildBasicModeContext(params: {
  text: string;
  sketchFiles: Array<{ path: string; content: string }>;
  buildSketchContext: (
    files: Array<{ path: string; content: string }>
  ) => string;
}): string {
  const { text, sketchFiles, buildSketchContext } = params;

  if (sketchFiles.length === 0) {
    return text;
  }

  const sketchContext = buildSketchContext(sketchFiles);
  return `Here are my current Arduino sketch files:\n\n${sketchContext}\n\n**User question:** ${text}`;
}

function buildConversationHistory(params: {
  memoryManager: MemoryManager;
  buildSketchContext: (
    files: Array<{ path: string; content: string }>
  ) => string;
  session: ChatSession | undefined;
  text: string;
  sketchFiles: Array<{ path: string; content: string }>;
  model: string;
}): Array<{ role: 'user' | 'model'; text: string; parts?: any[] }> {
  const {
    memoryManager,
    buildSketchContext,
    session,
    text,
    sketchFiles,
    model,
  } = params;
  const conversationHistory: Array<{
    role: 'user' | 'model';
    text: string;
    parts?: any[];
  }> = [];

  if (!session?.memory) {
    return conversationHistory;
  }

  // Determine token budget based on model type
  const targetBudget = (() => {
    if (model === 'gemini-3.1-flash-lite') return 30_000; // Lightweight model
    if (model.startsWith('gemma-4-')) return 40_000; // Gemma high-capacity models
    return 50_000; // Default/other models
  })();

  const sketchContext =
    sketchFiles.length > 0 ? buildSketchContext(sketchFiles) : '';

  memoryManager.assemblePrompt(session.memory, {
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
  // IMPORTANT: exclude the most recent user message because it is sent separately as the
  // current request prompt (often wrapped with sketch context).
  const recent = session.memory.recentMessages;
  const endExclusive =
    recent.length > 0 && recent[recent.length - 1].role === 'user'
      ? recent.length - 1
      : recent.length;

  for (let i = 0; i < endExclusive; i++) {
    const msg = recent[i];
    conversationHistory.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      text: msg.text,
      parts: msg.parts,
    });
  }

  return conversationHistory;
}

function createGenerationConfig(params: {
  contextualPrompt: string;
  model: string;
  abortKey: string;
  conversationHistory: Array<{
    role: 'user' | 'model';
    text: string;
    parts?: any[];
  }>;
  thinkingLevel: SpectreAiRequest['thinkingLevel'];
  enableGoogleSearch: boolean;
}): SpectreAiRequest {
  const {
    contextualPrompt,
    model,
    abortKey,
    conversationHistory,
    thinkingLevel,
    enableGoogleSearch,
  } = params;
  return {
    prompt: contextualPrompt,
    model: model as SpectreAiRequest['model'],
    generationConfig: getModelGenerationConfig(),
    includeThoughts: shouldIncludeThoughts(thinkingLevel),
    abortKey,
    thinkingLevel,
    enableGoogleSearch,
    context: buildConversationContext(conversationHistory),
  };
}

function getModelGenerationConfig(): { maxOutputTokens: number; topP: number } {
  return {
    maxOutputTokens: 65536,
    topP: 0.9,
  };
}

function shouldIncludeThoughts(
  thinkingLevel: SpectreAiRequest['thinkingLevel']
): boolean {
  return thinkingLevel !== 'OFF';
}

function buildConversationContext(
  conversationHistory: Array<{
    role: 'user' | 'model';
    text: string;
    parts?: any[];
  }>
): {
  conversation?: Array<{
    role: 'user' | 'model';
    text: string;
    parts?: any[];
  }>;
} {
  return {
    conversation:
      conversationHistory.length > 0 ? conversationHistory : undefined,
  };
}

async function handleGenerationSuccess(params: {
  deps: BasicModeSendDeps;
  res: SpectreAiResponse;
  requestSeq: number;
  abortKey: string;
  text: string;
  model: string;
  estTokens: number;
  current: ChatSession;
}): Promise<void> {
  const { deps, res, requestSeq, abortKey, text, model, estTokens, current } =
    params;

  if (!isActiveRequest(deps, requestSeq)) {
    return;
  }

  const actualTokensUsed = res.meta?.totalTokens || estTokens;
  logRequest({ deps, tokensUsed: actualTokensUsed, model, success: true });
  await applyResultToLastAssistant({ deps, res, requestSeq, abortKey });
  updateTitleIfNeeded({ deps, current, text });

  deps.persist();
  deps.deferScroll();
  deps.focusInput();
}

function isActiveRequest(deps: BasicModeSendDeps, requestSeq: number): boolean {
  return requestSeq === deps.getStateData().requestSeq;
}

async function applyResultToLastAssistant(params: {
  deps: BasicModeSendDeps;
  res: SpectreAiResponse;
  requestSeq: number;
  abortKey: string;
}): Promise<void> {
  const { deps, res, requestSeq, abortKey } = params;
  if (deps.getStateData().currentAbortKey !== abortKey) {
    return;
  }

  deps.setStateData({ busy: false, currentAbortKey: undefined });
  
  // Always update parts if available (Gemini 3 compliance), regardless of streaming state
  // If stream hasn't started, we also update the full text.
  if (res.text && !deps.streamHasStarted()) {
    await deps.mutateLastAssistant(() => res.text, requestSeq, res.parts);
  } else if (res.parts) {
    // Stream has started, but we need to attach the final parts (thoughts) to the message in memory
    await deps.mutateLastAssistant((t) => t, requestSeq, res.parts);
  }
}

function updateTitleIfNeeded(params: {
  deps: BasicModeSendDeps;
  current: ChatSession;
  text: string;
}): void {
  const { deps, current, text } = params;
  const state = deps.getStateData();
  const after = state.sessions.slice();
  const requestedId = state.requestSessionId;
  const idx = requestedId
    ? after.findIndex((s) => s.id === requestedId)
    : state.active;
  const cur = after[idx];
  if (!cur) {
    return;
  }

  const shouldUpdateTitle =
    current.messages.length === 1 || cur.title === 'New Chat';
  const newTitle = shouldUpdateTitle ? autoTitle(text) : cur.title;
  after[idx] = { ...cur, title: newTitle };
  deps.setStateData({ sessions: after });
}

function handleGenerationError(params: {
  deps: BasicModeSendDeps;
  err: unknown;
  requestSeq: number;
  model: string;
  estTokens: number;
}): void {
  const { deps, err, requestSeq, model, estTokens } = params;
  const errMessage =
    err instanceof Error
      ? err.message
      : (err as { message?: string })?.message || String(err);

  spectreError('Spectre AI generation failed:', errMessage);

  if (requestSeq !== deps.getStateData().requestSeq) {
    return;
  }

  logRequest({ deps, tokensUsed: estTokens, model, success: false });

  const { errorMessage, shouldRetry } = classifyError({ deps, err });
  displayErrorMessage({ deps, errorMessage, shouldRetry });
}

function logRequest(params: {
  deps: BasicModeSendDeps;
  tokensUsed: number;
  model: string;
  success: boolean;
}): void {
  const { deps, tokensUsed, model, success } = params;
  const now = Date.now();

  const state = deps.getStateData();
  const requestLogs = [
    ...state.requestLogs,
    { timestamp: now, tokensUsed, model, success },
  ];

  const currentDate = deps.getPacificDate();
  const existingTracker = state.dailyTracker;
  const baseTracker =
    existingTracker.date === currentDate
      ? existingTracker
      : { date: currentDate, requestCount: 0, tokenCount: 0 };

  const dailyTracker: DailyTracker = {
    date: currentDate,
    requestCount: baseTracker.requestCount + 1,
    tokenCount: baseTracker.tokenCount + tokensUsed,
  };

  deps.setStateData({ requestLogs, dailyTracker });

  // Best-effort persistence; UI can still proceed if this fails.
  void deps.persistTrackingData();
}

function classifyError(params: { deps: BasicModeSendDeps; err: unknown }): {
  errorMessage: string;
  shouldRetry: boolean;
} {
  const { deps, err } = params;

  const message =
    err instanceof Error ? err.message : (err as { message?: string })?.message;

  if (!message) {
    return {
      errorMessage: 'An error occurred while generating response.',
      shouldRetry: false,
    };
  }

  const lower = String(message).toLowerCase();

  const rules: Array<{
    match: () => boolean;
    errorMessage: string;
    shouldRetry: boolean;
  }> = [
    {
      match: () => deps.isNetworkError(String(message)),
      errorMessage:
        'Network error. Please check your connection and try again.',
      shouldRetry: true,
    },
    {
      match: () =>
        lower.includes('api key') || lower.includes('authentication'),
      errorMessage: 'API key error. Please check your Spectre settings.',
      shouldRetry: false,
    },
    {
      match: () => lower.includes('quota') || lower.includes('limit'),
      errorMessage:
        'API quota exceeded. Please wait before sending another message.',
      shouldRetry: true,
    },
    {
      match: () => lower.includes('timeout'),
      errorMessage: 'Request timed out. Please try again.',
      shouldRetry: true,
    },
  ];

  for (const rule of rules) {
    if (rule.match()) {
      return { errorMessage: rule.errorMessage, shouldRetry: rule.shouldRetry };
    }
  }

  return { errorMessage: String(message), shouldRetry: false };
}

function displayErrorMessage(params: {
  deps: BasicModeSendDeps;
  errorMessage: string;
  shouldRetry: boolean;
}): void {
  const { deps, errorMessage, shouldRetry } = params;

  const state = deps.getStateData();
  const sessions = state.sessions.slice();
  const current = sessions[state.active];
  if (!current) {
    deps.setStateData({
      busy: false,
      error: errorMessage,
      currentAbortKey: undefined,
      retryable: shouldRetry,
    });
    deps.deferScroll();
    return;
  }
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
  sessions[state.active] = { ...current, messages };

  deps.setStateData({
    sessions,
    busy: false,
    error: errorMessage,
    currentAbortKey: undefined,
    retryable: shouldRetry,
  });
  deps.deferScroll();
}
