/**
 * Protocol definitions for Spectre secrets management.
 * Defines secure API key storage interfaces.
 *
 * @author Tazul Islam
 */

import { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

/**
 * Service path for JSON-RPC communication between frontend and backend.
 * Used by WebSocketConnectionProvider to establish the connection.
 */
export const SpectreSecretsServicePath = '/services/spectre-secrets';

/**
 * DI token for the Spectre secrets service.
 * Used for dependency injection binding and resolution.
 */
export const SpectreSecretsService = Symbol('SpectreSecretsService');

/**
 * Status information about the Spectre API key.
 * Used to communicate key availability between backend and frontend.
 *
 * @property hasApiKey - True if API key is stored in secure storage
 */
export interface SpectreSecretsStatus {
  hasApiKey: boolean;
}

/**
 * Backend service interface for managing Spectre API key secrets.
 * Handles secure storage, retrieval, and status notifications for API keys.
 * Extends RpcServer to enable bidirectional communication with frontend clients.
 */
export interface SpectreSecretsService
  extends RpcServer<SpectreSecretsServiceClient> {
  /**
   * Retrieves current API key status from secure storage.
   *
   * @returns Promise resolving to status indicating if key is stored
   */
  getStatus(): Promise<SpectreSecretsStatus>;

  /**
   * Retrieves the stored API key from secure storage.
   * Used internally by AI service to make API calls.
   *
   * @returns Promise resolving to API key if stored, undefined otherwise
   */
  getApiKey(): Promise<string | undefined>;

  /**
   * Stores API key securely in the platform keychain.
   * Notifies all connected clients of status change.
   *
   * @param apiKey - The Gemini API key to store securely
   * @returns Promise resolving when key is stored
   */
  setApiKey(apiKey: string): Promise<void>;

  /**
   * Removes API key from secure storage.
   * Notifies all connected clients of status change.
   *
   * @returns Promise resolving when key is cleared
   */
  clearApiKey(): Promise<void>;

  /**
   * Unregisters a client when connection is closed.
   * Ensures proper cleanup of resources.
   *
   * @param client - Frontend client to remove
   */
  disposeClient(client: SpectreSecretsServiceClient): void;
}

/**
 * Client interface for receiving status updates from the secrets service.
 * Allows the backend to push API key status changes to the frontend.
 */
export interface SpectreSecretsServiceClient {
  /**
   * Called when API key status changes (set, cleared, or validation state changes).
   * @param status The new status of the API key
   */
  onStatusChange(status: SpectreSecretsStatus): void;
}
