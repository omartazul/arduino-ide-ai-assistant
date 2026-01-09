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
export class BoardManagerUrl {
  private constructor(public readonly value: string) {}

  static tryCreate(rawUrl: string): { value?: BoardManagerUrl; error?: string } {
    if (!rawUrl || rawUrl.trim().length === 0) {
      return { error: '❌ Board manager URL is required' };
    }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: '❌ Board manager URL must start with http:// or https://' };
      }
      return { value: new BoardManagerUrl(rawUrl) };
    } catch {
      return { error: `❌ Invalid board manager URL: "${rawUrl}"` };
    }
  }

  static validate(rawUrl: string): string | null {
    const res = this.tryCreate(rawUrl);
    return res.error ?? null;
  }
}

/**
 * Value object for library names to avoid primitive obsession and centralize validation.
 */
export class LibraryName {
  private constructor(public readonly value: string) {}

  static tryCreate(rawName: string): { value?: LibraryName; error?: string } {
    if (!rawName || rawName.trim().length === 0) {
      return { error: '❌ Library name is required' };
    }
    return { value: new LibraryName(rawName.trim()) };
  }

  static validate(rawName: string): string | null {
    const res = this.tryCreate(rawName);
    return res.error ?? null;
  }
}

export class BoardSearchQuery {
  private constructor(public readonly value: string) {}

  static tryCreate(rawQuery: string): { value?: BoardSearchQuery; error?: string } {
    if (!rawQuery || rawQuery.trim().length === 0) {
      return { error: Messages.BOARD_NAME_REQUIRED };
    }
    return { value: new BoardSearchQuery(rawQuery.trim()) };
  }

  static validate(rawQuery: string): string | null {
    const res = this.tryCreate(rawQuery);
    return res.error ?? null;
  }
}

export class BoardIdentifier {
  private constructor(public readonly value: string) {}

  static tryCreate(rawId: string): { value?: BoardIdentifier; error?: string } {
    if (!rawId || rawId.trim().length === 0) {
      return { error: Messages.BOARD_IDENTIFIER_REQUIRED };
    }
    return { value: new BoardIdentifier(rawId.trim()) };
  }

  static validate(rawId: string): string | null {
    const res = this.tryCreate(rawId);
    return res.error ?? null;
  }
}

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

export enum LibraryOperation {
  Install = 'install',
  Uninstall = 'uninstall',
}

export enum LibraryMessageType {
  NotFound = 'notFound',
  NoVersions = 'noVersions',
  AlreadyInstalled = 'alreadyInstalled',
  NotInstalled = 'notInstalled',
  InstallSuccess = 'installSuccess',
  UninstallSuccess = 'uninstallSuccess',
}

export enum BoardUrlMessageType {
  AddResult = 'addResult',
  NoMatch = 'noMatch',
  SingleRemoval = 'singleRemoval',
  MultipleRemoval = 'multipleRemoval',
}

interface LibraryValidationParams {
  library: LibraryName;
  operation: LibraryOperation;
}

interface LibrarySearchParams {
  name: LibraryName;
  searchResults: LibraryPackage[];
}

type LibrarySearchResult =
  | { success: true; package: LibraryPackage }
  | { success: false; error: string };

interface LibraryMessageParams {
  name: LibraryName;
  version?: string;
  type: LibraryMessageType;
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
  library: string | LibraryName
): Promise<string> {
  const libRes =
    typeof library === 'string' ? LibraryName.tryCreate(library) : { value: library };
  if (libRes.error) {
    // Remove leading ❌ and whitespace from the LibraryName error to avoid double emoji
    const cleaned = libRes.error.replace(/^❌\s*/, '');
    return `❌ Cannot ${LibraryOperation.Install} library: ${cleaned}`;
  }
  return agentInstallLibraryWithVO(ctx, libRes.value!);
}

