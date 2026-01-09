/**
 * Helper utilities for board operations in agent mode.
 * Handles board search, selection, configuration, platform management, and board URL management.
 *
 * @author Tazul Islam
 */

import { DetectedPort } from '../../../common/protocol';
import {
  spectreLog,
  spectreWarn,
} from '../../../common/protocol/spectre-types';
import { Board, BoardsPackage } from '../../../common/protocol/boards-service';

/**
 * Domain-specific aliases to avoid primitive obsession with plain strings.
 * (These are intentionally lightweight to avoid forcing call-site changes.)
 */
type TextToken = string;
type BoardNameQuery = string;
type ConfigOptionsText = string;
type Fqbn = string;
type PlatformIdText = string;
type PortAddress = string;
type WikiContent = string;
type WikiLine = string;
type SearchQuery = string;
type BoardManagerUrl = string;
type UrlOrNameQuery = string;
type ErrorText = string;

type LevenshteinDistanceArgs =
  | [a: TextToken, b: TextToken]
  | [params: { a: TextToken; b: TextToken }];

type FuzzyMatchArgs =
  | [word1: TextToken, word2: TextToken]
  | [params: { word1: TextToken; word2: TextToken }];

type ExtractBoardUrlFromLineArgs =
  | [line: WikiLine, query: SearchQuery]
  | [params: { line: WikiLine; query: SearchQuery }];

type ParseWikiForBoardUrlsArgs =
  | [wikiContent: WikiContent, query: SearchQuery]
  | [params: { wikiContent: WikiContent; query: SearchQuery }];

type FormatBoardUrlResultsArgs =
  | [matches: BoardUrlEntry[], query: SearchQuery]
  | [params: { matches: BoardUrlEntry[]; query: SearchQuery }];

/**
 * Cached board data for efficient lookups.
 */
interface CachedBoard {
  board: Board;
  normalizedName: string;
  normalizedWords: string[];
  lastUpdated: number;
}

/**
 * Result type for board search operations.
 */
interface BoardSearchResult {
  board: Board | null;
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
 * Strongly-typed platform identifier to avoid primitive obsession with plain strings.
 */
class PlatformId {
  readonly vendor: string;
  readonly arch: string;

  private constructor(vendor: string, arch: string) {
    this.vendor = vendor;
    this.arch = arch;
  }

  static parse(input: string): PlatformId | null {
    if (!input) return null;
    const parts = input.split(':').map((p) => p.trim());
    if (parts.length !== 2) return null;
    const [vendor, arch] = parts;
    if (!vendor || !arch) return null;
    return new PlatformId(vendor, arch);
  }

  toString(): string {
    return `${this.vendor}:${this.arch}`;
  }
}

/**
 * Typed representation of a board URL entry.
 */
interface BoardUrlEntry {
  name: string;
  url: BoardManagerUrl;
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
  static buildBoardCache(boards: Board[]): Map<string, CachedBoard> {
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
    const firstEntry = cache.values().next().value as CachedBoard | undefined;
    if (!firstEntry) return false;
    return now - firstEntry.lastUpdated < ttlMs;
  }

  private static normalizeLevenshteinDistanceArgs(
    args: LevenshteinDistanceArgs
  ): { a: TextToken; b: TextToken } {
    const first = args[0] as unknown;
    if (BoardHelper.isObjectWithKeys(first, 'a', 'b')) {
      const p = first as { a: TextToken; b: TextToken };
      return { a: p.a, b: p.b };
    }

    return { a: args[0] as TextToken, b: args[1] as TextToken };
  }

  private static normalizeFuzzyMatchArgs(
    args: FuzzyMatchArgs
  ): { word1: TextToken; word2: TextToken } {
    const first = args[0] as unknown;
    if (BoardHelper.isObjectWithKeys(first, 'word1', 'word2')) {
      const p = first as { word1: TextToken; word2: TextToken };
      return { word1: p.word1, word2: p.word2 };
    }

    return { word1: args[0] as TextToken, word2: args[1] as TextToken };
  }

