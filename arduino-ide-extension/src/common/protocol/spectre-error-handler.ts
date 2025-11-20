/**
 * Error handling utility for Spectre AI assistant.
 * Provides categorized, user-friendly error messages with recovery suggestions.
 *
 * Approach:
 * - Error categorization by type (API, Network, Quota, Validation, etc.)
 * - Severity levels (ERROR, WARNING, INFO)
 * - Structured error responses with actionable recovery steps
 * - Localization-ready message structure
 *
 * @author Tazul Islam
 */

/**
 * Error severity levels for proper UI handling.
 */
export enum ErrorSeverity {
  /** Critical error - operation failed completely */
  ERROR = 'error',
  /** Warning - operation completed with issues */
  WARNING = 'warning',
  /** Informational - user should be aware but no failure */
  INFO = 'info',
}

/**
 * Error categories for specialized handling.
 */
export enum ErrorCategory {
  /** Gemini API errors (4xx, 5xx responses) */
  API_ERROR = 'api_error',
  /** Network connectivity issues */
  NETWORK_ERROR = 'network_error',
  /** Quota/rate limit exceeded */
  QUOTA_EXCEEDED = 'quota_exceeded',
  /** Invalid user input */
  VALIDATION_ERROR = 'validation_error',
  /** Configuration/settings issues */
  CONFIGURATION_ERROR = 'configuration_error',
  /** File system operations failed */
  FILE_SYSTEM_ERROR = 'file_system_error',
  /** Arduino-specific errors (compile, upload, board selection) */
  ARDUINO_ERROR = 'arduino_error',
  /** Unexpected/unknown errors */
  UNKNOWN_ERROR = 'unknown_error',
}

/**
 * Structured error response for consistent error handling.
 */
export interface SpectreErrorResponse {
  /** Error category for specialized handling */
  category: ErrorCategory;
  /** Severity level for UI treatment */
  severity: ErrorSeverity;
  /** User-friendly error title */
  title: string;
  /** Detailed error message */
  message: string;
  /** Actionable recovery suggestions */
  suggestions: string[];
  /** Technical details for debugging (optional) */
  technicalDetails?: string;
  /** Whether the operation can be retried */
  retryable: boolean;
  /** Original error object (for logging) */
  originalError?: unknown;
}

/**
 * Error handler for Spectre AI operations.
 * Transforms raw errors into user-friendly, actionable messages.
 */
export class SpectreErrorHandler {
  /**
   * Main error handling entry point.
   * Analyzes error and returns structured, user-friendly response.
   */
  static handleError(error: unknown, context?: string): SpectreErrorResponse {
    // Extract error message
    const errorMessage = this.extractErrorMessage(error);
    const lowerMessage = errorMessage.toLowerCase();

    // Categorize and handle by type
    if (this.isQuotaError(lowerMessage)) {
      return this.handleQuotaError(errorMessage, error);
    }

    if (this.isNetworkError(lowerMessage)) {
      return this.handleNetworkError(errorMessage, error);
    }

    if (this.isApiError(lowerMessage)) {
      return this.handleApiError(errorMessage, error);
    }

    if (this.isValidationError(lowerMessage)) {
      return this.handleValidationError(errorMessage, error);
    }

    if (this.isConfigurationError(lowerMessage)) {
      return this.handleConfigurationError(errorMessage, error);
    }

    if (this.isFileSystemError(lowerMessage)) {
      return this.handleFileSystemError(errorMessage, error);
    }

    if (this.isArduinoError(lowerMessage)) {
      return this.handleArduinoError(errorMessage, error);
    }

    // Unknown error - provide generic handling
    return this.handleUnknownError(errorMessage, error, context);
  }