async function agentInstallLibraryWithVO(
  ctx: LibraryToolsContext,
  libraryVO: LibraryName
): Promise<string> {
  try {
    const searchResults = await ctx.libraryService.search({
      query: libraryVO.value,
    });
    const result = AgentLibraryHelper.processSearchResults({
      name: libraryVO,
      searchResults,
    });

    if (!result.success) return result.error;
    const libraryPackage = result.package;

    if (libraryPackage.installedVersion) {
      return AgentLibraryHelper.formatLibraryMessage({
        name: LibraryName.tryCreate(libraryPackage.name).value!,
        version: libraryPackage.installedVersion,
        type: LibraryMessageType.AlreadyInstalled,
      });
    }

    const versionToInstall = libraryPackage.availableVersions?.[0];
    if (!versionToInstall) {
      return AgentLibraryHelper.formatLibraryMessage({
        name: LibraryName.tryCreate(libraryPackage.name).value!,
        type: LibraryMessageType.NoVersions,
      });
    }

    const libraryItemPayload = { item: libraryPackage };
    await ctx.libraryService.install({
      ...libraryItemPayload,
      noDeps: false,
    });

    return AgentLibraryHelper.formatLibraryMessage({
      name: LibraryName.tryCreate(libraryPackage.name).value!,
      type: LibraryMessageType.InstallSuccess,
    });
  } catch (error: unknown) {
    spectreError('❌ Library installation error:', error);
    return ValidationHelper.formatLibraryInstallError(libraryVO.value, error);
  }
}

/**
 * Resolves a library package for the given operation by validating the name and searching the library service.
 */
async function resolveLibraryForOperation(
  ctx: LibraryToolsContext,
  library: LibraryName,
  operation: LibraryOperation
): Promise<{ package?: LibraryPackage; error?: string }> {
  // Expect a validated LibraryName VO; run a defensive validation to keep behavior consistent.
  const validationError = AgentLibraryHelper.validateLibraryName({
    library,
    operation,
  });
  if (validationError) {
    const cleaned = validationError.replace(/^❌\s*/, '');
    return { error: `❌ Cannot ${operation} library: ${cleaned}` };
  }

  const searchResults = await ctx.libraryService.search({ query: library.value });
  const result = AgentLibraryHelper.processSearchResults({
    name: library,
    searchResults,
  });

  if (!result.success) {
    return { error: result.error };
  }
  return { package: result.package };
}

export async function agentUninstallLibrary(
  ctx: LibraryToolsContext,
  library: string | LibraryName
): Promise<string> {
  const libRes =
    typeof library === 'string' ? LibraryName.tryCreate(library) : { value: library };
  if (libRes.error) {
    const cleaned = libRes.error.replace(/^❌\s*/, '');
    return `❌ Cannot ${LibraryOperation.Uninstall} library: ${cleaned}`;
  }
  return agentUninstallLibraryWithVO(ctx, libRes.value!);
}

async function agentUninstallLibraryWithVO(
  ctx: LibraryToolsContext,
  libraryVO: LibraryName
): Promise<string> {
  try {
    const { package: libraryPackage, error } = await resolveLibraryForOperation(
      ctx,
      libraryVO,
      LibraryOperation.Uninstall
    );
    if (error) return error;

    if (!libraryPackage!.installedVersion) {
      return AgentLibraryHelper.formatLibraryMessage({
        name: LibraryName.tryCreate(libraryPackage!.name).value!,
        type: LibraryMessageType.NotInstalled,
      });
    }

    await ctx.libraryService.uninstall({ item: libraryPackage! });

    ctx.outputChannels
      .getChannel('Arduino')
      .appendLine(
        `Uninstalled ${libraryPackage!.name}@${libraryPackage!.installedVersion}`
      );

    return AgentLibraryHelper.formatLibraryMessage({
      name: LibraryName.tryCreate(libraryPackage!.name).value!,
      type: LibraryMessageType.UninstallSuccess,
    });
  } catch (error: unknown) {
    spectreError('❌ Library uninstallation error:', error);
    return formatLibraryUninstallError(libraryVO, error);
  }
}

function formatLibraryUninstallError(
  libraryName: LibraryName,
  error: unknown
): string {
  const errorMsg = error instanceof Error ? error.message : String(error);

  const lowered = errorMsg.toLowerCase();
  const missingIndicators = ['not found', 'not installed'];
  if (missingIndicators.some(ind => lowered.includes(ind))) {
    return `❌ Library "${libraryName.value}" is not installed or could not be found`;
  }

  return `❌ Failed to uninstall library "${libraryName.value}"\n\nError: ${errorMsg}`;
}

// ============================================================================
// Board URL Tools
// ============================================================================

