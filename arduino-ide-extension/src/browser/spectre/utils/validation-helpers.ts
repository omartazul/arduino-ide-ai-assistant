/**
 * Helper utilities for validation and formatting operations.
 * Consolidates common validation logic and message formatting.
 *
 * @author Tazul Islam
 */

/**
 * Validation result for board and port operations.
 */
export interface ValidationResult {
  valid: boolean;
  message?: string;
  board?: any;
  port?: any;
}

/**
 * Helper class for validation and formatting operations.
 */
export class ValidationHelper {
  /**
   * Validates board and port configuration.
   */
  static validateBoardAndPort(
    boardsService: any,
    requirePort = false
  ): ValidationResult {
    const selectedBoard = boardsService.getSelectedBoard();
    const selectedPort = boardsService.getSelectedPort();

    if (!selectedBoard) {
      return {
        valid: false,
        message: '❌ No board selected. Use <action type="select_board" name="..."/> first',
      };
    }

    if (requirePort && !selectedPort) {
      return {
        valid: false,
        message: '❌ No port selected. Use <action type="select_port" port="..."/> first',
      };
    }

    return {
      valid: true,
      board: selectedBoard,
      port: selectedPort,
    };
  }

  /**
   * Validates platform ID format.
   */
  static validatePlatformId(
    platformId: string,
    operation: 'installation' | 'uninstallation' = 'installation'
  ): string | null {
    if (!platformId || typeof platformId !== 'string' || !platformId.trim()) {
      return `❌ Invalid platform ID for ${operation}. Expected format: "vendor:arch" (e.g., "arduino:avr")`;
    }

    const trimmedId = platformId.trim();
    if (!/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(trimmedId)) {
      return `❌ Invalid platform ID format: "${trimmedId}". Expected format: "vendor:arch" (e.g., "arduino:avr")`;
    }

    return null;
  }

  /**
   * Validates uninstall request.
   */
  static validateUninstallRequest(platformId: string): string | null {
    const validationError = ValidationHelper.validatePlatformId(platformId, 'uninstallation');
    if (validationError) {
      return validationError;
    }
    return null;
  }

  /**
   * Formats library installation error.
   */
  static formatLibraryInstallError(libraryName: string, error: any): string {
    const errorMessage = String(error?.message || error || 'Unknown error');

    if (errorMessage.includes('already installed')) {
      return `ℹ️ Library "${libraryName}" is already installed`;
    }

    if (errorMessage.toLowerCase().includes('not found')) {
      return `❌ Library "${libraryName}" not found in Arduino Library Manager

💡 Try searching with a different name or check https://www.arduino.cc/reference/en/libraries/`;
    }

    return `❌ Failed to install library "${libraryName}": ${errorMessage}`;
  }

  /**
   * Formats installation error message.
   */
  static formatInstallationError(platformId: string, error: any): string {
    const errorMessage = String(error?.message || error || 'Unknown error');

    if (errorMessage.includes('already installed')) {
      return `ℹ️ Platform "${platformId}" is already installed`;
    }

    if (errorMessage.toLowerCase().includes('not found')) {
      return `❌ Platform "${platformId}" not found

💡 Make sure you've added the correct board manager URL first`;
    }

    return `❌ Failed to install platform "${platformId}": ${errorMessage}`;
  }

  /**
   * Formats uninstallation error message.
   */
  static formatUninstallError(platformId: string, error: unknown): string {
    const errorMessage = String(
      (error as any)?.message || error || 'Unknown error'
    );

    if (errorMessage.toLowerCase().includes('not installed')) {
      return `ℹ️ Platform "${platformId}" is not installed`;
    }

    return `❌ Failed to uninstall platform "${platformId}": ${errorMessage}

💡 Check if the platform is installed and try again`;
  }

  /**
   * Formats upload error message.
   */
  static formatUploadError(errText: string): Error {
    const errLower = errText.toLowerCase();

    if (errLower.includes('not in sync')) {
      return new Error(
        `Upload failed - board not responding. Try:\n1. Reset the board\n2. Try a different USB cable\n3. Select a different port\n\nError: ${errText}`
      );
    }

    if (errLower.includes('permission denied') || errLower.includes('access')) {
      return new Error(
        `Permission denied - port may be in use. Try:\n1. Close Serial Monitor\n2. Disconnect other programs\n3. Try a different port\n\nError: ${errText}`
      );
    }

    return new Error(`Upload failed:\n${errText}`);
  }
}
