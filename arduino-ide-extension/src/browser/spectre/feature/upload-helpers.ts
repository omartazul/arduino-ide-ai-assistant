/**
 * Helper utilities for upload and compilation operations in agent mode.
 * Handles upload retries, error analysis, and compilation error detection.
 * 
 * CODESCENE WARNINGS (Acceptable):
 * 
 * 1. "String Heavy Function Arguments":
 *    Methods like checkCompilationError(errLower: string, errText: string) use 2 strings
 *    with distinct purposes:
 *    - errLower: pre-processed lowercase for efficient pattern matching
 *
 * @author Tazul Islam
 *
 *    - errText: original text for error display
 *    This avoids repeated toLowerCase() calls and is more efficient than a parameter object.
 * 
 * 2. "Primitive Obsession":
 *    This is a utility module with pattern matching and analysis functions. Using primitives
 *    (strings, booleans) is appropriate for:
 *    - scanLinesForErrors(lines: string[], patterns: RegExp[]) - array utilities
 *    - categorizeLine(line: string) - single string classification
 *    - analyzeUploadOutput(diff: string) - text analysis
 *    
 *    Parameter objects would add boilerplate without improving clarity or type safety.
 *    The code uses TypeScript interfaces (CategorizedUploadOutput, UploadAnalysisResult)
 *    for complex return types, which is the right balance.
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
  /error:/gi,
  /compilation terminated/gi,
  /undefined reference/gi,
  /was not declared/gi,
  /expected.*before/gi,
  /stray.*in program/gi,
  /missing terminating/gi,
  /fatal error:/gi,
  /syntax error/gi,
  /cannot find/gi,
  /not found/gi,
  /failed to compile/gi,
];

/**
 * Upload error patterns for all platforms.
 */
const UPLOAD_ERROR_PATTERNS = [
  /upload.*error/gi,
  /upload.*failed/gi,
  /upload.*timeout/gi,
  /flash.*error/gi,
  /flash.*failed/gi,
  /programmer.*error/gi,
  /programmer.*failed/gi,
  /can't open.*port/gi,
  /cannot open.*port/gi,
  /ser_open.*failed/gi,
  /ser_open.*can't open/gi,
  /semaphore timeout/gi,
  /exit status 1/gi,
  /uploading error/gi,
  /failed uploading/gi,
  /permission denied/gi,
  /device busy/gi,
  /access denied/gi,
  /device not found/gi,
  /port.*busy/gi,
  /port.*in use/gi,
  /avrdude.*error/gi,
  /avrdude.*failed/gi,
  /esptool.*error/gi,
  /esptool.*failed/gi,
  /openocd.*error/gi,
  /stlink.*error/gi,
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
 * Upload analysis result.
 */
interface UploadAnalysisResult {
  success: boolean;
  error?: string;
  shouldRetry?: boolean;
}

/**
 * Helper class for upload and compilation operations.
 */
export class UploadHelper {
  static scanForCompilationErrors(lines: string[]): string[] {
    return UploadHelper.scanLinesForErrors(lines, COMPILATION_ERROR_PATTERNS);
  }

  static scanForUploadErrors(lines: string[]): string[] {
    return UploadHelper.scanLinesForErrors(lines, UPLOAD_ERROR_PATTERNS);
  }

  /**
   * Scans lines for errors using provided patterns.
   */
  static scanLinesForErrors(lines: string[], patterns: RegExp[]): string[] {
    const errors: string[] = [];
    for (const line of lines) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
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
  static findPotentialErrors(lines: string[]): string[] {
    const errorKeywords = ['error:', 'failed', 'cannot', "can't"];
    return lines.filter((line) => {
      const lower = line.toLowerCase();
      return errorKeywords.some((kw) => lower.includes(kw));
    });
  }

  /**
   * Categorizes a single output line by checking against all pattern categories.
   * Returns the category name or null if no match found.
   */
  static categorizeLine(
    line: string
  ): keyof typeof UPLOAD_PATTERN_CATEGORIES | 'generic' | null {
    // Check critical errors first
    if (UPLOAD_PATTERN_CATEGORIES.criticalError.some((p) => p.test(line))) {
      return 'criticalError';
    }

    // Check port errors
    if (UPLOAD_PATTERN_CATEGORIES.portError.some((p) => p.test(line))) {
      return 'portError';
    }

    // Check upload errors
    if (UPLOAD_PATTERN_CATEGORIES.uploadError.some((p) => p.test(line))) {
      return 'uploadError';
    }

    // Check success patterns
    if (UPLOAD_PATTERN_CATEGORIES.success.some((p) => p.test(line))) {
      return 'success';
    }

    // Check normal build output
    if (UPLOAD_PATTERN_CATEGORIES.normalBuildOutput.some((p) => p.test(line))) {
      return 'normalBuildOutput';
    }

    // Check for generic errors (lines containing "error" but not matching specific patterns)
    if (/error/i.test(line) && !/avrdude.*done/i.test(line)) {
      return 'generic';
    }

    return null;
  }

  /**
   * Categorizes all upload output lines into their respective categories.
   */
  static categorizeUploadLines(lines: string[]): CategorizedUploadOutput {
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
        case 'criticalError':
          categorized.criticalErrors.push(line);
          break;
        case 'portError':
          categorized.portErrors.push(line);
          break;
        case 'uploadError':
          categorized.uploadErrors.push(line);
          break;
        case 'success':
          categorized.successLines.push(line);
          break;
        case 'normalBuildOutput':
          categorized.normalBuildLines.push(line);
          break;
        case 'generic':
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
        error: 'Upload completed without confirmation. Check the output manually.',
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
        error: `Compilation failed:\n${categorized.criticalErrors.slice(0, 3).join('\n')}`,
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
        error: `Upload failed:\n${categorized.uploadErrors.slice(0, 3).join('\n')}`,
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
    const lines = diff.split('\n').filter((l) => l.trim());
    const categorized = UploadHelper.categorizeUploadLines(lines);
    return UploadHelper.determineUploadResult(categorized, lines.length > 0);
  }

  /**
   * Formats upload error with specific guidance based on error type.
   */
  static formatUploadError(errText: string): Error {
    const errLower = errText.toLowerCase();

    // Check for compilation errors
    const compilationError = UploadHelper.checkCompilationError(errLower, errText);
    if (compilationError) return compilationError;

    // Check for size errors
    const sizeError = UploadHelper.checkSizeError(errLower, errText);
    if (sizeError) return sizeError;

    // Check for programmer errors
    const programmerError = UploadHelper.checkProgrammerError(errLower, errText);
    if (programmerError) return programmerError;

    // Generic upload error
    return new Error(`Upload failed:\n${errText}`);
  }

  static checkCompilationError(errLower: string, errText: string): Error | null {
    const hasCompilationError =
      errLower.includes('compilation') ||
      errLower.includes('undefined reference') ||
      errLower.includes('was not declared');

    if (hasCompilationError) {
      return new Error(
        `Compilation error - fix the code first:\n${errText.substring(0, 500)}`
      );
    }
    return null;
  }

  static checkSizeError(errLower: string, errText: string): Error | null {
    if (errLower.includes('sketch too big') || errLower.includes('overflowed')) {
      return new Error(
        `Sketch is too large for the selected board:\n${errText.substring(0, 300)}`
      );
    }
    return null;
  }

  static checkProgrammerError(errLower: string, errText: string): Error | null {
    if (errLower.includes('programmer')) {
      return new Error(
        `Programmer/bootloader error - check board and connections:\n${errText.substring(0, 300)}`
      );
    }
    return null;
  }
}
