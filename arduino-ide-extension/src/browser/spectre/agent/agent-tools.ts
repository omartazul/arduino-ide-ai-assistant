/**
 * Consolidated Agent Tools
 *
 * This file consolidates the following smaller agent tool files:
 * - library-tools.ts
 * - board-url-tools.ts
 * - agent-response-utilities.ts
 * - agent-helpers.ts
 * - task-helpers.ts
 *
 * @author Tazul Islam
 */

import {
  spectreError,
  spectreWarn,
} from '../../../common/protocol/spectre-types';
import { LibraryPackage } from '../../../common/protocol/library-service';
import { BoardsPackage } from '../../../common/protocol/boards-service';
import { BoardHelper, BoardUrlHelper } from '../board/board-helpers';
import { ValidationHelper } from '../utils/validation-helper';

// Canonical agent response/task parsing utilities live in agent-utils.
export type {
  AgentTask,
  AgentActionHistoryRecord,
  CleanAgentResponseResult,
} from './agent-utils';
export { parseTasksFromResponse, cleanAgentResponse } from './agent-utils';

// Keep completion helpers available from this consolidated module.
export * from './completion';

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function executeAgentAction(
  params: {
    logPrefix: string;
    actionDesc: string;
    getErrorMessage?: (err: unknown) => string;
    logError?: (msg: string, err: unknown) => void;
    errorHandler?: (err: unknown) => string;
  },
  action: () => Promise<string>
): Promise<string> {
  const {
    logPrefix,
    actionDesc,
    getErrorMessage = formatUnknownError,
    logError = spectreError,
    errorHandler,
  } = params;
  try {
    return await action();
  } catch (error: unknown) {
    if (logPrefix) {
      logError(`❌ ${logPrefix} error:`, error);
    }
    if (errorHandler) {
      return errorHandler(error);
    }
    return `❌ Failed to ${actionDesc}: ${getErrorMessage(error)}`;
  }
}

// ============================================================================

// Types and Interfaces
// ============================================================================

interface LibraryValidationParams {
  name: string;
  operation: 'install' | 'uninstall';
}

interface LibrarySearchParams {
  name: string;
  searchResults: LibraryPackage[];
}

type LibrarySearchResult =
  | { success: true; package: LibraryPackage }
  | { success: false; error: string };

interface LibraryMessageParams {
  name: string;
  version?: string;
  type:
    | 'notFound'
    | 'noVersions'
    | 'alreadyInstalled'
    | 'notInstalled'
    | 'installSuccess'
    | 'uninstallSuccess';
}

// ============================================================================
// Library Tools
// ============================================================================

export interface LibraryToolsContext {
  libraryService: {
    search(params: { query: string }): Promise<LibraryPackage[]>;
    install(params: { item: LibraryPackage; noDeps: boolean }): Promise<void>;
    uninstall(params: { item: LibraryPackage }): Promise<void>;
  };
  outputChannels: {
    getChannel(id: string): { appendLine(line: string): void };
  };
}

export async function agentInstallLibrary(
  ctx: LibraryToolsContext,
  libraryName: string
): Promise<string> {
  try {
    const validationError = AgentLibraryHelper.validateLibraryName({
      name: libraryName,
      operation: 'install',
    });
    if (validationError) return validationError;

    const searchResults = await ctx.libraryService.search({
      query: libraryName,
    });
    const result = AgentLibraryHelper.processSearchResults({
      name: libraryName,
      searchResults,
    });

    if (!result.success) return result.error;
    const libraryPackage = result.package;

    if (libraryPackage.installedVersion) {
      return AgentLibraryHelper.formatLibraryMessage({
        name: libraryPackage.name,
        version: libraryPackage.installedVersion,
        type: 'alreadyInstalled',
      });
    }

    const versionToInstall = libraryPackage.availableVersions?.[0];
    if (!versionToInstall) {
      return AgentLibraryHelper.formatLibraryMessage({
        name: libraryPackage.name,
        type: 'noVersions',
      });
    }

    await ctx.libraryService.install({
      item: libraryPackage,
      noDeps: false,
    });

    return AgentLibraryHelper.formatLibraryMessage({
      name: libraryPackage.name,
      type: 'installSuccess',
    });
  } catch (error: unknown) {
    spectreError('❌ Library installation error:', error);
    return ValidationHelper.formatLibraryInstallError(libraryName, error);
  }
}