  /**
   * Extract human-readable message from error object.
   */
  private static extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object' && 'message' in error) {
      return String(error.message);
    }
    return String(error);
  }

  // ============================================================================
  // ERROR TYPE DETECTION
  // ============================================================================

  private static isQuotaError(message: string): boolean {
    return (
      message.includes('quota') ||
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('429') ||
      message.includes('resource exhausted')
    );
  }

  private static isNetworkError(message: string): boolean {
    return (
      message.includes('network') ||
      message.includes('enotfound') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('fetch failed') ||
      message.includes('unable to connect')
    );
  }

  private static isApiError(message: string): boolean {
    return (
      message.includes('api error') ||
      message.includes('400') ||
      message.includes('401') ||
      message.includes('403') ||
      message.includes('404') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('invalid api key') ||
      message.includes('unauthorized')
    );
  }

  private static isValidationError(message: string): boolean {
    return (
      message.includes('invalid') ||
      message.includes('required') ||
      message.includes('must be') ||
      message.includes('cannot be empty') ||
      message.includes('validation failed')
    );
  }

  private static isConfigurationError(message: string): boolean {
    return (
      message.includes('configuration') ||
      message.includes('settings') ||
      message.includes('preference') ||
      message.includes('not configured') ||
      message.includes('api key')
    );
  }

  private static isFileSystemError(message: string): boolean {
    return (
      message.includes('enoent') ||
      message.includes('eacces') ||
      message.includes('file not found') ||
      message.includes('permission denied') ||
      message.includes('read only')
    );
  }

  private static isArduinoError(message: string): boolean {
    return (
      message.includes('board') ||
      message.includes('port') ||
      message.includes('compile') ||
      message.includes('upload') ||
      message.includes('sketch') ||
      message.includes('fqbn')
    );
  }

  // ============================================================================
  // SPECIALIZED ERROR HANDLERS
  // ============================================================================

  private static handleQuotaError(
    message: string,
    error: unknown
  ): SpectreErrorResponse {
    // Determine if it's TPM or RPM quota
    const isTpmQuota = message.includes('token') || message.includes('tpm');

    return {
      category: ErrorCategory.QUOTA_EXCEEDED,
      severity: ErrorSeverity.WARNING,
      title: isTpmQuota
        ? 'Token Quota Exceeded'
        : 'Request Rate Limit Exceeded',
      message: isTpmQuota
        ? "You've exceeded the available token quota for Gemini API."
        : 'Too many requests sent to Gemini API in a short time.',
      suggestions: [
        isTpmQuota
          ? 'Wait a moment for token quota to refresh (resets every minute)'
          : 'Wait a few seconds before sending another request',
        'Consider upgrading to Gemini 2.5 Flash for higher limits',
        'Check the quota display in the widget header for availability',
      ],
      technicalDetails: message,
      retryable: true,
      originalError: error,
    };
  }

  private static handleNetworkError(
    message: string,
    error: unknown
  ): SpectreErrorResponse {
    return {
      category: ErrorCategory.NETWORK_ERROR,
      severity: ErrorSeverity.ERROR,
      title: 'Network Connection Failed',
      message:
        'Unable to connect to Gemini API. Please check your internet connection.',
      suggestions: [
        'Verify your internet connection is active',
        'Check if a firewall or proxy is blocking connections',
        'Try again in a few moments',
        'Check if https://generativelanguage.googleapis.com is accessible',
      ],
      technicalDetails: message,
      retryable: true,
      originalError: error,
    };
  }

  private static handleApiError(
    message: string,
    error: unknown
  ): SpectreErrorResponse {
    // Check for specific API error codes
    if (message.includes('401') || message.includes('unauthorized')) {
      return {
        category: ErrorCategory.API_ERROR,
        severity: ErrorSeverity.ERROR,
        title: 'Invalid API Key',
        message: 'Your Gemini API key is invalid or has been revoked.',
        suggestions: [
          'Open Arduino IDE Preferences (File → Preferences)',
          'Navigate to Arduino → Spectre AI',
          'Verify your API key is correct',
          'Generate a new API key at https://aistudio.google.com/apikey',
        ],
        technicalDetails: message,
        retryable: false,
        originalError: error,
      };
    }

    if (message.includes('403') || message.includes('forbidden')) {
      return {
        category: ErrorCategory.API_ERROR,
        severity: ErrorSeverity.ERROR,
        title: 'API Access Forbidden',
        message:
          "Your API key doesn't have permission to access this resource.",
        suggestions: [
          'Verify your API key has Gemini API access enabled',
          'Check Google Cloud Console for API restrictions',
          'Ensure billing is enabled for your Google Cloud project',
        ],
        technicalDetails: message,
        retryable: false,
        originalError: error,
      };
    }

    if (message.includes('404')) {
      return {
        category: ErrorCategory.API_ERROR,
        severity: ErrorSeverity.ERROR,
        title: 'API Endpoint Not Found',
        message: 'The requested Gemini API endpoint was not found.',
        suggestions: [
          'This may indicate an API version mismatch',
          'Check for Arduino IDE updates',
          'Report this issue to Arduino IDE developers',
        ],
        technicalDetails: message,
        retryable: false,
        originalError: error,
      };
    }

    if (
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503')
    ) {
      return {
        category: ErrorCategory.API_ERROR,
        severity: ErrorSeverity.ERROR,
        title: 'Gemini API Server Error',
        message:
          'The Gemini API is experiencing issues. This is not your fault.',
        suggestions: [
          'Wait a few minutes and try again',
          'Check Google API status at https://status.cloud.google.com',
          'The issue should resolve automatically',
        ],
        technicalDetails: message,
        retryable: true,
        originalError: error,
      };
    }

    // Generic API error
    return {
      category: ErrorCategory.API_ERROR,
      severity: ErrorSeverity.ERROR,
      title: 'Gemini API Error',
      message: 'The Gemini API returned an error response.',
      suggestions: [
        'Check your internet connection',
        'Verify your API key is valid',
        'Try again in a moment',
      ],
      technicalDetails: message,
      retryable: true,
      originalError: error,
    };
  }

  private static handleValidationError(
    message: string,
    error: unknown
  ): SpectreErrorResponse {
    return {
      category: ErrorCategory.VALIDATION_ERROR,
      severity: ErrorSeverity.WARNING,
      title: 'Invalid Input',
      message: 'The provided input is invalid or incomplete.',
      suggestions: [
        'Check that all required fields are filled',
        'Verify the input format matches requirements',
        'See the error details for specific issues',
      ],
      technicalDetails: message,
      retryable: false,
      originalError: error,
    };
  }

  private static handleConfigurationError(
    message: string,
    error: unknown
  ): SpectreErrorResponse {
    return {
      category: ErrorCategory.CONFIGURATION_ERROR,
      severity: ErrorSeverity.ERROR,
      title: 'Configuration Error',
      message: 'Spectre AI is not properly configured.',
      suggestions: [
        'Open Arduino IDE Preferences (File → Preferences)',
        'Navigate to Arduino → Spectre AI',
        'Ensure your Google Gemini API key is set',
        'Check that all settings are valid',
      ],
      technicalDetails: message,
      retryable: false,
      originalError: error,
    };
  }

  private static handleFileSystemError(
    message: string,
    error: unknown
  ): SpectreErrorResponse {
    if (message.includes('enoent') || message.includes('not found')) {
      return {
        category: ErrorCategory.FILE_SYSTEM_ERROR,
        severity: ErrorSeverity.ERROR,
        title: 'File Not Found',
        message: 'The requested file or directory does not exist.',
        suggestions: [
          'Verify the file path is correct',
          "Ensure the file hasn't been deleted or moved",
          'Check that the sketch is open in the editor',
        ],
        technicalDetails: message,
        retryable: false,
        originalError: error,
      };
    }

    if (message.includes('eacces') || message.includes('permission')) {
      return {
        category: ErrorCategory.FILE_SYSTEM_ERROR,
        severity: ErrorSeverity.ERROR,
        title: 'Permission Denied',
        message: "Arduino IDE doesn't have permission to access this file.",
        suggestions: [
          'Check file permissions',
          'Ensure the file is not open in another program',
          'Try running Arduino IDE with appropriate permissions',
        ],
        technicalDetails: message,
        retryable: false,
        originalError: error,
      };
    }

    return {
      category: ErrorCategory.FILE_SYSTEM_ERROR,
      severity: ErrorSeverity.ERROR,
      title: 'File System Error',
      message: 'An error occurred while accessing the file system.',
      suggestions: [
        'Check that the file or directory exists',
        'Verify you have the necessary permissions',
        'Ensure the disk is not full or read-only',
      ],
      technicalDetails: message,
      retryable: false,
      originalError: error,
    };
  }

  private static handleArduinoError(
    message: string,
    error: unknown
  ): SpectreErrorResponse {
    if (message.includes('board')) {
      return {
        category: ErrorCategory.ARDUINO_ERROR,
        severity: ErrorSeverity.WARNING,
        title: 'Board Configuration Issue',
        message: "There's an issue with the selected Arduino board.",
        suggestions: [
          'Select a valid board from Tools → Board menu',
          'Install the required board package if missing',
          'Verify the board is supported by Arduino CLI',
        ],
        technicalDetails: message,
        retryable: true,
        originalError: error,
      };
    }

    if (message.includes('port')) {
      return {
        category: ErrorCategory.ARDUINO_ERROR,
        severity: ErrorSeverity.WARNING,
        title: 'Port Configuration Issue',
        message: "There's an issue with the selected serial port.",
        suggestions: [
          'Connect your Arduino board via USB',
          'Select the correct port from Tools → Port menu',
          'Check that the board is recognized by your system',
        ],
        technicalDetails: message,
        retryable: true,
        originalError: error,
      };
    }

    if (message.includes('compile')) {
      return {
        category: ErrorCategory.ARDUINO_ERROR,
        severity: ErrorSeverity.ERROR,
        title: 'Compilation Failed',
        message: 'The sketch failed to compile.',
        suggestions: [
          'Check the Output panel for detailed error messages',
          'Fix any syntax errors in your code',
          'Ensure all required libraries are installed',
        ],
        technicalDetails: message,
        retryable: true,
        originalError: error,
      };
    }

    if (message.includes('upload')) {
      return {
        category: ErrorCategory.ARDUINO_ERROR,
        severity: ErrorSeverity.ERROR,
        title: 'Upload Failed',
        message: 'Failed to upload the sketch to the Arduino board.',
        suggestions: [
          'Ensure the board is connected and the correct port is selected',
          'Check that no other program is using the serial port',
          'Try pressing the reset button on the board',
          'Verify the board is not faulty',
        ],
        technicalDetails: message,
        retryable: true,
        originalError: error,
      };
    }

    return {
      category: ErrorCategory.ARDUINO_ERROR,
      severity: ErrorSeverity.ERROR,
      title: 'Arduino Operation Failed',
      message: 'An Arduino-related operation failed.',
      suggestions: [
        'Check the Arduino IDE status bar for details',
        'Verify your board and port selections',
        'Consult the Output panel for more information',
      ],
      technicalDetails: message,
      retryable: true,
      originalError: error,
    };
  }

  private static handleUnknownError(
    message: string,
    error: unknown,
    context?: string
  ): SpectreErrorResponse {
    return {
      category: ErrorCategory.UNKNOWN_ERROR,
      severity: ErrorSeverity.ERROR,
      title: 'Unexpected Error',
      message: context
        ? `An unexpected error occurred during ${context}.`
        : 'An unexpected error occurred.',
      suggestions: [
        'Try the operation again',
        'Check the Arduino IDE console for details (Help → Toggle Developer Tools)',
        'Report this issue if it persists',
      ],
      technicalDetails: message,
      retryable: true,
      originalError: error,
    };
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Format error response as user-friendly markdown message.
   * Suitable for display in chat widget.
   */
  static formatAsMarkdown(errorResponse: SpectreErrorResponse): string {
    const { title, message, suggestions, technicalDetails, retryable } =
      errorResponse;

    let markdown = `### ❌ ${title}\n\n${message}\n`;

    if (suggestions.length > 0) {
      markdown += '\n**What you can do:**\n';
      suggestions.forEach((suggestion) => {
        markdown += `- ${suggestion}\n`;
      });
    }

    if (retryable) {
      markdown += '\n💡 *You can try again once the issue is resolved.*';
    }

    if (technicalDetails) {
      markdown += `\n\n<details><summary>Technical Details</summary>\n\n\`\`\`\n${technicalDetails}\n\`\`\`\n\n</details>`;
    }

    return markdown;
  }

  /**
   * Format error response as plain text message.
   * Suitable for console logging or simple displays.
   */
  static formatAsPlainText(errorResponse: SpectreErrorResponse): string {
    const { title, message, suggestions } = errorResponse;

    let text = `❌ ${title}\n\n${message}\n`;

    if (suggestions.length > 0) {
      text += '\nWhat you can do:\n';
      suggestions.forEach((suggestion, index) => {
        text += `${index + 1}. ${suggestion}\n`;
      });
    }

    return text;
  }

  /**
   * Check if error should trigger retry logic.
   */
  static shouldRetry(errorResponse: SpectreErrorResponse): boolean {
    return errorResponse.retryable;
  }

  /**
   * Get severity-appropriate emoji for display.
   */
  static getSeverityEmoji(severity: ErrorSeverity): string {
    switch (severity) {
      case ErrorSeverity.ERROR:
        return '❌';
      case ErrorSeverity.WARNING:
        return '⚠️';
      case ErrorSeverity.INFO:
        return 'ℹ️';
      default:
        return '❌';
    }
  }
}
