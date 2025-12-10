/**
 * Helper utilities for persistent storage operations.
 * Handles session persistence and tracking data storage.
 *
 * @author Tazul Islam
 */

import { spectreWarn } from '../../../common/protocol/spectre-types';

/**
 * Storage interface for chat sessions and tracking data.
 */
export interface StorageService {
  setData(key: string, value: any): Promise<void>;
  getData<T>(key: string): Promise<T | undefined>;
}

/**
 * Parameters for persisting all storage data.
 */
export interface PersistAllParams {
  storage: StorageService;
  sketchKey: string | undefined;
  sessions: any[];
  requestLogs: any[];
  dailyTracker: any;
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
    requestLogs: any[],
    dailyTracker: any
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
  ): Promise<{ requestLogs: any[]; dailyTracker: any }> {
    try {
      const requestLogs = (await storage.getData<any[]>('spectre.requestLogs')) || [];
      const dailyTracker = (await storage.getData<any>('spectre.dailyTracker')) || {};
      return { requestLogs, dailyTracker };
    } catch (error) {
      spectreWarn('Failed to load tracking data:', error);
      return { requestLogs: [], dailyTracker: {} };
    }
  }

  /**
   * Loads sessions for a specific sketch.
   */
  static async loadSketchSessions(
    storage: StorageService,
    sketchKey: string
  ): Promise<any[] | undefined> {
    try {
      return await storage.getData<any[]>(sketchKey);
    } catch (error) {
      spectreWarn(`Failed to load sessions for ${sketchKey}:`, error);
      return undefined;
    }
  }
}