export async function agentUninstallLibrary(
  ctx: LibraryToolsContext,
  libraryName: string
): Promise<string> {
  try {
    const validationError = AgentLibraryHelper.validateLibraryName({
      name: libraryName,
      operation: 'uninstall',
    });
    if (validationError) return validationError;

    const searchResults = await ctx.libraryService.search({
      query: libraryName,
    });
    const result = AgentLibraryHelper.processSearchResults({
      name: libraryName,
      searchResults,
    });

    if (!result.success) return result.error;
    const libraryPackage = result.package;

    if (!libraryPackage.installedVersion) {
      return AgentLibraryHelper.formatLibraryMessage({
        name: libraryPackage.name,
        type: 'notInstalled',
      });
    }

    await ctx.libraryService.uninstall({ item: libraryPackage });

    ctx.outputChannels
      .getChannel('Arduino')
      .appendLine(
        `Uninstalled ${libraryPackage.name}@${libraryPackage.installedVersion}`
      );

    return AgentLibraryHelper.formatLibraryMessage({
      name: libraryPackage.name,
      type: 'uninstallSuccess',
    });
  } catch (error: unknown) {
    spectreError('❌ Library uninstallation error:', error);
    return formatLibraryUninstallError(libraryName, error);
  }
}

function formatLibraryUninstallError(
  libraryName: string,
  error: unknown
): string {
  const errorMsg = error instanceof Error ? error.message : String(error);

  if (
    errorMsg.toLowerCase().includes('not found') ||
    errorMsg.toLowerCase().includes('not installed')
  ) {
    return `❌ Library "${libraryName}" is not installed or could not be found`;
  }

  return `❌ Failed to uninstall library "${libraryName}"\n\nError: ${errorMsg}`;
}

// ============================================================================
// Board URL Tools
// ============================================================================

export interface BoardUrlToolsTiming {
  PACKAGE_INDEX_POLL_INTERVAL: number;
}

export interface BoardUrlToolsContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commands: { executeCommand(id: string, ...args: any[]): Promise<any> };
  boardsService: {
    search(params: { query: string }): Promise<BoardsPackage[]>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configService: { getConfiguration(): Promise<any> };
  delay(ms: number): Promise<void>;
  timing: BoardUrlToolsTiming;
}

export async function agentAddBoardUrl(
  ctx: BoardUrlToolsContext,
  url: string
): Promise<string> {
  if (!url || !url.trim()) {
    return '❌ Board manager URL is required';
  }

  const urlValidationError = validateBoardManagerUrl(url);
  if (urlValidationError) {
    return urlValidationError;
  }

  try {
    const { urlAlreadyExists } = await BoardUrlHelper.addToConfiguration(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.configService as any,
      url
    );

    const updateResult = await updateAndWaitForPackageIndex(ctx);

    return BoardUrlHelper.formatBoardUrlMessage({
      type: 'addResult',
      url,
      urlAlreadyExists,
      updateResult,
    });
  } catch (error) {
    spectreError('❌ Failed to add board manager URL:', error);
    return `❌ Failed to add board manager URL: ${formatUnknownError(error)}`;
  }
}

function validateBoardManagerUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  const lengthError = validateUrlLength(trimmed);
  if (lengthError) return lengthError;

  const parsedResult = tryParseUrl(trimmed);
  if (!parsedResult.ok) return parsedResult.error;

  const parsed = parsedResult.url;
  const protocolError = validateHttpProtocol(parsed);
  if (protocolError) return protocolError;

  const credentialsError = validateNoCredentials(parsed);
  if (credentialsError) return credentialsError;

  const fileError = validateJsonPath(parsed);
  if (fileError) return fileError;

  return null;
}

function validateUrlLength(url: string): string | null {
  return url.length > 2048 ? '❌ Board manager URL is too long' : null;
}

