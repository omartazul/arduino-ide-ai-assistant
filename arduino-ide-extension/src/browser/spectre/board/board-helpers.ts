/**
 * Helper utilities for board operations in agent mode.
 * Handles board search, selection, configuration, platform management, and board URL management.
 *
 * @author Tazul Islam
 */

import { DetectedPort } from '../../../common/protocol';
import { spectreLog, spectreWarn } from '../../../common/protocol/spectre-types';

/**
 * Cached board data for efficient lookups.
 */
interface CachedBoard {
  board: any;
  normalizedName: string;
  normalizedWords: string[];
  lastUpdated: number;
}

/**
 * Result type for board search operations.
 */
interface BoardSearchResult {
  board: any | null;
  matchType?: 'exact' | 'fuzzy';
}

/**
 * Board configuration option.
 */
interface BoardConfigOption {
  option: string;
  selectedValue: string;
}

/**
 * Helper class for board operations.
 */
export class BoardHelper {
  private static readonly BOARD_CACHE_TTL_MS = 60000; // 1 minute cache TTL

  /**
   * Builds board search cache with normalized data.
   * Eliminates repeated string operations by pre-computing normalized forms.
   */
  static buildBoardCache(boards: any[]): Map<string, CachedBoard> {
    const cache = new Map<string, CachedBoard>();
    const now = Date.now();

    for (const board of boards) {
      const name = board.name || '';
      const normalizedName = name.toLowerCase();
      const normalizedWords = normalizedName.split(/\s+/);

      cache.set(board.fqbn || name, {
        board,
        normalizedName,
        normalizedWords,
        lastUpdated: now,
      });
    }

    return cache;
  }

  /**
   * Checks if board cache is valid.
   */
  static isBoardCacheValid(
    cache: Map<string, CachedBoard> | null,
    ttlMs = BoardHelper.BOARD_CACHE_TTL_MS
  ): boolean {
    if (!cache || cache.size === 0) {
      return false;
    }

    const now = Date.now();
    const firstEntry = cache.values().next().value;
    return firstEntry && now - firstEntry.lastUpdated < ttlMs;
  }

  /**
   * Calculates Levenshtein distance (edit distance) between two strings.
   * Measures how many single-character edits are needed to change one word into another.
   */
  static levenshteinDistance(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix: number[][] = [];

    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }

    return matrix[len1][len2];
  }

  /**
   * Checks if two words are similar enough (handles typos).
   * Returns true if words are similar (1-2 character difference allowed).
   */
  static isFuzzyMatch(word1: string, word2: string): boolean {
    if (word1 === word2) return true;
    if (Math.abs(word1.length - word2.length) > 2) return false;

    const distance = BoardHelper.levenshteinDistance(word1, word2);
    const maxLength = Math.max(word1.length, word2.length);
    const threshold = maxLength <= 4 ? 1 : 2;

    return distance <= threshold;
  }

  /**
   * Finds board by name - SMART matching with typo tolerance.
   * Uses cached normalized data for O(1) lookups.
   * Returns the FIRST board where ALL input words appear in the board name (with fuzzy matching).
   */
  static findBoardByName(
    inputName: string,
    cache: Map<string, CachedBoard>
  ): BoardSearchResult {
    const inputWords = inputName.toLowerCase().split(/\s+/);

    // Try exact match first
    const exactMatch = BoardHelper.tryExactMatch(inputWords, cache);
    if (exactMatch) {
      return { board: exactMatch, matchType: 'exact' };
    }

    // Try fuzzy match
    const fuzzyMatch = BoardHelper.tryFuzzyMatch(inputWords, cache);
    if (fuzzyMatch) {
      return { board: fuzzyMatch, matchType: 'fuzzy' };
    }

    return { board: null };
  }

  private static tryExactMatch(
    inputWords: string[],
    cache: Map<string, CachedBoard>
  ): any | null {
    for (const cached of cache.values()) {
      const allWordsMatch = inputWords.every((inputWord) =>
        cached.normalizedWords.some((boardWord) => boardWord.includes(inputWord))
      );
      if (allWordsMatch) {
        return cached.board;
      }
    }
    return null;
  }

  private static tryFuzzyMatch(
    inputWords: string[],
    cache: Map<string, CachedBoard>
  ): any | null {
    for (const cached of cache.values()) {
      const allWordsFuzzyMatch = inputWords.every((inputWord) =>
        cached.normalizedWords.some((boardWord) =>
          BoardHelper.isFuzzyMatch(inputWord, boardWord)
        )
      );
      if (allWordsFuzzyMatch) {
        return cached.board;
      }
    }
    return null;
  }

  /**
   * Parses board configuration options from string format.
   */
  static parseConfigOptions(options: string): BoardConfigOption[] {
    return options
      .split(',')
      .map((opt) => opt.trim())
      .filter((opt) => opt.includes('='))
      .map((opt) => {
        const [option, selectedValue] = opt.split('=').map((s) => s.trim());
        return { option, selectedValue };
      });
  }

  /**
   * Extracts board ID from FQBN.
   */
  static extractBoardIdFromFqbn(fqbn: string): string {
    const parts = fqbn.split(':');
    return parts.length >= 3 ? parts[2].split('.')[0] : '';
  }

  /**
   * Validates platform ID format.
   * Used by both install and uninstall operations.
   */
  static validatePlatformId(
    platformId: string,
    operation: 'installation' | 'uninstallation' = 'installation'
  ): string | null {
    if (!platformId || !platformId.includes(':')) {
      return `Invalid platform ID format for ${operation}. Expected format: "vendor:arch" (e.g., "arduino:avr", "esp32:esp32")`;
    }
    return null;
  }

  /**
   * Builds lookup maps for platform search results.
   */
  static buildPlatformLookupMaps(searchResults: any[]): {
    exactMap: Map<string, any>;
    caseInsensitiveMap: Map<string, any>;
  } {
    const exactMap = new Map<string, any>();
    const caseInsensitiveMap = new Map<string, any>();

    for (const platform of searchResults) {
      const id = platform.id || '';
      exactMap.set(id, platform);
      caseInsensitiveMap.set(id.toLowerCase(), platform);
    }

    return { exactMap, caseInsensitiveMap };
  }

  /**
   * Finds matching platform using cascading search strategies.
   * 1. Exact match (case-sensitive)
   * 2. Case-insensitive match
   * 3. Partial substring match
   */
  static findMatchingPlatform(
    platformId: string,
    searchResults: any[],
    exactMap: Map<string, any>,
    caseInsensitiveMap: Map<string, any>
  ): any | null {
    // Try exact match
    if (exactMap.has(platformId)) {
      return exactMap.get(platformId);
    }

    // Try case-insensitive
    const lowerPlatformId = platformId.toLowerCase();
    if (caseInsensitiveMap.has(lowerPlatformId)) {
      return caseInsensitiveMap.get(lowerPlatformId);
    }

    // Try partial match
    return (
      searchResults.find((p) =>
        (p.id || '').toLowerCase().includes(lowerPlatformId)
      ) || null
    );
  }

  /**
   * Formats platform search error with suggestions.
   * Used by both install and uninstall operations.
   */
  static formatPlatformSearchError(
    platformId: string,
    searchResults: any[]
  ): string {
    const suggestions = searchResults
      .slice(0, 5)
      .map((p) => `- ${p.id}: ${p.name || 'Unknown'}`)
      .join('\n');

    return `Platform "${platformId}" not found.\n\nAvailable platforms:\n${suggestions}\n\nTry searching with: agentSearchBoards("${platformId}")`;
  }

  /**
   * Gets alternate serial ports excluding current port.
   */
  static getAlternateSerialPorts(
    detectedPorts: DetectedPort[],
    currentPort: string | undefined
  ): DetectedPort[] {
    return detectedPorts.filter((dp) => {
      const addr = dp.port?.address || '';
      if (!addr || addr === currentPort) return false;

      const addrLower = addr.toLowerCase();
      return (
        addrLower.startsWith('com') ||
        addrLower.startsWith('/dev/tty') ||
        addrLower.startsWith('/dev/cu')
      );
    });
  }

  /**
   * Port error keywords for detection.
   */
  static readonly PORT_ERROR_KEYWORDS = [
    'timeout',
    'busy',
    "can't open",
    'cannot open',
    'access denied',
    'permission denied',
    'in use',
    'semaphore',
    'handle is invalid',
  ];

  /**
   * Checks if error is port-related.
   */
  static isPortRelatedError(errText: string, shouldRetry?: boolean): boolean {
    const errLower = errText.toLowerCase();
    return (
      shouldRetry === true ||
      BoardHelper.PORT_ERROR_KEYWORDS.some((kw) => errLower.includes(kw))
    );
  }

  /**
   * Extracts board URL from a wiki line.
   */
  static extractBoardUrlFromLine(
    line: string,
    query: string
  ): { name: string; url: string } | null {
    const nameMatch = line.match(/\*\s*\*\*([^*]+)\*\*/);
    if (!nameMatch) return null;

    const name = nameMatch[1].trim();
    if (!name.toLowerCase().includes(query.toLowerCase())) {
      return null;
    }

    const urlMatch = line.match(/https?:\/\/[^\s)]+\.json/i);
    if (!urlMatch) return null;

    return { name, url: urlMatch[0] };
  }

  /**
   * Parses wiki content to find board URLs matching query.
   */
  static parseWikiForBoardUrls(
    wikiContent: string,
    query: string
  ): Array<{ name: string; url: string }> {
    const lines = wikiContent.split('\n');
    const matches: Array<{ name: string; url: string }> = [];

    for (const line of lines) {
      const match = BoardHelper.extractBoardUrlFromLine(line, query);
      if (match) {
        matches.push(match);
      }
    }

    return matches;
  }

  /**
   * Formats board URL search results with action suggestions.
   */
  static formatBoardUrlResults(
    matches: Array<{ name: string; url: string }>,
    query: string
  ): string {
    if (matches.length === 0) {
      return `No board manager URLs found for "${query}".\n\nPlease search the Arduino Wiki manually or provide a specific board manager URL.`;
    }

    const results = matches
      .map((m) => `- **${m.name}**: ${m.url}`)
      .join('\n');

    return `Found ${matches.length} board manager URL(s) for "${query}":\n\n${results}\n\nTo add a URL, use: agentAddBoardUrl("url")`;
  }
}

