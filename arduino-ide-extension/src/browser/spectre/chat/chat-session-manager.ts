/**
 * Consolidated Chat Session Manager
 *
 * This file consolidates:
 * - session-actions.ts
 * - session-memory-tools.ts (from memory/)
 *
 * @author Tazul Islam
 */

import { spectreWarn } from '../../../common/protocol/spectre-types';
import { CurrentSketch } from '../../sketches-service-client-impl';
import type { StorageService } from '@theia/core/lib/browser/storage-service';
import type { ChatSession, ChatMessage } from '../ui/widget-rendering';
import { AgentTask } from '../agent/agent-utils';
import type { MemoryManager } from '../memory/memory-manager';
import type { ConversationMemory, RawMessage } from '../memory/memory-types';
import { MemoryHelper } from '../memory/memory-helper';
import { TokenCounter } from '../utils/token-counter';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface DailyTracker {
  date: string;
  requestCount: number;
  tokenCount: number;
}

export interface RequestLog {
  timestamp: number;
  tokensUsed: number;
  model: string;
  success: boolean;
}

export interface MemoryStats {
  recentMessages: number;
  summaries: number;
  totalTokens: number;
  memoryBankTokens: number;
  compressionRatio: string;
  isSummarizing: boolean;
}

export interface ChatManagerState {
  sessions: ChatSession[];
  active: number;
  memoryStats?: MemoryStats;
  requestLogs: RequestLog[];
  dailyTracker: DailyTracker;
  sketchKey?: string;
  error?: string;
  tasks?: AgentTask[];
}

export interface SessionMemoryToolsState {
  sessions: ChatSession[];
  active: number;
  memoryStats?: MemoryStats;
}

export interface SessionMemoryToolsDeps {
  memoryManager: MemoryManager;
  getStateData: () => SessionMemoryToolsState;
  setStateData: (patch: Partial<SessionMemoryToolsState>) => void;
}

export interface LoadForCurrentSketchDeps {
  sketchesClient: { tryGetCurrentSketch(): CurrentSketch | undefined };
  storage: StorageService;
  getPacificDate: () => string;
  setStateData: (patch: Partial<ChatManagerState>) => void;
  updateMemoryStats: () => void;
  migrateSessions: (oldSessions: ChatSession[]) => Promise<ChatSession[]>;
  createSessionWithMemory: (sessionId?: number) => Promise<ChatSession>;
}

// ============================================================================
// Session Loading and Storage
// ============================================================================

export async function loadForCurrentSketch(
  deps: LoadForCurrentSketchDeps
): Promise<void> {
  const sketch = deps.sketchesClient.tryGetCurrentSketch();
  const key = storageKeyFor(sketch);

  await loadTrackingData({
    storage: deps.storage,
    getPacificDate: deps.getPacificDate,
    setStateData: deps.setStateData,
  });

  if (key) {
    const saved = await deps.storage.getData<ChatSession[]>(key);
    if (Array.isArray(saved)) {
      const migratedSessions = await deps.migrateSessions(saved);
      deps.setStateData({
        sessions: migratedSessions,
        active: 0,
        sketchKey: key,
      });
      deps.updateMemoryStats();
      return;
    }
  }

  const newSession = await deps.createSessionWithMemory();
  deps.setStateData({ sessions: [newSession], active: 0, sketchKey: key });
  deps.updateMemoryStats();
}

function storageKeyFor(sketch: CurrentSketch | undefined): string | undefined {
  return CurrentSketch.isValid(sketch)
    ? `spectre.chat.${sketch.uri}`
    : undefined;
}

async function loadTrackingData(deps: {
  storage: StorageService;
  getPacificDate: () => string;
  setStateData: (patch: Partial<ChatManagerState>) => void;
}): Promise<void> {
  try {
    const savedLogs =
      (await deps.storage.getData<RequestLog[]>('spectre.requestLogs')) || [];
    const sixtySecondsAgo = Date.now() - 60 * 1000;
    const validLogs = savedLogs.filter(
      (log) => log.timestamp > sixtySecondsAgo
    );

    const savedDaily = await deps.storage.getData<DailyTracker>(
      'spectre.dailyTracker'
    );
    const currentDate = deps.getPacificDate();

    const dailyTracker =
      savedDaily && savedDaily.date === currentDate
        ? savedDaily
        : { date: currentDate, requestCount: 0, tokenCount: 0 };

    deps.setStateData({ requestLogs: validLogs, dailyTracker });
  } catch (error) {
    spectreWarn('Failed to load tracking data:', error);
    deps.setStateData({
      requestLogs: [],
      dailyTracker: {
        date: deps.getPacificDate(),
        requestCount: 0,
        tokenCount: 0,
      },
    });
  }
}

// ============================================================================
// Session Actions
// ============================================================================

export async function newChat(params: {
  createSessionWithMemory: () => Promise<ChatSession>;
  stateData: { sessions: ChatSession[] };
  setStateData: (patch: Partial<ChatManagerState>) => void;
  updateMemoryStats: () => void;
  persist: () => void;
}): Promise<void> {
  const newSession = await params.createSessionWithMemory();
  const sessions = [...params.stateData.sessions, newSession];

  params.setStateData({
    sessions,
    active: sessions.length - 1,
    error: undefined,
    tasks: [],
  });
  params.updateMemoryStats();
  params.persist();
}

