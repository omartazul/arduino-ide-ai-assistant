/**
 * Helper utilities for session memory persistence and management.
 * Handles localStorage operations, memory serialization, and session restoration.
 *
 * @author Tazul Islam
 */

import type { ConversationMemory } from './memory-types';
import type { MemoryManager } from './memory-manager';
import { spectreError } from '../../../common/protocol/spectre-types';

/**
 * Helper class for memory persistence operations.
 */
export class MemoryHelper {
  /**
   * Saves session memory to localStorage for persistence across reloads.
   * Called after each message is added to memory.
   */
  static saveSessionMemory(
    sessionId: number,
    memory: ConversationMemory
  ): void {
    if (!memory) {
      return;
    }

    try {
      const serialized = JSON.stringify({
        sessionId: memory.sessionId,
        recentMessages: memory.recentMessages,
        memoryBank: memory.memoryBank,
        stats: memory.stats,
        config: memory.config,
      });
      localStorage.setItem(`spectre-memory-${sessionId}`, serialized);
    } catch (error) {
      spectreError('Failed to save session memory:', error);
    }
  }

  /**
   * Loads session memory from localStorage when restoring a session.
   * Returns undefined if no saved memory exists.
   */
  static loadSessionMemory(
    sessionId: number,
    memoryManager: MemoryManager
  ): ConversationMemory | undefined {
    try {
      const stored = localStorage.getItem(`spectre-memory-${sessionId}`);
      if (!stored) {
        return undefined;
      }

      const parsed = JSON.parse(stored);

      // Reconstruct memory object with proper structure
      const memory = memoryManager.createConversation(
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

      return memory;
    } catch (error) {
      spectreError('Failed to load session memory:', error);
      return undefined;
    }
  }
}