export interface BoardUrlToolsTiming {
  PACKAGE_INDEX_POLL_INTERVAL: number;
}

export interface CommandExecutor {
  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
}

export interface ConfigService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConfiguration(): Promise<{ config?: any }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setConfiguration(config: any): Promise<void>;
}

export interface BoardUrlToolsContext {
  commands: CommandExecutor;
  boardsService: {
    search(params: { query: string }): Promise<BoardsPackage[]>;
  };
  configService: ConfigService;
  delay(ms: number): Promise<void>;
  timing: BoardUrlToolsTiming;
}

export async function agentAddBoardUrl(
  ctx: BoardUrlToolsContext,
  url: string | BoardManagerUrl
): Promise<string> {
  const createResult =
    typeof url === 'string' ? BoardManagerUrl.tryCreate(url) : { value: url };
  if (createResult.error) {
    return createResult.error;
  }
  const boardUrl = createResult.value!;

  try {
    const { urlAlreadyExists } = await BoardUrlHelper.addToConfiguration(
      ctx.configService,
      boardUrl.value
    );

    const updateResultRaw = await updateAndWaitForPackageIndex(ctx);
    const updateResult: { success: boolean; error?: string } =
      updateResultRaw === PackageIndexUpdateResult.Updated
        ? { success: true }
        : { success: false, error: updateResultRaw };

    return BoardUrlHelper.formatBoardUrlMessage({
      type: BoardUrlMessageType.AddResult,
      url: boardUrl.value,
      urlAlreadyExists,
      updateResult,
    });
  } catch (error) {
    spectreError('❌ Failed to add board manager URL:', error);
    return `❌ Failed to add board manager URL: ${formatUnknownError(error)}`;
  }
}

export function validateBoardManagerUrl(rawUrl: string | BoardManagerUrl): string | null {
  return BoardManagerUrl.validate(typeof rawUrl === 'string' ? rawUrl : rawUrl.value);
}

export async function agentRemoveBoardUrl(
  ctx: BoardUrlToolsContext,
  urlOrName: string | BoardIdentifier
): Promise<string> {
  const idRes =
    typeof urlOrName === 'string' ? BoardIdentifier.tryCreate(urlOrName) : { value: urlOrName };
  if (idRes.error) {
    return idRes.error;
  }
  const rawIdentifier = idRes.value!.value;

  try {
    const currentUrls = await readConfigUrls(ctx);
    if (currentUrls === null) {
      return `❌ Failed to read configuration`;
    }

    if (currentUrls.length === 0) {
      return `ℹ️ No board manager URLs configured in preferences`;
    }

    const urlsToRemove = BoardUrlHelper.findUrlsToRemove(rawIdentifier, currentUrls);
    if (urlsToRemove.length === 0) {
      return BoardUrlHelper.formatBoardUrlMessage({
        type: BoardUrlMessageType.NoMatch,
        urlOrName: rawIdentifier,
        currentUrls,
      });
    }

    const updatedUrls = await BoardUrlHelper.removeUrlsFromConfiguration(
      ctx.configService,
      ctx.commands,
      urlsToRemove,
      currentUrls
    );

    return formatRemovalResult({ urlsToRemove, updatedUrls, urlOrName: rawIdentifier });
  } catch (error) {
    spectreError('❌ Failed to remove board manager URL:', error);
    return `❌ Failed to remove board manager URL: ${formatUnknownError(
      error
    )}`;
  }
}

async function readConfigUrls(ctx: BoardUrlToolsContext): Promise<string[] | null> {
  const currentConfig = await ctx.configService.getConfiguration();
  if (!currentConfig.config) {
    return null;
  }
  return currentConfig.config.additionalUrls || [];
}

interface RemovalResultParams {
  urlsToRemove: string[];
  updatedUrls: string[];
  urlOrName: string;
}

function formatRemovalResult(params: RemovalResultParams): string {
  const { urlsToRemove, updatedUrls, urlOrName } = params;

  if (urlsToRemove.length > 1) {
    return BoardUrlHelper.formatBoardUrlMessage({
      type: BoardUrlMessageType.MultipleRemoval,
      urlsToRemove,
      urlOrName,
      remainingCount: updatedUrls.length,
    });
  }

  return BoardUrlHelper.formatBoardUrlMessage({
    type: BoardUrlMessageType.SingleRemoval,
    url: urlsToRemove[0],
    remainingCount: updatedUrls.length,
  });
}