function tryParseUrl(
  url: string
): { ok: true; url: URL } | { ok: false; error: string } {
  try {
    return { ok: true, url: new URL(url) };
  } catch {
    return {
      ok: false,
      error: '❌ Invalid board manager URL (not a valid URL)',
    };
  }
}

function validateHttpProtocol(url: URL): string | null {
  const protocol = url.protocol.toLowerCase();
  return protocol === 'https:' || protocol === 'http:'
    ? null
    : '❌ Board manager URL must be http(s)';
}

function validateNoCredentials(url: URL): string | null {
  // Disallow credentials in URLs (e.g., https://user:pass@host/...)
  return url.username || url.password
    ? '❌ Board manager URL must not contain credentials'
    : null;
}

function validateJsonPath(url: URL): string | null {
  // Most Arduino board indexes are JSON.
  return url.pathname.toLowerCase().endsWith('.json')
    ? null
    : '❌ Board manager URL must end with .json';
}

export async function agentRemoveBoardUrl(
  ctx: BoardUrlToolsContext,
  urlOrName: string
): Promise<string> {
  if (!urlOrName || !urlOrName.trim()) {
    return '❌ Board manager URL or board name is required';
  }

  try {
    const currentConfig = await ctx.configService.getConfiguration();
    if (!currentConfig.config) {
      return `❌ Failed to read configuration`;
    }

    const currentUrls = currentConfig.config.additionalUrls || [];
    if (currentUrls.length === 0) {
      return `ℹ️ No board manager URLs configured in preferences`;
    }

    const urlsToRemove = BoardUrlHelper.findUrlsToRemove(
      urlOrName,
      currentUrls
    );
    if (urlsToRemove.length === 0) {
      return BoardUrlHelper.formatBoardUrlMessage({
        type: 'noMatch',
        urlOrName,
        currentUrls,
      });
    }

    const updatedUrls = await BoardUrlHelper.removeUrlsFromConfiguration(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.configService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.commands as any,
      urlsToRemove,
      currentUrls
    );

    if (urlsToRemove.length > 1) {
      return BoardUrlHelper.formatBoardUrlMessage({
        type: 'multipleRemoval',
        urlsToRemove,
        urlOrName,
        remainingCount: updatedUrls.length,
      });
    }

    return BoardUrlHelper.formatBoardUrlMessage({
      type: 'singleRemoval',
      url: urlsToRemove[0],
      remainingCount: updatedUrls.length,
    });
  } catch (error) {
    spectreError('❌ Failed to remove board manager URL:', error);
    return `❌ Failed to remove board manager URL: ${formatUnknownError(
      error
    )}`;
  }
}

export async function agentFetchBoardUrls(
  _ctx: unknown,
  query: string
): Promise<string> {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) {
    return '❌ Board name is required to search for URLs';
  }

  const wikiUrl =
    'https://raw.githubusercontent.com/wiki/arduino/Arduino/Unofficial-list-of-3rd-party-boards-support-urls.md';

  const FETCH_TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(wikiUrl, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch wiki: ${response.status} ${response.statusText}`
      );
    }

    const wikiContent = await response.text();
    const matches = BoardHelper.parseWikiForBoardUrls(
      wikiContent,
      trimmedQuery
    );

    if (matches.length === 0) {
      return `❌ No board manager URLs found for "${trimmedQuery}"\n\n💡 Try searching with a different term or check the Arduino Wiki manually:\nhttps://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls`;
    }

    return BoardHelper.formatBoardUrlResults(matches, trimmedQuery);
  } catch (error) {
    spectreError('❌ Failed to fetch board URLs:', error);
    return `❌ Failed to fetch board URLs from Arduino Wiki: ${formatUnknownError(
      error
    )}\n\n💡 You can manually check: https://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls`;
  } finally {
    clearTimeout(timer);
  }
}

async function updateAndWaitForPackageIndex(
  ctx: BoardUrlToolsContext
): Promise<{ success: boolean; timedOut: boolean }> {
  const MAX_WAIT_MS = 10_000;
  try {
    await ctx.commands.executeCommand('arduino-update-package-index');

    const indexReady = await pollForPackageIndexReady(ctx, MAX_WAIT_MS);
    return { success: indexReady, timedOut: !indexReady };
  } catch (updateError) {
    spectreWarn('⚠️ Package index update failed:', updateError);
    return { success: false, timedOut: false };
  }
}

