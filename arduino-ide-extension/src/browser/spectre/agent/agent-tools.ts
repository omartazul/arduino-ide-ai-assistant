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

import { spectreError, spectreWarn } from '../../../common/protocol/spectre-types';
import { BoardHelper, BoardUrlHelper } from '../board/board-helpers';
import { ValidationHelper } from '../utils/validation-helpers';
import * as RenderingHelpers from '../ui/rendering-helpers';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface AgentActionHistoryEntry {
  result?: { success: boolean };
}

export interface CleanAgentResponseResult {
  cleanText: string;
  tasks: AgentTask[];
}

export interface AgentTask {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  error?: string;
  actionType: string;
}

interface LibraryValidationParams {
  name: string;
  operation: 'install' | 'uninstall';
}

interface LibrarySearchParams {
  name: string;
  searchResults: any[];
}

type LibrarySearchResult =
  | { success: true; package: any }
  | { success: false; error: string };

interface LibraryMessageParams {
  name: string;
  version?: string;
  type: 'notFound' | 'noVersions' | 'alreadyInstalled' | 'notInstalled' | 'installSuccess' | 'uninstallSuccess';
}

// ============================================================================
// Library Tools
// ============================================================================

export interface LibraryToolsContext {
  libraryService: {
    search(params: { query: string }): Promise<any[]>;
    install(params: { item: any; noDeps: boolean }): Promise<void>;
    uninstall(params: { item: any }): Promise<void>;
  };
  outputChannels: { getChannel(id: string): { appendLine(line: string): void } };
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

    const searchResults = await ctx.libraryService.search({ query: libraryName });
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

    const searchResults = await ctx.libraryService.search({ query: libraryName });
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
      .appendLine(`Uninstalled ${libraryPackage.name}@${libraryPackage.installedVersion}`);

    return AgentLibraryHelper.formatLibraryMessage({
      name: libraryPackage.name,
      type: 'uninstallSuccess',
    });
  } catch (error: unknown) {
    spectreError('❌ Library uninstallation error:', error);
    return formatLibraryUninstallError(libraryName, error);
  }
}