const WIKI_URL =
  'https://raw.githubusercontent.com/wiki/arduino/Arduino/Unofficial-list-of-3rd-party-boards-support-urls.md';
const FETCH_TIMEOUT_MS = 10_000;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type AbortControllerLike = { signal?: AbortSignal | undefined; abort?: (() => void) };

const MANUAL_CHECK_URL =
  'https://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls';

const Messages = {
  BOARD_NAME_REQUIRED: '❌ Board name is required to search for URLs',
  BOARD_IDENTIFIER_REQUIRED: '❌ Board manager URL or board name is required',
  FETCH_NOT_AVAILABLE: '❌ Fetch API is not available in this environment',
  NO_MATCH_FOUND: (q: string) =>
    `❌ No board manager URLs found for "${q}"\n\n💡 Try searching with a different term or check the Arduino Wiki manually:\n${MANUAL_CHECK_URL}`,
  WIKI_FETCH_FAILED: (errMsg: string) =>
    `❌ Failed to fetch board URLs from Arduino Wiki: ${errMsg}\n\n💡 You can manually check: ${MANUAL_CHECK_URL}`,
};

/** Obtain global fetch or null if unavailable */
function getGlobalFetch(): Fetcher | null {
  const globalFetch = (globalThis as any).fetch;
  return typeof globalFetch === 'function' ? (globalFetch as Fetcher) : null;
}

/** Create an abort controller fallback with a timeout and return it along with the timer id */
function createAbortController(timeoutMs: number): {
  controller: AbortControllerLike;
  timer: ReturnType<typeof setTimeout>;
} {
  const AbortControllerCtor = (globalThis as any).AbortController;
  const controller: AbortControllerLike = AbortControllerCtor
    ? new AbortControllerCtor()
    : { signal: undefined, abort: () => {} };
  const timer = setTimeout(() => controller.abort && controller.abort(), timeoutMs);
  return { controller, timer };
}

