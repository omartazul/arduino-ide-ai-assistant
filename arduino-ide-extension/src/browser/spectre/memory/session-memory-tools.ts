/**
 * Session memory migration and persistence helpers for Spectre.
 *
 * @author Tazul Islam
 */

import { spectreWarn } from '../../../common/protocol/spectre-types';

import { MemoryHelper } from './memory-helper';
import { MemoryManager } from './memory-manager';
import { ConversationMemory, RawMessage } from './memory-types';
import { TokenCounter } from '../utils/token-counter';

export interface SessionMemoryToolsState {
  sessions: Array<{ id: number; messages: any[]; memory?: ConversationMemory }>;
  active: number;
  memoryStats?: any;
}

export interface SessionMemoryToolsDeps {
  memoryManager: MemoryManager;
  getStateData: () => SessionMemoryToolsState;
  setStateData: (patch: Partial<SessionMemoryToolsState>) => void;
}

export async function migrateSessions(params: {
  deps: SessionMemoryToolsDeps;
  oldSessions: Array<{
    id: number;
    messages: any[];
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
  messages: any[];
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
  deps.setStateData({
    memoryStats: {
      ...current.memoryStats,
      isSummarizing: true,
    } as any,
  });

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
