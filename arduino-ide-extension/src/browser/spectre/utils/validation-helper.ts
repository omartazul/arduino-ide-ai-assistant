/**
 * Helper utilities for validation and formatting operations.
 * Consolidates common validation logic and message formatting.
 *
 * @author Tazul Islam
 */

/**
 * Helper class for validation and formatting operations.
 */
export class ValidationHelper {
  /**
   * Formats library installation error.
   */
  static formatLibraryInstallError(
    libraryName: string,
    error: unknown
  ): string {
    const errorMessage =
      error instanceof Error ? error.message : String(error || 'Unknown error');

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
  static formatInstallationError(platformId: string, error: unknown): string {
    const errorMessage =
      error instanceof Error ? error.message : String(error || 'Unknown error');

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
    const errorMessage =
      error instanceof Error ? error.message : String(error || 'Unknown error');

    if (errorMessage.toLowerCase().includes('not installed')) {
      return `ℹ️ Platform "${platformId}" is not installed`;
    }

    return `❌ Failed to uninstall platform "${platformId}": ${errorMessage}

💡 Check if the platform is installed and try again`;
  }

  /**
   * Validates a board manager URL.
   * Checks for protocol, length, credentials, and file extension.
   */
  static validateBoardManagerUrl(rawUrl: string): string | null {
    const trimmed = rawUrl.trim();
    if (trimmed.length > 2048) {
      return '❌ Board manager URL is too long';
    }

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return '❌ Invalid board manager URL (not a valid URL)';
    }

    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'https:' && protocol !== 'http:') {
      return '❌ Board manager URL must be http(s)';
    }

    if (url.username || url.password) {
      return '❌ Board manager URL must not contain credentials';
    }

    if (!url.pathname.toLowerCase().endsWith('.json')) {
      return '❌ Board manager URL must end with .json';
    }

    return null;
  }
}