function formatLibraryUninstallError(libraryName: string, error: any): string {
  const errorMsg = error?.message || String(error);

  if (errorMsg.toLowerCase().includes('not found') || errorMsg.toLowerCase().includes('not installed')) {
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
  commands: { executeCommand(id: string, ...args: any[]): Promise<any> };
  boardsService: { search(params: { query: string }): Promise<any[]> };
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

  try {
    const { urlAlreadyExists } = await BoardUrlHelper.addToConfiguration(ctx.configService as any, url);

    const updateResult = await updateAndWaitForPackageIndex(ctx);

    return BoardUrlHelper.formatBoardUrlMessage({
      type: 'addResult',
      url,
      urlAlreadyExists,
      updateResult,
    });
  } catch (error) {
    spectreError('❌ Failed to add board manager URL:', error);
    return `❌ Failed to add board manager URL: ${error}`;
  }
}

export async function agentRemoveBoardUrl(
  ctx: BoardUrlToolsContext,
  urlOrName: string
): Promise<string> {
  if (!urlOrName || !urlOrName.trim()) {
    return '❌ Board manager URL or board name is required';
  }

  try {
    const currentConfig = await (ctx.configService as any).getConfiguration();
    if (!currentConfig.config) {
      return `❌ Failed to read configuration`;
    }

    const currentUrls = currentConfig.config.additionalUrls || [];
    if (currentUrls.length === 0) {
      return `ℹ️ No board manager URLs configured in preferences`;
    }

    const urlsToRemove = BoardUrlHelper.findUrlsToRemove(urlOrName, currentUrls);
    if (urlsToRemove.length === 0) {
      return BoardUrlHelper.formatBoardUrlMessage({
        type: 'noMatch',
        urlOrName,
        currentUrls,
      });
    }

    const updatedUrls = await BoardUrlHelper.removeUrlsFromConfiguration(
      ctx.configService as any,
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
    return `❌ Failed to remove board manager URL: ${error}`;
  }
}

export async function agentFetchBoardUrls(
  ctx: unknown,
  query: string
): Promise<string> {
  if (!query || !query.trim()) {
    return '❌ Board name is required to search for URLs';
  }

  const wikiUrl =
    'https://raw.githubusercontent.com/wiki/arduino/Arduino/Unofficial-list-of-3rd-party-boards-support-urls.md';

  try {
    const response = await fetch(wikiUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch wiki: ${response.status} ${response.statusText}`);
    }

    const wikiContent = await response.text();
    const matches = BoardHelper.parseWikiForBoardUrls(wikiContent, query);

    if (matches.length === 0) {
      return `❌ No board manager URLs found for "${query}"\n\n💡 Try searching with a different term or check the Arduino Wiki manually:\nhttps://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls`;
    }

    return BoardHelper.formatBoardUrlResults(matches, query);
  } catch (error) {
    spectreError('❌ Failed to fetch board URLs:', error);
    return `❌ Failed to fetch board URLs from Arduino Wiki: ${error}\n\n💡 You can manually check: https://github.com/arduino/Arduino/wiki/Unofficial-list-of-3rd-party-boards-support-urls`;
  }
}

async function updateAndWaitForPackageIndex(
  ctx: BoardUrlToolsContext
): Promise<{ success: boolean; timedOut: boolean }> {
  try {
    await ctx.commands.executeCommand('arduino-update-package-index');

    const indexReady = await pollForPackageIndexReady(ctx, 10000);
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

/**
 * Parses tasks from agent response text.
 */
export function parseTasksFromResponse(text: string): AgentTask[] {
  const tasks: AgentTask[] = [];
  const lines = text.split('\n');
  let taskId = 1;

  for (const line of lines) {
    // Match markdown checkbox patterns: - [ ], - [x], - [X], - [o], etc.
    const checkboxMatch = line.match(/^\s*[-*]\s*\[([^\]]*)\]\s*(.+)/);

    if (checkboxMatch) {
      const checkbox = checkboxMatch[1].toLowerCase().trim();
      const description = checkboxMatch[2].trim();

      // Determine status from checkbox character
      let status: 'pending' | 'in-progress' | 'completed' | 'failed' = 'pending';

      if (isCompletedCheckbox(checkbox)) {
        status = 'completed';
      } else if (isInProgressCheckbox(checkbox)) {
        status = 'in-progress';
      } else if (isFailedCheckbox(checkbox, description)) {
        status = 'failed';
      }

      tasks.push({
        id: `task-${taskId++}`,
        description,
        status,
        actionType: 'task',
      });
    }
  }

  return tasks;
}

function isCompletedCheckbox(checkbox: string): boolean {
  return checkbox === 'x' || checkbox === '✓' || checkbox === '✔';
}

function isInProgressCheckbox(checkbox: string): boolean {
  return checkbox === 'o' || checkbox === '~' || checkbox === '⏳';
}

function isFailedCheckbox(checkbox: string, description: string): boolean {
  return (
    checkbox === '!' ||
    (checkbox === 'x' && description.toLowerCase().includes('failed'))
  );
}

// ============================================================================
// Response Utilities
// ============================================================================

/**
 * Checks if a task has completed successfully based on response text and action history.
 */
export function taskCompletedSuccessfully(params: {
  responseText: string | undefined;
  actionHistory: Array<AgentActionHistoryEntry>;
}): boolean {
  const { responseText, actionHistory } = params;

  const hasCompletionIndicators = hasCompletionKeywords(responseText);
  const hadSuccessfulActions = actionHistory.some(
    (action) => action.result?.success === true
  );

  return hasCompletionIndicators && hadSuccessfulActions;
}

/**
 * Checks if response text contains completion keywords.
 */
export function hasCompletionKeywords(responseText: string | undefined): boolean {
  if (!responseText) {
    return false;
  }

  const text = responseText.toLowerCase();
  const keywords = ['created', 'completed', 'done', 'ready', 'finished'];
  return keywords.some((keyword) => text.includes(keyword));
}

/**
 * Marks all tasks as completed.
 */
export function markAllTasksCompleted(
  tasks: AgentTask[] | undefined
): AgentTask[] | undefined {
  if (!tasks || tasks.length === 0) {
    return tasks;
  }

  return tasks.map((task) => ({
    ...task,
    status: 'completed' as const,
  }));
}

/**
 * Formats the completion message shown to the user.
 */
export function formatCompletionMessage(iteration: number): string {
  return `\n\n---\n\n### ✅ Task Completed\n\nCompleted in **${iteration}** iteration${
    iteration > 1 ? 's' : ''
  }.\n`;
}

/**
 * Cleans agent response text by removing internal markers and extracting tasks.
 */
export function cleanAgentResponse(params: {
  responseText: string;
  thoughtsTokens?: number;
}): CleanAgentResponseResult {
  const { responseText, thoughtsTokens } = params;

  let cleanText = responseText;

  // Remove agent mode headers
  cleanText = cleanText.replace(/^##?\s*🤖\s*Agent Mode\s*\n*/gim, '');

  // Remove iteration markers
  cleanText = cleanText.replace(
    /^###?\s*🔄\s*Iteration\s+\d+\/\d+\s*\n*/gim,
    ''
  );

  // Remove analyzing messages
  cleanText = cleanText.replace(/^\*Analyzing your request.*?\*\s*\n*/gim, '');

  // Remove redundant code blocks
  cleanText = RenderingHelpers.suppressRedundantCodeBlocks(cleanText);

  // Parse tasks from the full original text, then remove task list(s) from the visible message.
  const tasks = parseTasksFromResponse(responseText);
  cleanText = stripTasksFromMessageText(cleanText);

  // Add thinking badge if available
  if (thoughtsTokens && thoughtsTokens > 0) {
    const thinkingBadge = `*💭 Used ${thoughtsTokens} thinking tokens*\n\n`;
    cleanText = thinkingBadge + cleanText;
  }

  // Remove excessive line breaks and trim
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
  cleanText = cleanText.replace(/^[\s\-]+|[\s\-]+$/g, '');

  return { cleanText, tasks };
}

/**
 * Strips task list markers from message text.
 */
function stripTasksFromMessageText(text: string): string {
  let cleanText = text;

  // Remove the entire task list section
  cleanText = cleanText.replace(
    /(?:Here's the plan:|Plan:|Tasks?:)?\s*\n(?:- \[[xo ]\] [^\n]+\n?)+/gim,
    ''
  );

  // Also remove standalone task lines scattered in text
  cleanText = cleanText.replace(/^- \[[xo ]\] [^\n]+\n?/gim, '');

  return cleanText;
}

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
  static buildLibraryMap(searchResults: any[]): Map<string, any> {
    const map = new Map<string, any>();

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
    libraryMap: Map<string, any>
  ): any | undefined {
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
  static processSearchResults(params: LibrarySearchParams): LibrarySearchResult {
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
        return `✅ Library "${name}" is already installed (version ${version || 'unknown'})`;
      case 'notInstalled':
        return `⚠️ Library "${name}" is not currently installed`;
      case 'installSuccess':
        return `✅ Library "${name}" installed successfully`;
      case 'uninstallSuccess':
        return `✅ Library "${name}" uninstalled successfully`;
    }
  }
}
