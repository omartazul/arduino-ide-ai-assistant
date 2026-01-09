/**
 * Agent-mode library install/uninstall/search helpers.
 *
 * @author Tazul Islam
 */

import { ValidationHelper } from '../utils/validation-helper';
import { executeAgentAction } from './agent-utils';

export interface LibraryToolsContext {
  libraryService: {
    search(params: { query: string }): Promise<any[]>;
    install(params: { item: any; noDeps: boolean }): Promise<void>;
    uninstall(params: { item: any }): Promise<void>;
  };
  outputChannels: {
    getChannel(id: string): { appendLine(line: string): void };
  };
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
  type:
    | 'notFound'
    | 'noVersions'
    | 'alreadyInstalled'
    | 'notInstalled'
    | 'installSuccess'
    | 'uninstallSuccess';
}

export async function agentInstallLibrary(
  ctx: LibraryToolsContext,
  libraryName: string
): Promise<string> {
  return agentManageLibrary(ctx, libraryName, 'install');
}

export async function agentUninstallLibrary(
  ctx: LibraryToolsContext,
  libraryName: string
): Promise<string> {
  return agentManageLibrary(ctx, libraryName, 'uninstall');
}

async function agentManageLibrary(
  ctx: LibraryToolsContext,
  libraryName: string,
  operation: 'install' | 'uninstall'
): Promise<string> {
  const isInstall = operation === 'install';
  return executeAgentAction(
    {
      logPrefix: `Library "${libraryName}" ${operation}ation`,
      actionDesc: `${operation} library`,
      errorHandler: (err) =>
        isInstall
          ? ValidationHelper.formatLibraryInstallError(libraryName, err)
          : formatLibraryUninstallError(libraryName, err),
    },
    async () => {
      const validationError = validateLibraryName({
        name: libraryName,
        operation: operation,
      });
      if (validationError) return validationError;

      const searchResults = await ctx.libraryService.search({
        query: libraryName,
      });
      const result = processSearchResults({
        name: libraryName,
        searchResults,
      });

      if (!result.success) return result.error;
      const libraryPackage = result.package;

      if (isInstall) {
        if (libraryPackage.installedVersion) {
          return formatLibraryMessage({
            name: libraryPackage.name,
            version: libraryPackage.installedVersion,
            type: 'alreadyInstalled',
          });
        }

        const versionToInstall = libraryPackage.availableVersions?.[0];
        if (!versionToInstall) {
          return formatLibraryMessage({
            name: libraryPackage.name,
            type: 'noVersions',
          });
        }

        await ctx.libraryService.install({
          item: libraryPackage,
          noDeps: false,
        });

        return formatLibraryMessage({
          name: libraryPackage.name,
          type: 'installSuccess',
        });
      } else {
        if (!libraryPackage.installedVersion) {
          return formatLibraryMessage({
            name: libraryPackage.name,
            type: 'notInstalled',
          });
        }

        await ctx.libraryService.uninstall({ item: libraryPackage });

        ctx.outputChannels
          .getChannel('Arduino')
          .appendLine(
            `Uninstalled ${libraryPackage.name}@${libraryPackage.installedVersion}`
          );

        return formatLibraryMessage({
          name: libraryPackage.name,
          type: 'uninstallSuccess',
        });
      }
    }
  );
}

function formatLibraryUninstallError(libraryName: string, error: any): string {
  const errorMsg = error?.message || String(error);

  if (
    errorMsg.toLowerCase().includes('not found') ||
    errorMsg.toLowerCase().includes('not installed')
  ) {
    return `❌ Library "${libraryName}" is not installed or could not be found`;
  }

  return `❌ Failed to uninstall library "${libraryName}"\n\nError: ${errorMsg}`;
}

// ============================================================================
// Library Helpers (Internal)
// ============================================================================

function validateLibraryName(params: LibraryValidationParams): string | null {
  if (!params.name || params.name.trim().length === 0) {
    return `❌ Cannot ${params.operation} library: library name is empty`;
  }
  return null;
}

function buildLibraryMap(searchResults: any[]): Map<string, any> {
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

function findLibraryInResults(
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

function processSearchResults(
  params: LibrarySearchParams
): LibrarySearchResult {
  const { name, searchResults } = params;

  if (!searchResults || searchResults.length === 0) {
    return {
      success: false,
      error: `❌ Library "${name}" not found in Arduino Library Manager\n\n💡 Common fixes:\n• Check spelling (library names are case-sensitive)\n• Try searching: https://www.arduino.cc/reference/en/libraries/\n• Some libraries have different names (e.g., "Servo" not "ServoLibrary")`,
    };
  }

  const libraryMap = buildLibraryMap(searchResults);

  if (libraryMap.size === 0) {
    return {
      success: false,
      error: `❌ Library search returned invalid data for "${name}"\n\n💡 This is an internal error. Please try again or search manually in Library Manager.`,
    };
  }

  const libraryPackage = findLibraryInResults(name, libraryMap);

  if (!libraryPackage) {
    return {
      success: false,
      error: `❌ Library "${name}" could not be resolved from search results\n\n💡 Please try searching manually in Library Manager.`,
    };
  }

  return { success: true, package: libraryPackage };
}

function formatLibraryMessage(params: LibraryMessageParams): string {
  const { name, version, type } = params;

  switch (type) {
    case 'notFound':
      return `❌ Library "${name}" not found in library index`;
    case 'noVersions':
      return `❌ No versions available for library "${name}"`;
    case 'alreadyInstalled':
      return `✅ Library "${name}" is already installed (version ${
        version || 'unknown'
      })`;
    case 'notInstalled':
      return `⚠️ Library "${name}" is not currently installed`;
    case 'installSuccess':
      return `✅ Library "${name}" installed successfully`;
    case 'uninstallSuccess':
      return `✅ Library "${name}" uninstalled successfully`;
  }
}
