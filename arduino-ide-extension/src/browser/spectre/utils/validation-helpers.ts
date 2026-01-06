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
}
