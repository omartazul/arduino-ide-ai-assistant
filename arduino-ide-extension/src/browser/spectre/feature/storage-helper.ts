/**
 * Helper utilities for persistent storage operations.
 * Handles session persistence and tracking data storage.
 *
 * @author Tazul Islam
 */

import { spectreWarn } from '../../../common/protocol/spectre-types';
import type { RequestLog, DailyTracker } from '../chat/chat-tools';
import type { ChatSession } from '../ui/widget-rendering';

/**
 * Storage interface for chat sessions and tracking data.
 */
interface StorageService {
  setData(key: string, value: unknown): Promise<void>;
  getData<T>(key: string): Promise<T | undefined>;
}

/**
 * Parameters for persisting all storage data.
 */
interface PersistAllParams {
  storage: StorageService;
  sketchKey: string | undefined;
  sessions: ChatSession[];
  requestLogs: RequestLog[];
  dailyTracker: DailyTracker;
}

/**
 * Helper class for storage persistence operations.
 */
export class StorageHelper {
  /**
   * Persists both chat sessions and tracking data to storage.
   */
  static async persistAll(params: PersistAllParams): Promise<void> {
    const { storage, sketchKey, sessions, requestLogs, dailyTracker } = params;
    if (sketchKey) {
      await storage.setData(sketchKey, sessions);
    }
    await StorageHelper.persistTrackingData(storage, requestLogs, dailyTracker);
  }

  /**
   * Persists request tracking data to global storage.
   */
  static async persistTrackingData(
    storage: StorageService,
    requestLogs: RequestLog[],
    dailyTracker: DailyTracker
  ): Promise<void> {
    try {
      await storage.setData('spectre.requestLogs', requestLogs);
      await storage.setData('spectre.dailyTracker', dailyTracker);
    } catch (error) {
      spectreWarn('Failed to persist tracking data:', error);
    }
  }

  /**
   * Loads tracking data from storage.
   */
  static async loadTrackingData(
    storage: StorageService
  ): Promise<{ requestLogs: RequestLog[]; dailyTracker: DailyTracker }> {
    try {
      const requestLogs =
        (await storage.getData<RequestLog[]>('spectre.requestLogs')) || [];
      const dailyTracker =
        (await storage.getData<DailyTracker>('spectre.dailyTracker')) ||
        ({
          date: '',
          requestCount: 0,
          tokenCount: 0,
        } as DailyTracker);
      return { requestLogs, dailyTracker };
    } catch (error) {
      spectreWarn('Failed to load tracking data:', error);
      return {
        requestLogs: [],
        dailyTracker: { date: '', requestCount: 0, tokenCount: 0 },
      };
    }
  }

  /**
   * Loads sessions for a specific sketch.
   */
  static async loadSketchSessions(
    storage: StorageService,
    sketchKey: string
  ): Promise<ChatSession[] | undefined> {
    try {
      return await storage.getData<ChatSession[]>(sketchKey);
    } catch (error) {
      spectreWarn(`Failed to load sessions for ${sketchKey}:`, error);
      return undefined;
    }
  }
}
