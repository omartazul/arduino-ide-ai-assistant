/**
 * Helper utilities for Agent Mode operations.
 * Extracted from SpectreWidget to reduce file complexity.
 *
 * @author Tazul Islam
 */

/**
 * Result type for library operations.
 * Using discriminated union instead of returning string | object.
 */
type LibrarySearchResult =
  | { success: true; package: any }
  | { success: false; error: string };

/**
 * Parameters for library validation.
 */
interface LibraryValidationParams {
  name: string;
  operation: 'install' | 'uninstall';
}

/**
 * Parameters for library search operations.
 */
interface LibrarySearchParams {
  name: string;
  searchResults: any[];
}

/**
 * Helper class for agent mode library operations.
 * Reduces primitive obsession and string-heavy parameters.
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
      // Only store if not already present (first match wins)
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
      // If no exact match, use the first valid result from Map
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
   * Returns strongly-typed result instead of string | any.
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

    // Find the library
    const libraryPackage = this.findLibraryInResults(name, libraryMap);

    // Handle case where library wasn't found
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
   * Consolidates all message formatting to reduce string-heavy parameters.
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

/**
 * Parameters for formatting library messages.
 */
interface LibraryMessageParams {
  name: string;
  version?: string;
  type: 'notFound' | 'noVersions' | 'alreadyInstalled' | 'notInstalled' | 'installSuccess' | 'uninstallSuccess';
}
