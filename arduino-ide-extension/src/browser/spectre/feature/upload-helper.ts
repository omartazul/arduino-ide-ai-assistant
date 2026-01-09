/**
 * Helper utilities for upload and compilation operations in agent mode.
 * Handles upload retries, error analysis, and compilation error detection.
 *
 * @author Tazul Islam
 *
 */

/**
 * Upload pattern categories for output analysis.
 */
const UPLOAD_PATTERN_CATEGORIES = {
  criticalError: [
    /compilation terminated/i,
    /undefined reference/i,
    /was not declared/i,
    /expected.*before/i,
    /fatal error/i,
    /syntax error/i,
    /failed to compile/i,
    /sketch too big/i,
    /no such file/i,
  ],
  portError: [
    /avrdude.*(timeout|can't open|cannot open|access.*denied|permission.*denied)/i,
    /ser_open.*(failed|can't open|access.*denied)/i,
    /semaphore timeout/i,
    /device (busy|not found|access.*denied)/i,
    /port.*(busy|in use|access.*denied|not available)/i,
    /system cannot find.*specified/i,
    /the handle is invalid/i,
  ],
  uploadError: [
    /upload(ing)? error/i,
    /failed uploading/i,
    /flash.*error/i,
    /flash.*failed/i,
    /programmer.*error/i,
    /programmer.*failed/i,
    /exit status 1/i,
    /avrdude.*error(?!.*done)/i,
    /avrdude.*failed/i,
    /esptool.*error/i,
    /esptool.*failed/i,
    /openocd.*error/i,
    /stlink.*error/i,
  ],
  success: [
    /writing.*\d+.*bytes/i,
    /reading.*\d+.*bytes/i,
    /verifying.*\d+.*bytes/i,
    /\d+.*bytes.*written/i,
    /\d+.*bytes.*verified/i,
    /\d+.*bytes.*programmed/i,
    /upload.*complete/i,
    /uploading.*done/i,
    /flash.*complete/i,
    /programming.*complete/i,
    /programming.*successful/i,
    /received port after upload/i,
    /hard resetting/i,
    /reset.*complete/i,
    /target.*connected/i,
    /connecting\.\.\.../i,
    /leaving\.\.\.../i,
    /avrdude.*done/i,
    /avrdude\s*:\s*done/i,
    /esptool.*done/i,
    /openocd.*shutdown/i,
    /stlink.*programming.*successful/i,
  ],
  normalBuildOutput: [
    /sketch uses.*bytes/i,
    /global variables use.*bytes/i,
    /maximum is.*bytes/i,
  ],
};

/**
 * Compilation error patterns.
 */
const COMPILATION_ERROR_PATTERNS = [
  /error:/i,
  /compilation terminated/i,
  /undefined reference/i,
  /was not declared/i,
  /expected.*before/i,
  /stray.*in program/i,
  /missing terminating/i,
  /fatal error:/i,
  /syntax error/i,
  /cannot find/i,
  /not found/i,
  /failed to compile/i,
];

/**
 * Named keyword sets to avoid scattering primitive string literals.
 */
export enum ErrorKeyword {
  NotInSync = 'notInSync',
  Permission = 'permission',
  Compilation = 'compilation',
  Size = 'size',
  Programmer = 'programmer',
}

/**
 * Small helper type to encapsulate keyword sets and avoid primitive obsession.
 */
class KeywordSet {
  readonly values: readonly string[];

  constructor(values: string[]) {
    this.values = values;
  }

  contains(text: string): boolean {
    const lower = text.toLowerCase();
    return this.values.some((v) => lower.includes(v));
  }
}

/**
 * Map of error keyword kinds to canonical keyword sets used throughout helpers.
 */
const ERROR_KEYWORD_SETS: Record<ErrorKeyword, KeywordSet> = {
  [ErrorKeyword.NotInSync]: new KeywordSet(['not in sync']),
  [ErrorKeyword.Permission]: new KeywordSet(['permission denied', 'access']),
  [ErrorKeyword.Compilation]: new KeywordSet([
    'compilation',
    'undefined reference',
    'was not declared',
    'expected',
    'error:',
  ]),
  [ErrorKeyword.Size]: new KeywordSet(['sketch too big', 'overflowed']),
  [ErrorKeyword.Programmer]: new KeywordSet(['programmer']),
};

/**
 * Potential quick scan keywords for "potential" errors.
 */
const POTENTIAL_ERROR_KEYWORDS = new KeywordSet([
  'error:',
  'failed',
  'cannot',
  "can't",
]);

/**
 * Safely tests a regex against a text, resetting lastIndex to avoid stateful global regex issues.
 */
function testPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/**
 * Upload error patterns for all platforms.
 */
const UPLOAD_ERROR_PATTERNS = [
  /upload.*error/i,
  /upload.*failed/i,
  /upload.*timeout/i,
  /flash.*error/i,
  /flash.*failed/i,
  /programmer.*error/i,
  /programmer.*failed/i,
  /can't open.*port/i,
  /cannot open.*port/i,
  /ser_open.*failed/i,
  /ser_open.*can't open/i,
  /semaphore timeout/i,
  /exit status 1/i,
  /uploading error/i,
  /failed uploading/i,
  /permission denied/i,
  /device busy/i,
  /access denied/i,
  /device not found/i,
  /port.*busy/i,
  /port.*in use/i,
  /avrdude.*error/i,
  /avrdude.*failed/i,
  /esptool.*error/i,
  /esptool.*failed/i,
  /openocd.*error/i,
  /stlink.*error/i,
];

/**
 * Categorized upload output.
 */
interface CategorizedUploadOutput {
  criticalErrors: string[];
  portErrors: string[];
  uploadErrors: string[];
  successLines: string[];
  normalBuildLines: string[];
  genericErrors: string[];
}

/**
 * Strongly-typed categories for upload output lines to avoid primitive-string usage.
 */
export enum UploadLineCategory {
  CriticalError = 'criticalError',
  PortError = 'portError',
  UploadError = 'uploadError',
  Success = 'success',
  NormalBuildOutput = 'normalBuildOutput',
  Generic = 'generic',
}

/**
 * Upload analysis result.
 */
interface UploadAnalysisResult {
  success: boolean;
  error?: string;
  shouldRetry?: boolean;
}

/**
 * Context for error checking strategy.
 *
 * Encapsulates the original text and its lowercase form and provides helpers
 * to reduce primitive string argument passing across error-checking helpers.
 */
class ErrorContext {
  readonly text: string;
  readonly lower: string;

  constructor(text: string) {
    this.text = text;
    this.lower = text.toLowerCase();
  }

  includes(...subs: string[]): boolean {
    return subs.some((s) => this.lower.includes(s));
  }

  /**
   * Helper to test a named ErrorKeyword set to avoid passing raw strings everywhere.
   */
  hasKeyword(kind: ErrorKeyword): boolean {
    const keySet = ERROR_KEYWORD_SETS[kind];
    return keySet ? keySet.contains(this.text) : false;
  }

  matches(pattern: RegExp): boolean {
    // Use safe pattern tester to avoid stateful behavior with potentially global regexes
    if (testPattern(pattern, this.text)) return true;
    return testPattern(pattern, this.lower);
  }

  snippet(max = 300): string {
    return this.text.substring(0, max);
  }
}

/**
 * Helper class for upload and compilation operations.
 */
export class UploadHelper {
  static scanForCompilationErrors(lines: ReadonlyArray<string>): string[] {
    return UploadHelper.scanLinesForErrors(lines, COMPILATION_ERROR_PATTERNS);
  }

  static scanForUploadErrors(lines: ReadonlyArray<string>): string[] {
    return UploadHelper.scanLinesForErrors(lines, UPLOAD_ERROR_PATTERNS);
  }

  /**
   * Scans lines for errors using provided patterns.
   */
  static scanLinesForErrors(lines: ReadonlyArray<string>, patterns: ReadonlyArray<RegExp>): string[] {
    const errors: string[] = [];
    for (const line of lines) {
      for (const pattern of patterns) {
        if (testPattern(pattern, line)) {
          errors.push(line);
          break;
        }
      }
    }
    return errors;
  }

  /**
   * Checks for potential error keywords in lines.
   */
  static findPotentialErrors(lines: ReadonlyArray<string>): string[] {
    return lines.filter((line) => POTENTIAL_ERROR_KEYWORDS.contains(line));
  }

  /**
   * Categorizes a single output line by checking against all pattern categories.
   * Returns the category name or null if no match found.
   */
  static categorizeLine(line: string): UploadLineCategory | null {
    // Check critical errors first
    if (UPLOAD_PATTERN_CATEGORIES.criticalError.some((p) => testPattern(p, line))) {
      return UploadLineCategory.CriticalError;
    }

    // Check port errors
    if (UPLOAD_PATTERN_CATEGORIES.portError.some((p) => testPattern(p, line))) {
      return UploadLineCategory.PortError;
    }

    // Check upload errors
    if (UPLOAD_PATTERN_CATEGORIES.uploadError.some((p) => testPattern(p, line))) {
      return UploadLineCategory.UploadError;
    }

    // Check success patterns
    if (UPLOAD_PATTERN_CATEGORIES.success.some((p) => testPattern(p, line))) {
      return UploadLineCategory.Success;
    }

    // Check normal build output
    if (UPLOAD_PATTERN_CATEGORIES.normalBuildOutput.some((p) => testPattern(p, line))) {
      return UploadLineCategory.NormalBuildOutput;
    }

    // Check for generic errors (lines containing "error" but not matching specific patterns)
    if (testPattern(/error/i, line) && !testPattern(/avrdude.*done/i, line)) {
      return UploadLineCategory.Generic;
    }

    return null;
  }

  /**
   * Categorizes all upload output lines into their respective categories.
   */
  static categorizeUploadLines(lines: ReadonlyArray<string>): CategorizedUploadOutput {
    const categorized: CategorizedUploadOutput = {
      criticalErrors: [],
      portErrors: [],
      uploadErrors: [],
      successLines: [],
      normalBuildLines: [],
      genericErrors: [],
    };

    for (const line of lines) {
      const category = UploadHelper.categorizeLine(line);

      switch (category) {
        case UploadLineCategory.CriticalError:
          categorized.criticalErrors.push(line);
          break;
        case UploadLineCategory.PortError:
          categorized.portErrors.push(line);
          break;
        case UploadLineCategory.UploadError:
          categorized.uploadErrors.push(line);
          break;
        case UploadLineCategory.Success:
          categorized.successLines.push(line);
          break;
        case UploadLineCategory.NormalBuildOutput:
          categorized.normalBuildLines.push(line);
          break;
        case UploadLineCategory.Generic:
          categorized.genericErrors.push(line);
          break;
      }
    }

    return categorized;
  }

  /**
   * Checks if upload result has any actual errors.
   */
  static hasAnyErrors(categorized: CategorizedUploadOutput): boolean {
    return (
      categorized.criticalErrors.length > 0 ||
      categorized.portErrors.length > 0 ||
      categorized.uploadErrors.length > 0 ||
      categorized.genericErrors.length > 0
    );
  }

  /**
   * Determines success based on lack of content or normal build output.
   */
  static checkFallbackSuccess(
    categorized: CategorizedUploadOutput,
    hasAnyContent: boolean,
    hasActualErrors: boolean
  ): UploadAnalysisResult | null {
    if (!hasAnyContent) {
      return { success: true };
    }

    const hasNormalBuildWithoutSuccess =
      !hasActualErrors &&
      categorized.normalBuildLines.length > 0 &&
      categorized.successLines.length === 0;

    if (hasNormalBuildWithoutSuccess) {
      return { success: true };
    }

    if (!hasActualErrors && categorized.successLines.length === 0) {
      return {
        success: false,
        error: 'Upload outcome is unclear. Check the output manually.',
        shouldRetry: false,
      };
    }

    return null;
  }

  /**
   * Determines upload result from categorized lines.
   */
  static determineUploadResult(
    categorized: CategorizedUploadOutput,
    hasAnyContent: boolean
  ): UploadAnalysisResult {
    const hasActualErrors = UploadHelper.hasAnyErrors(categorized);

    // Check critical errors first
    if (categorized.criticalErrors.length > 0) {
      return {
        success: false,
        error: `Compilation failed:\n${categorized.criticalErrors
          .slice(0, 3)
          .join('\n')}`,
        shouldRetry: false,
      };
    }

    // Check for port errors with retry hint
    if (categorized.portErrors.length > 0) {
      return {
        success: false,
        error: `Port error:\n${categorized.portErrors.slice(0, 2).join('\n')}`,
        shouldRetry: true,
      };
    }

    // Check for upload errors
    if (categorized.uploadErrors.length > 0) {
      return {
        success: false,
        error: `Upload failed:\n${categorized.uploadErrors
          .slice(0, 3)
          .join('\n')}`,
        shouldRetry: false,
      };
    }

    // Check for success indicators
    if (categorized.successLines.length > 0) {
      return { success: true };
    }

    // Fallback logic
    const fallback = UploadHelper.checkFallbackSuccess(
      categorized,
      hasAnyContent,
      hasActualErrors
    );
    if (fallback) {
      return fallback;
    }

    // Default: no clear success or error
    return {
      success: false,
      error: 'Upload status unclear. Check output manually.',
      shouldRetry: false,
    };
  }

  /**
   * Analyzes upload output and determines success/failure.
   */
  static analyzeUploadOutput(diff: string): UploadAnalysisResult {
    const lines = diff.split('\n').filter((l) => l.trim().length > 0);
    const categorized = UploadHelper.categorizeUploadLines(lines);
    return UploadHelper.determineUploadResult(categorized, lines.length > 0);
  }

  /**
   * Formats upload error with specific guidance based on error type.
   */
  static formatUploadError(errTextOrContext: string | ErrorContext): Error {
    const context =
      typeof errTextOrContext === 'string'
        ? new ErrorContext(errTextOrContext)
        : errTextOrContext;

    // Common Arduino IDE/CLI upload failures
    if (context.hasKeyword(ErrorKeyword.NotInSync)) {
      return new Error(
        `Upload failed - board not responding. Try:\n1. Reset the board\n2. Try a different USB cable\n3. Select a different port\n\nError: ${context.snippet(300)}`
      );
    }

    if (context.hasKeyword(ErrorKeyword.Permission)) {
      return new Error(
        `Permission denied - port may be in use. Try:\n1. Close Serial Monitor\n2. Disconnect other programs\n3. Try a different port\n\nError: ${context.snippet(300)}`
      );
    }

    // Check for compilation errors
    const compilationError = UploadHelper.checkCompilationError(context);
    if (compilationError) return compilationError;

    // Check for size errors
    const sizeError = UploadHelper.checkSizeError(context);
    if (sizeError) return sizeError;

    // Check for programmer errors
    const programmerError = UploadHelper.checkProgrammerError(context);
    if (programmerError) return programmerError;

    // Generic upload error
    return new Error(`Upload failed:\n${context.snippet(300)}`);
  }

  static checkCompilationError(context: ErrorContext): Error | null {
    if (context.hasKeyword(ErrorKeyword.Compilation)) {
      return new Error(
        `Compilation error - fix the code first:\n${context.snippet(500)}`
      );
    }
    return null;
  }

  static checkSizeError(context: ErrorContext): Error | null {
    if (context.hasKeyword(ErrorKeyword.Size)) {
      return new Error(
        `Sketch is too large for the selected board:\n${context.snippet(300)}`
      );
    }
    return null;
  }

  static checkProgrammerError(context: ErrorContext): Error | null {
    if (context.hasKeyword(ErrorKeyword.Programmer)) {
      return new Error(
        `Programmer/bootloader error - check board and connections:\n${context.snippet(
          300
        )}`
      );
    }
    return null;
  }

  /**
   * Scans lines for various error types and returns the first found error group.
   * Priority: Upload Error > Compilation Error > Potential Error
   */
  static extractFirstError(recentLines: ReadonlyArray<string>): string | null {
    const uploadErrorLines = UploadHelper.scanForUploadErrors(recentLines);
    if (uploadErrorLines.length > 0) {
      return uploadErrorLines.join('\n');
    }

    const compilationErrorLines =
      UploadHelper.scanForCompilationErrors(recentLines);
    if (compilationErrorLines.length > 0) {
      return compilationErrorLines.join('\n');
    }

    const potentialErrors = UploadHelper.findPotentialErrors(recentLines);
    if (potentialErrors.length > 0) {
      return potentialErrors.join('\n');
    }

    return null;
  }
}