  /**
   * Calculates Levenshtein distance (edit distance) between two strings.
   * Measures how many single-character edits are needed to change one word into another.
   */
  static levenshteinDistance(...args: LevenshteinDistanceArgs): number {
    const { a: str1, b: str2 } = BoardHelper.normalizeLevenshteinDistanceArgs(
      args
    );

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
  static isFuzzyMatch(...args: FuzzyMatchArgs): boolean {
    const { word1, word2 } = BoardHelper.normalizeFuzzyMatchArgs(args);

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
    inputName: BoardNameQuery,
    cache: Map<string, CachedBoard>
  ): BoardSearchResult {
    const inputWords = inputName.toLowerCase().split(/\s+/);

    // Try exact match first (substring)
    const exactMatch = BoardHelper.tryMatchWithComparator(
      inputWords,
      cache,
      (inputWord, boardWord) => boardWord.includes(inputWord)
    );
    if (exactMatch) {
      return { board: exactMatch, matchType: 'exact' };
    }

    // Try fuzzy match (typo tolerance)
    const fuzzyMatch = BoardHelper.tryMatchWithComparator(
      inputWords,
      cache,
      (inputWord, boardWord) => BoardHelper.isFuzzyMatch(inputWord, boardWord)
    );
    if (fuzzyMatch) {
      return { board: fuzzyMatch, matchType: 'fuzzy' };
    }

    return { board: null };
  }

  private static tryMatchWithComparator(
    inputWords: string[],
    cache: Map<string, CachedBoard>,
    comparator: (inputWord: string, boardWord: string) => boolean
  ): Board | null {
    for (const cached of cache.values()) {
      const allMatch = inputWords.every((inputWord) =>
        cached.normalizedWords.some((boardWord) =>
          comparator(inputWord, boardWord)
        )
      );
      if (allMatch) {
        return cached.board;
      }
    }
    return null;
  }

  // Exact and fuzzy matching have been consolidated into findBoardByName
  // to avoid duplication; tryMatchWithComparator is used directly there.

  /**
   * Parses board configuration options from string format.
   */
  static parseConfigOptions(options: ConfigOptionsText): BoardConfigOption[] {
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
  static extractBoardIdFromFqbn(fqbn: Fqbn): string {
    const parts = fqbn.split(':');
    return parts.length >= 3 ? parts[2].split('.')[0] : '';
  }

  /**
   * Parses a platform ID into its components (vendor and arch).
   */
  private static parsePlatformId(
    platformId: PlatformIdText
  ): PlatformId | null {
    return PlatformId.parse(platformId);
  }

  /**
   * Validates platform ID format.
   * Used by both install and uninstall operations.
   */
  static validatePlatformId(
    platformId: PlatformIdText,
    operation: 'installation' | 'uninstallation' = 'installation'
  ): string | null {
    const parsed = BoardHelper.parsePlatformId(platformId);
    if (!parsed) {
      return `Invalid platform ID format for ${operation}. Expected format: "vendor:arch" (e.g., "arduino:avr", "esp32:esp32")`;
    }
    return null;
  }

  /**
   * Builds lookup maps for platform search results.
   */
  static buildPlatformLookupMaps(searchResults: BoardsPackage[]): {
    exactMap: Map<string, BoardsPackage>;
    caseInsensitiveMap: Map<string, BoardsPackage>;
  } {
    const exactMap = new Map<string, BoardsPackage>();
    const caseInsensitiveMap = new Map<string, BoardsPackage>();

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
    platformId: PlatformIdText,
    searchResults: BoardsPackage[],
    exactMap: Map<string, BoardsPackage>,
    caseInsensitiveMap: Map<string, BoardsPackage>
  ): BoardsPackage | null {
    // Try exact match
    if (exactMap.has(platformId)) {
      return exactMap.get(platformId) || null;
    }

    // Try case-insensitive
    const lowerPlatformId = platformId.toLowerCase();
    if (caseInsensitiveMap.has(lowerPlatformId)) {
      return caseInsensitiveMap.get(lowerPlatformId) || null;
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
    platformId: PlatformIdText,
    searchResults: BoardsPackage[]
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
    currentPort: PortAddress | undefined
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
  static isPortRelatedError(errText: ErrorText, shouldRetry?: boolean): boolean {
    const errLower = errText.toLowerCase();
    return (
      shouldRetry === true ||
      BoardHelper.PORT_ERROR_KEYWORDS.some((kw) => errLower.includes(kw))
    );
  }

  /**
   * Small reusable type-guard to reduce complex conditionals in normalize helpers.
   */
  private static isObjectWithKeys<T extends string>(
    obj: unknown,
    ...keys: T[]
  ): obj is Record<T, unknown> {
    if (typeof obj !== 'object') return false;
    if (obj === null) return false;

    const record = obj as Record<string, unknown>;
    const hasAllKeys = keys.every((k) => k in record);

    return hasAllKeys;
  }

  /**
   * Extracts board URL from a wiki line.
   */
  private static normalizeArgs<T extends Record<string, unknown>>(
    args: unknown[],
    keys: (keyof T)[]
  ): T {
    const first = args[0] as unknown;
    if (BoardHelper.isObjectWithKeys(first, ...(keys as string[]))) {
      return first as T;
    }

    const result = {} as T;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      (result as Record<string, unknown>)[key] = args[i] as unknown;
    }
    return result;
  }

  private static normalizeExtractBoardUrlFromLineArgs(
    args: ExtractBoardUrlFromLineArgs
  ): { line: WikiLine; query: SearchQuery } {
    return BoardHelper.normalizeArgs<{ line: WikiLine; query: SearchQuery }>(
      args,
      ['line', 'query']
    );
  }

  private static normalizeParseWikiForBoardUrlsArgs(
    args: ParseWikiForBoardUrlsArgs
  ): { wikiContent: WikiContent; query: SearchQuery } {
    return BoardHelper.normalizeArgs<{ wikiContent: WikiContent; query: SearchQuery }>(
      args,
      ['wikiContent', 'query']
    );
  }

  private static normalizeFormatBoardUrlResultsArgs(
    args: FormatBoardUrlResultsArgs
  ): { matches: BoardUrlEntry[]; query: SearchQuery } {
    return BoardHelper.normalizeArgs<{ matches: BoardUrlEntry[]; query: SearchQuery }>(
      args,
      ['matches', 'query']
    );
  }

  /**
   * Extracts board URL from a wiki line.
   */
  static extractBoardUrlFromLine(
    ...args: ExtractBoardUrlFromLineArgs
  ): BoardUrlEntry | null {
    const { line, query } = BoardHelper.normalizeExtractBoardUrlFromLineArgs(args);

    const nameMatch = line.match(/\*\s*\*\*([^*]+)\*\*/);
    if (!nameMatch) return null;

    const name = nameMatch[1].trim();
    if (!name.toLowerCase().includes(query.toLowerCase())) {
      return null;
    }

    const urlMatch = line.match(/https?:\/\/[^\s)]+\.json/i);
    if (!urlMatch) return null;

    return { name, url: urlMatch[0] as BoardManagerUrl };
  }

  /**
   * Parses wiki content to find board URLs matching query.
   */
  static parseWikiForBoardUrls(...args: ParseWikiForBoardUrlsArgs): BoardUrlEntry[] {
    const { wikiContent, query } = BoardHelper.normalizeParseWikiForBoardUrlsArgs(
      args
    );

    const lines = wikiContent.split('\n');
    const matches: BoardUrlEntry[] = [];

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
  static formatBoardUrlResults(...args: FormatBoardUrlResultsArgs): string {
    const { matches, query } = BoardHelper.normalizeFormatBoardUrlResultsArgs(
      args
    );

    if (matches.length === 0) {
      return `No board manager URLs found for "${query}".\n\nPlease search the Arduino Wiki manually or provide a specific board manager URL.`;
    }

    const results = matches.map((m) => `- **${m.name}**: ${m.url}`).join('\n');

    return `Found ${matches.length} board manager URL(s) for "${query}":\n\n${results}\n\nTo add a URL, use: agentAddBoardUrl("url")`;
  }
}

/**
 * Configuration service interface for board URL operations.
 */
interface ConfigService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConfiguration(): Promise<{ config?: any }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setConfiguration(config: any): Promise<void>;
}

/**
 * Command service interface for board URL operations.
 */
interface CommandService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeCommand(command: string, ...args: any[]): Promise<any>;
}

/**
 * Parameters for formatting board URL messages (discriminated union per message type).
 */
type BoardUrlMessageParams =
  | { type: 'noMatch'; urlOrName: UrlOrNameQuery; currentUrls: BoardManagerUrl[] }
  | {
      type: 'multipleRemoval';
      urlOrName: UrlOrNameQuery;
      urlsToRemove: BoardManagerUrl[];
      remainingCount: number;
    }
  | { type: 'singleRemoval'; url: BoardManagerUrl; remainingCount: number }
  | {
      type: 'addResult';
      url: BoardManagerUrl;
      urlAlreadyExists: boolean;
      updateResult?: { success: boolean; error?: string };
    };

/**
 * Helper class for board URL management operations.
 */
export class BoardUrlHelper {
  /**
   * Adds a board manager URL to configuration.
   */
  static async addToConfiguration(
    configService: ConfigService,
    url: BoardManagerUrl
  ): Promise<{ currentUrls: BoardManagerUrl[]; urlAlreadyExists: boolean }> {
    const currentConfig = await configService.getConfiguration();
    if (!currentConfig.config) {
      throw new Error('Failed to read configuration');
    }

    const currentUrls: BoardManagerUrl[] = currentConfig.config.additionalUrls || [];
    const urlAlreadyExists = currentUrls.includes(url);

    let finalUrls = currentUrls;
    if (!urlAlreadyExists) {
      finalUrls = [...currentUrls, url];
      await configService.setConfiguration({
        ...currentConfig.config,
        additionalUrls: finalUrls,
      });
      spectreLog('✅ Board manager URL added to preferences');
    } else {
      spectreLog(`ℹ️ Board manager URL already configured: ${url}`);
    }

    return { currentUrls: finalUrls, urlAlreadyExists };
  }