/**
 * Configuration service interface for board URL operations.
 */
interface ConfigService {
  getConfiguration(): Promise<{ config?: any }>;
  setConfiguration(config: any): Promise<void>;
}

/**
 * Command service interface for board URL operations.
 */
interface CommandService {
  executeCommand(command: string, ...args: any[]): Promise<any>;
}

/**
 * Parameters for formatting board URL messages.
 */
interface BoardUrlMessageParams {
  type: 'multipleRemoval' | 'singleRemoval' | 'addResult' | 'noMatch';
  url?: string;
  urlsToRemove?: string[];
  urlOrName?: string;
  remainingCount?: number;
  urlAlreadyExists?: boolean;
  updateResult?: { success: boolean; error?: string };
  currentUrls?: string[];
}

/**
 * Helper class for board URL management operations.
 */
export class BoardUrlHelper {
  /**
   * Adds a board manager URL to configuration.
   */
  static async addToConfiguration(
    configService: ConfigService,
    url: string
  ): Promise<{ currentUrls: string[]; urlAlreadyExists: boolean }> {
    const currentConfig = await configService.getConfiguration();
    if (!currentConfig.config) {
      throw new Error('Failed to read configuration');
    }

    const currentUrls = currentConfig.config.additionalUrls || [];
    const urlAlreadyExists = currentUrls.includes(url);

    if (!urlAlreadyExists) {
      const updatedUrls = [...currentUrls, url];
      await configService.setConfiguration({
        ...currentConfig.config,
        additionalUrls: updatedUrls,
      });
      spectreLog('✅ Board manager URL added to preferences');
    } else {
      spectreLog(`ℹ️ Board manager URL already configured: ${url}`);
    }

    return { currentUrls, urlAlreadyExists };
  }

  /**
   * Finds URLs to remove based on exact match or fuzzy search.
   */
  static findUrlsToRemove(urlOrName: string, currentUrls: string[]): string[] {
    if (currentUrls.includes(urlOrName)) {
      return [urlOrName];
    }

    const searchTerm = urlOrName.toLowerCase().trim();
    return currentUrls.filter((url) => url.toLowerCase().includes(searchTerm));
  }

  /**
   * Removes URLs from configuration and updates package indexes.
   */
  static async removeUrlsFromConfiguration(
    configService: ConfigService,
    commandService: CommandService,
    urlsToRemove: string[],
    currentUrls: string[]
  ): Promise<string[]> {
    const updatedUrls = currentUrls.filter((u) => !urlsToRemove.includes(u));

    const currentConfig = await configService.getConfiguration();
    await configService.setConfiguration({
      ...currentConfig.config,
      additionalUrls: updatedUrls,
    });

    spectreLog(`✅ Removed ${urlsToRemove.length} board manager URL(s) from preferences`);

    // Update package indexes
    spectreLog('🔄 Updating package indexes to reflect changes...');
    try {
      await commandService.executeCommand('arduino-update-package-index');
      spectreLog('✅ Package index updated');
    } catch (updateError) {
      spectreWarn('⚠️ Package index update failed:', updateError);
    }

    return updatedUrls;
  }

  /**
   * Formats board URL operation messages.
   * Consolidates all message formatting to reduce string-heavy parameters.
   */
  static formatBoardUrlMessage(params: BoardUrlMessageParams): string {
    const { type } = params;

    switch (type) {
      case 'noMatch':
        return `ℹ️ No matching board manager URLs found for: "${params.urlOrName}"

Current URLs:
${params.currentUrls?.map((u, i) => `${i + 1}. ${u}`).join('\n')}

💡 Tip: You can say "remove MiniCore" or "remove ESP32" to match by board name`;

      case 'multipleRemoval':
        return `✅ Removed ${
          params.urlsToRemove?.length
        } board manager URLs matching "${params.urlOrName}":

${params.urlsToRemove?.map((u, i) => `${i + 1}. ${u}`).join('\n')}

⚠️ Note: This only removes the URLs. Installed platforms remain until explicitly uninstalled.

Remaining URLs: ${params.remainingCount}`;

      case 'singleRemoval':
        return `✅ Removed board manager URL from preferences:
${params.url}

⚠️ Note: This only removes the URL. Installed platforms remain until explicitly uninstalled.

Remaining URLs: ${params.remainingCount}`;

      case 'addResult':
        let message = params.urlAlreadyExists
          ? `ℹ️ Board manager URL already configured:\n${params.url}`
          : `✅ Board manager URL added successfully:\n${params.url}`;

        if (params.updateResult?.success) {
          message += '\n✅ Package indexes updated successfully';
        } else {
          message += `\n⚠️ Package index update ${params.updateResult?.error || 'timed out'}`;
        }
        return message;
    }
  }
}