/** Fetch the wiki content and throw on non-OK status */
async function fetchWikiContent(fetcher: Fetcher, url: string, controller: AbortControllerLike): Promise<string> {
  const response = await fetcher(url, { signal: controller.signal, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch wiki: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/** Fetch wiki content with a timeout and ensure the timer is cleared */
async function fetchWikiWithTimeout(fetcher: Fetcher, url: string, timeoutMs: number): Promise<string> {
  const { controller, timer } = createAbortController(timeoutMs);
  try {
    return await fetchWikiContent(fetcher, url, controller);
  } finally {
    clearTimeout(timer);
  }
}

export async function agentFetchBoardUrls(
  _ctx: unknown,
  query: string | BoardSearchQuery
): Promise<string> {
  const qRes =
    typeof query === 'string' ? BoardSearchQuery.tryCreate(query) : { value: query };
  if (qRes.error) {
    return qRes.error;
  }
  const trimmedQuery = qRes.value!.value;

  const globalFetch = getGlobalFetch();
  if (!globalFetch) {
    return Messages.FETCH_NOT_AVAILABLE;
  }

  try {
    const wikiContent = await fetchWikiWithTimeout(globalFetch, WIKI_URL, FETCH_TIMEOUT_MS);
    const matches = BoardHelper.parseWikiForBoardUrls(wikiContent, trimmedQuery);

    if (matches.length === 0) {
      return Messages.NO_MATCH_FOUND(trimmedQuery);
    }

    return BoardHelper.formatBoardUrlResults(matches, trimmedQuery);
  } catch (error) {
    spectreError('❌ Failed to fetch board URLs:', error);
    return Messages.WIKI_FETCH_FAILED(formatUnknownError(error));
  }
}

// Package index update/polling logic (inlined fallback implementation)

/**
 * Try executing well-known extension commands that may trigger a package index update.
 * Returns true if any command succeeded, false otherwise.
 */
async function tryExecuteKnownCommands(ctx: BoardUrlToolsContext): Promise<boolean> {
  const possibleCmds = [
    'arduino.boardManager.reload',
    'arduino.boards.reloadIndex',
    'arduino.boardManager.update',
    'arduino.boardManager.updateIndex',
  ];

  if (!ctx.commands || typeof ctx.commands.executeCommand !== 'function') {
    return false;
  }

  for (const cmd of possibleCmds) {
    try {
      await ctx.commands.executeCommand(cmd);
      return true;
    } catch {
      // ignore and try next command
    }
  }

  return false;
}

/**
 * Result enum for package index updates.
 */
export enum PackageIndexUpdateResult {
  Updated = 'updated',
  Timeout = 'timeout',
  Failed = 'failed',
}

/**
 * Trigger an update and wait for the package index to become available.
 * This function tries a few well-known VS Code command IDs (if available) and
 * falls back to polling the boardsService until it responds or a timeout is hit.
 */
export async function updateAndWaitForPackageIndex(
  ctx: BoardUrlToolsContext
): Promise<PackageIndexUpdateResult> {
  try {
    // First try running known commands (best-effort)
    const commandUpdated = await tryExecuteKnownCommands(ctx);
    if (commandUpdated) {
      return PackageIndexUpdateResult.Updated;
    }

    // Poll the boards service until it responds or timeout
    const timeoutMs = 10_000;
    const pollInterval = ctx.timing?.PACKAGE_INDEX_POLL_INTERVAL ?? 500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await ctx.delay(pollInterval);
      try {
        await ctx.boardsService.search({ query: '' });
        return PackageIndexUpdateResult.Updated;
      } catch {
        // continue polling
      }
    }

    return PackageIndexUpdateResult.Timeout;
  } catch (err) {
    spectreWarn('❌ Package index update failed:', err);
    return PackageIndexUpdateResult.Failed;
  }
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
   * Validates a LibraryName value object (already validated at creation).
   */
  static validateLibraryName(params: LibraryValidationParams): string | null {
    const { library, operation } = params;
    // If a LibraryName instance is provided it should already be valid,
    // but keep a defensive check to provide a consistent error message.
    if (!this.isValidLibraryName(library)) {
      return `❌ Cannot ${operation} library: Library name is required`;
    }
    return null;
  }

  private static isValidLibraryName(library?: LibraryName): boolean {
    if (!library) {
      return false;
    }
    if (!library.value) {
      return false;
    }
    if (library.value.trim().length === 0) {
      return false;
    }
    return true;
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
        error: `❌ Library "${name.value}" not found in Arduino Library Manager\n\n💡 Common fixes:\n• Check spelling (library names are case-sensitive)\n• Try searching: https://www.arduino.cc/reference/en/libraries/\n• Some libraries have different names (e.g., "Servo" not "ServoLibrary")`,
      };
    }

    const libraryMap = this.buildLibraryMap(searchResults);

    if (libraryMap.size === 0) {
      return {
        success: false,
        error: `❌ Library search returned invalid data for "${name.value}"\n\n💡 This is an internal error. Please try again or search manually in Library Manager.`,
      };
    }

    const libraryPackage = this.findLibraryInResults(name.value, libraryMap);

    if (!libraryPackage) {
      return {
        success: false,
        error: `❌ Library "${name.value}" could not be resolved from search results\n\n💡 Please try searching manually in Library Manager.`,
      };
    }

    return { success: true, package: libraryPackage };
  }

  /**
   * Formats library operation messages.
   */
  static formatLibraryMessage(params: LibraryMessageParams): string {
    const { name, version, type } = params;
    const displayName = name.value;

    switch (type) {
      case LibraryMessageType.NotFound:
        return `❌ Library "${displayName}" not found in library index`;
      case LibraryMessageType.NoVersions:
        return `❌ No versions available for library "${displayName}"`;
      case LibraryMessageType.AlreadyInstalled:
        return `✅ Library "${displayName}" is already installed (version ${
          version || 'unknown'
        })`;
      case LibraryMessageType.NotInstalled:
        return `⚠️ Library "${displayName}" is not currently installed`;
      case LibraryMessageType.InstallSuccess:
        return `✅ Library "${displayName}" installed successfully`;
      case LibraryMessageType.UninstallSuccess:
        return `✅ Library "${displayName}" uninstalled successfully`;
      default:
        return `❌ Unknown library message type "${String(type)}" for "${displayName}"`;
    }
  }
}