  /**
   * Finds URLs to remove based on exact match or fuzzy search.
   */
  static findUrlsToRemove(
    urlOrName: UrlOrNameQuery,
    currentUrls: BoardManagerUrl[]
  ): BoardManagerUrl[] {
    if (currentUrls.includes(urlOrName as BoardManagerUrl)) {
      return [urlOrName as BoardManagerUrl];
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
    urlsToRemove: BoardManagerUrl[],
    currentUrls: BoardManagerUrl[]
  ): Promise<BoardManagerUrl[]> {
    const updatedUrls = currentUrls.filter((u) => !urlsToRemove.includes(u));

    const currentConfig = await configService.getConfiguration();
    await configService.setConfiguration({
      ...currentConfig.config,
      additionalUrls: updatedUrls,
    });

    spectreLog(
      `✅ Removed ${urlsToRemove.length} board manager URL(s) from preferences`
    );

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
    switch (params.type) {
      case 'noMatch': {
        const p = params;
        return `ℹ️ No matching board manager URLs found for: "${p.urlOrName}"

Current URLs:
${p.currentUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}

💡 Tip: You can say "remove MiniCore" or "remove ESP32" to match by board name`;
      }

      case 'multipleRemoval': {
        const p = params;
        return `✅ Removed ${p.urlsToRemove.length} board manager URLs matching "${p.urlOrName}":

${p.urlsToRemove.map((u, i) => `${i + 1}. ${u}`).join('\n')}

⚠️ Note: This only removes the URLs. Installed platforms remain until explicitly uninstalled.

Remaining URLs: ${p.remainingCount}`;
      }

      case 'singleRemoval': {
        const p = params;
        return `✅ Removed board manager URL from preferences:
${p.url}

⚠️ Note: This only removes the URL. Installed platforms remain until explicitly uninstalled.

Remaining URLs: ${p.remainingCount}`;
      }

      case 'addResult': {
        const p = params;
        let message = p.urlAlreadyExists
          ? `ℹ️ Board manager URL already configured:\n${p.url}`
          : `✅ Board manager URL added successfully:\n${p.url}`;

        if (p.updateResult?.success) {
          message += '\n✅ Package indexes updated successfully';
        } else {
          message += `\n⚠️ Package index update ${p.updateResult?.error || 'timed out'}`;
        }
        return message;
      }
    }
  }
}
