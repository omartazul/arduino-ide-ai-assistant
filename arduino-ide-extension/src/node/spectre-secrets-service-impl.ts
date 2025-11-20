/**
 * Backend implementation of Spectre secrets management.
 * Handles secure storage of Gemini API keys using OS keychain with file fallback.
 *
 * @author Tazul Islam
 */

import { injectable } from '@theia/core/shared/inversify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SpectreSecretsService,
  SpectreSecretsServiceClient,
  SpectreSecretsStatus,
} from '../common/protocol/spectre-secrets-service';
import { Keychain } from './auth/keychain';
import { spectreWarn } from '../common/protocol/spectre-types';

const SERVICE_SECTION = 'arduino-ide.spectre';
const ACCOUNT = 'geminiApiKey';

@injectable()
export class SpectreSecretsServiceImpl implements SpectreSecretsService {
  /** Registered frontend clients for status change notifications */
  private readonly clients = new Set<SpectreSecretsServiceClient>();

  private readonly keychain = new Keychain({
    credentialsSection: SERVICE_SECTION,
    account: ACCOUNT,
  });

  /**
   * Storage strategy (in priority order):
   * 1. In-memory cache - Fast path for repeated reads
   * 2. OS keychain - Secure storage (keytar/keychain) when available
   * 3. File fallback - Plain text file (~/.arduino-ide/spectre.key) if keychain unavailable
   *
   * Note: File fallback is NOT encrypted, used only when OS keychain fails.
   */
  private memoryCache?: string;
  private readonly fallbackFile = path.join(
    os.homedir(),
    '.arduino-ide',
    'spectre.key'
  );

  /**
   * Read API key from storage (memory → keychain → file).
   * @returns API key if found, undefined otherwise
   */
  private async readKey(): Promise<string | undefined> {
    // 1. Memory cache (fastest)
    if (this.memoryCache) {
      return this.memoryCache;
    }

    // 2. Try secure keychain first
    try {
      const keychainKey = await this.keychain.getStoredCredentials();
      if (keychainKey) {
        this.memoryCache = keychainKey;
        return keychainKey;
      }
    } catch {
      // Keychain unavailable or failed, continue to file fallback
    }

    // 3. File fallback (unencrypted, best-effort only)
    try {
      const fileKey = await fs.promises.readFile(this.fallbackFile, 'utf8');
      const key = fileKey.trim();
      if (key) {
        this.memoryCache = key;
        return key;
      }
    } catch {
      // File doesn't exist or unreadable
    }

    return undefined;
  }

  /**
   * Write API key to storage (keychain + file fallback + memory).
   * Strategy: Write to all storage locations in parallel for best reliability.
   * @param key API key to store, or undefined to clear
   */
  private async writeKey(key: string | undefined): Promise<void> {
    if (!key) {
      // Clear all storage locations
      await Promise.allSettled([
        this.keychain.deleteCredentials(),
        this.deleteFile(),
      ]);
      this.memoryCache = undefined;
      return;
    }

    // Store in memory immediately for fast access
    this.memoryCache = key;

    // Write to both keychain and file in parallel (best-effort)
    // We don't await to avoid blocking, but we do want to attempt both
    await Promise.allSettled([
      this.keychain.storeCredentials(key),
      this.writeFile(key),
    ]);
  }

  /**
   * Write API key to file fallback.
   */
  private async writeFile(key: string): Promise<void> {
    const dir = path.dirname(this.fallbackFile);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(this.fallbackFile, key, { mode: 0o600 });
  }

  /**
   * Delete file fallback if it exists.
   */
  private async deleteFile(): Promise<void> {
    try {
      await fs.promises.unlink(this.fallbackFile);
    } catch (error: any) {
      // Ignore ENOENT (file doesn't exist) - that's the desired state
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  setClient(client: SpectreSecretsServiceClient): void {
    this.clients.add(client);
  }

  disposeClient(client: SpectreSecretsServiceClient): void {
    this.clients.delete(client);
  }

  dispose(): void {
    this.clients.clear();
  }

  async getStatus(): Promise<SpectreSecretsStatus> {
    const key = await this.readKey();
    return { hasApiKey: !!key };
  }

  async getApiKey(): Promise<string | undefined> {
    // Check environment variable first (for development/testing)
    const envKey = process.env.ARDUINO_GEMINI_API_KEY?.trim();
    if (envKey) {
      return envKey;
    }
    // Fall back to stored key
    return this.readKey();
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.writeKey(apiKey);
    this.notifyStatusChange({ hasApiKey: true });
  }

  async clearApiKey(): Promise<void> {
    await this.writeKey(undefined);
    this.notifyStatusChange({ hasApiKey: false });
  }

  /**
   * Notify all registered frontend clients of API key status changes.
   * Safely handles cases where clients are not yet registered or disconnect during notification.
   */
  private notifyStatusChange(status: SpectreSecretsStatus): void {
    this.clients.forEach((client) => {
      try {
        client.onStatusChange(status);
      } catch (error) {
        // Client notification errors should not break the service
        spectreWarn('Failed to notify secrets service client:', error);
      }
    });
  }
}