export async function clearChat(params: {
  memoryManager: MemoryManager;
  stateData: { sessions: ChatSession[]; active: number };
  setStateData: (patch: Partial<ChatManagerState>) => void;
  updateMemoryStats: () => void;
  persist: () => void;
}): Promise<void> {
  const sessions = params.stateData.sessions.slice();
  const currentSession = sessions[params.stateData.active];

  const newMemory = params.memoryManager.createConversation(
    currentSession.id.toString()
  );

  sessions[params.stateData.active] = {
    ...currentSession,
    messages: [],
    title: 'New Chat',
    memory: newMemory,
  };

  params.setStateData({ sessions, error: undefined, tasks: [] });
  params.updateMemoryStats();
  params.persist();
}

export async function closeChat(params: {
  stateData: { sessions: ChatSession[]; active: number };
  createSessionWithMemory: () => Promise<ChatSession>;
  setStateData: (patch: Partial<ChatManagerState>) => void;
  updateMemoryStats: () => void;
  persist: () => void;
}): Promise<void> {
  const sessions = params.stateData.sessions.slice();
  sessions.splice(params.stateData.active, 1);

  if (!sessions.length) {
    const newSession = await params.createSessionWithMemory();
    sessions.push(newSession);
  }

  const active = Math.min(params.stateData.active, sessions.length - 1);
  params.setStateData({ sessions, active, error: undefined });
  params.updateMemoryStats();
  params.persist();
}

// ============================================================================
// Memory Management
// ============================================================================

export async function migrateSessions(params: {
  deps: SessionMemoryToolsDeps;
  oldSessions: Array<{
    id: number;
    messages: ChatMessage[];
    memory?: ConversationMemory;
  }>;
}): Promise<SessionMemoryToolsState['sessions']> {
  const { deps, oldSessions } = params;

  const migrated: SessionMemoryToolsState['sessions'] = [];

  for (const session of oldSessions) {
    // Try to load persisted memory first
    const persistedMemory = loadSessionMemory({ deps, sessionId: session.id });

    if (persistedMemory) {
      migrated.push({
        ...session,
        title: 'Restored Session',
        memory: persistedMemory,
      });
      continue;
    }

    // Skip if already has memory system (but no persisted version)
    if (session.memory) {
      migrated.push({
        ...session,
        title: 'Restored Session',
      });
      continue;
    }

    // Create new memory system for this session
    const memory = deps.memoryManager.createConversation(
      session.id.toString(),
      {
        maxRecentMessages: 40,
        memoryBankTokenCap: 100_000,
      }
    );

    // Convert old messages to raw messages in memory
    for (const msg of session.messages) {
      const rawMsg: RawMessage = {
        id: msg.id,
        role: msg.role,
        text: msg.text,
        timestamp: Date.now(),
        estimatedTokens: TokenCounter.estimate(
          msg.text,
          msg.role === 'user' ? 'mixed' : 'natural'
        ),
      };
      memory.recentMessages.push(rawMsg);
    }

    // Trigger summarization if needed (async, non-blocking)
    if (memory.recentMessages.length > 30) {
      void performAsyncSummarization({ deps, memory }).catch((err) =>
        spectreWarn('Background summarization failed:', err)
      );
    }

    migrated.push({
      ...session,
      title: 'Restored Session',
      memory,
    });
  }

  return migrated;
}

export async function createSessionWithMemory(params: {
  deps: SessionMemoryToolsDeps;
  sessionId?: number;
}): Promise<{
  id: number;
  title: string;
  messages: ChatMessage[];
  memory: ConversationMemory;
}> {
  const { deps, sessionId } = params;
  const id = sessionId || Date.now();

  // Try to load existing memory from localStorage
  const existingMemory = loadSessionMemory({ deps, sessionId: id });
  const memory =
    existingMemory || deps.memoryManager.createConversation(id.toString());

  return {
    id,
    title: 'New Chat',
    messages: [],
    memory,
  };
}

export function saveSessionMemory(params: {
  deps: SessionMemoryToolsDeps;
  sessionId: number;
}): void {
  const { deps, sessionId } = params;
  const state = deps.getStateData();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session?.memory) {
    return;
  }
  MemoryHelper.saveSessionMemory(sessionId, session.memory);
}

export function loadSessionMemory(params: {
  deps: Pick<SessionMemoryToolsDeps, 'memoryManager'>;
  sessionId: number;
}): ConversationMemory | undefined {
  return MemoryHelper.loadSessionMemory(
    params.sessionId,
    params.deps.memoryManager
  );
}

export function updateMemoryStats(params: {
  deps: SessionMemoryToolsDeps;
}): void {
  const { deps } = params;
  const state = deps.getStateData();
  const session = state.sessions[state.active];
  if (!session?.memory) {
    deps.setStateData({ memoryStats: undefined });
    return;
  }

  const stats = deps.memoryManager.getStats(session.memory);
  deps.setStateData({
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

export async function performAsyncSummarization(params: {
  deps: SessionMemoryToolsDeps;
  memory: ConversationMemory;
}): Promise<void> {
  const { deps, memory } = params;

  // Show summarization indicator
  const current = deps.getStateData();
  if (current.memoryStats) {
    deps.setStateData({
      memoryStats: {
        ...current.memoryStats,
        isSummarizing: true,
      },
    });
  }

  try {
    // This will trigger summarization if thresholds are met
    const lastMessage = memory.recentMessages[memory.recentMessages.length - 1];
    if (lastMessage) {
      await deps.memoryManager.addMessage(
        memory,
        lastMessage.role,
        lastMessage.text
      );
    }
  } finally {
    updateMemoryStats({ deps });
  }
}