async function pollForPackageIndexReady(
  ctx: BoardUrlToolsContext,
  maxWaitTime: number
): Promise<boolean> {
  const pollInterval = ctx.timing.PACKAGE_INDEX_POLL_INTERVAL;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const testSearch = await ctx.boardsService.search({ query: '' });
      if (testSearch && testSearch.length > 0) {
        return true;
      }
    } catch (e) {
      // Index not ready yet, continue polling
    }

    await ctx.delay(pollInterval);
  }

  spectreWarn('⚠️ Package index update timed out after 10 seconds');
  return false;
}

// ============================================================================
// Task Helpers
// ============================================================================

// ============================================================================
// Library Helpers
// ============================================================================

/**
 * Helper class for agent mode library operations.
 */
export class AgentLibraryHelper {
  /**
   * Validates library name is not empty.
   */
  static validateLibraryName(params: LibraryValidationParams): string | null {
    if (!params.name || params.name.trim().length === 0) {
      return `❌ Cannot ${params.operation} library: library name is empty`;
    }
    return null;
  }

  /**
   * Builds case-insensitive map from search results.
   */
  static buildLibraryMap(
    searchResults: LibraryPackage[]
  ): Map<string, LibraryPackage> {
    const map = new Map<string, LibraryPackage>();

    for (const result of searchResults) {
      if (!result?.name) {
        continue;
      }

      const key = result.name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, result);
      }
    }

    return map;
  }

  /**
   * Finds library from search results using exact or best match.
   */
  static findLibraryInResults(
    libraryName: string,
    libraryMap: Map<string, LibraryPackage>
  ): LibraryPackage | undefined {
    let libraryPackage = libraryMap.get(libraryName.toLowerCase());

    if (!libraryPackage) {
      const firstResult = libraryMap.values().next();
      if (firstResult.done || !firstResult.value) {
        return undefined;
      }
      libraryPackage = firstResult.value;
    }

    return libraryPackage;
  }

  /**
   * Processes search results and resolves library package.
   */
  static processSearchResults(
    params: LibrarySearchParams
  ): LibrarySearchResult {
    const { name, searchResults } = params;

    if (!searchResults || searchResults.length === 0) {
      return {
        success: false,
        error: `❌ Library "${name}" not found in Arduino Library Manager\n\n💡 Common fixes:\n• Check spelling (library names are case-sensitive)\n• Try searching: https://www.arduino.cc/reference/en/libraries/\n• Some libraries have different names (e.g., "Servo" not "ServoLibrary")`,
      };
    }

    const libraryMap = this.buildLibraryMap(searchResults);

    if (libraryMap.size === 0) {
      return {
        success: false,
        error: `❌ Library search returned invalid data for "${name}"\n\n💡 This is an internal error. Please try again or search manually in Library Manager.`,
      };
    }

    const libraryPackage = this.findLibraryInResults(name, libraryMap);

    if (!libraryPackage) {
      return {
        success: false,
        error: `❌ Library "${name}" could not be resolved from search results\n\n💡 Please try searching manually in Library Manager.`,
      };
    }

    return { success: true, package: libraryPackage };
  }

  /**
   * Formats library operation messages.
   */
  static formatLibraryMessage(params: LibraryMessageParams): string {
    const { name, version, type } = params;

    switch (type) {
      case 'notFound':
        return `❌ Library "${name}" not found in library index`;
      case 'noVersions':
        return `❌ No versions available for library "${name}"`;
      case 'alreadyInstalled':
        return `✅ Library "${name}" is already installed (version ${
          version || 'unknown'
        })`;
      case 'notInstalled':
        return `⚠️ Library "${name}" is not currently installed`;
      case 'installSuccess':
        return `✅ Library "${name}" installed successfully`;
      case 'uninstallSuccess':
        return `✅ Library "${name}" uninstalled successfully`;
    }
  }
}
