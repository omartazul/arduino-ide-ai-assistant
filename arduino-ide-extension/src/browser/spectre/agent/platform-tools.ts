/**
 * Agent-mode platform (board package) install/uninstall/search helpers.
 *
 * @author Tazul Islam
 */

import { spectreError } from '../../../common/protocol/spectre-types';
import { BoardHelper } from '../board/board-helpers';
import { ValidationHelper } from '../utils/validation-helper';

export interface PlatformToolsContext {
  boardsService: {
    search(params: { query: string }): Promise<any[]>;
    install(params: { item: any; version: string; skipPostInstall: boolean }): Promise<void>;
    uninstall(params: { item: any }): Promise<void>;
  };
  outputChannels: { getChannel(id: string): { appendLine(line: string): void } };
}

interface PlatformInstallParams {
  platform: any;
  versionToInstall: string;
}

interface PlatformValidationParams {
  platformId: string;
  operation: 'installation' | 'uninstallation';
}

interface PlatformResolveParams {
  platformId: string;
  version?: string;
}

export async function agentInstallBoard(
  ctx: PlatformToolsContext,
  platformId: string,
  version?: string
): Promise<string> {
  const validation = validatePlatformId({ platformId, operation: 'installation' });
  if (validation) {
    return validation;
  }

  try {
    const platform = await resolvePlatformForInstall(ctx, { platformId, version });
    if (typeof platform === 'string') {
      return platform;
    }

    return await installPlatform(ctx, {
      platform: platform.item,
      versionToInstall: platform.version,
    });
  } catch (error) {
    spectreError(`❌ Failed to install platform "${platformId}":`, error);
    return ValidationHelper.formatInstallationError(platformId, error);
  }
}

export async function agentSearchBoards(
  ctx: Pick<PlatformToolsContext, 'boardsService'>,
  query: string
): Promise<string> {
  if (!query || !query.trim()) {
    return '❌ Search query is required';
  }

  try {
    const searchResults = await ctx.boardsService.search({ query });

    if (!searchResults || searchResults.length === 0) {
      return `❌ No board platforms found for "${query}"\n\n💡 Try:\n• Different search terms (manufacturer name, board name, etc.)\n• Adding the board manager URL first if it's a 3rd-party board`;
    }

    const platformsList = searchResults
      .slice(0, 10)
      .map((pkg, index) => {
        const installed = pkg.installedVersion ? ` ✅ v${pkg.installedVersion}` : '';
        const latest = pkg.availableVersions?.[0] ? ` (latest: v${pkg.availableVersions[0]})` : '';
        return `${index + 1}. **${pkg.name}** → Platform ID: **${pkg.id}**${installed}${latest}`;
      })
      .join('\n');

    const primaryPlatform = searchResults[0];
    const primaryId = primaryPlatform.id;

    return `📋 Found ${searchResults.length} platform(s) for "${query}":\n\n${platformsList}\n\n💡 **NEXT STEP:** Use this EXACT command to install:\n<action type="install_board" platform="${primaryId}" />`;
  } catch (error) {
    spectreError('❌ Board search error:', error);
    return `❌ Failed to search for boards: ${error}`;
  }
}

export async function agentUninstallBoard(
  ctx: PlatformToolsContext,
  platformId: string
): Promise<string> {
  const validation = validatePlatformId({ platformId, operation: 'uninstallation' });
  if (validation) {
    return validation;
  }

  try {
    const platform = await findPlatformForUninstall(ctx, platformId);
    if (typeof platform === 'string') {
      return platform;
    }

    return await uninstallPlatform(ctx, platform);
  } catch (error) {
    spectreError(`❌ Failed to uninstall platform "${platformId}":`, error);
    return ValidationHelper.formatUninstallError(platformId, error);
  }
}

function validatePlatformId(params: PlatformValidationParams): string | null {
  return BoardHelper.validatePlatformId(params.platformId, params.operation);
}

async function resolvePlatformForInstall(
  ctx: Pick<PlatformToolsContext, 'boardsService'>,
  params: PlatformResolveParams
): Promise<{ item: any; version: string } | string> {
  const { platformId, version } = params;

  const findResult = await findPlatformById(ctx, platformId);
  if ('error' in findResult) {
    return findResult.error;
  }

  const { platform } = findResult;
  const installCheck = checkPlatformInstallation(platform, version);
  if (!installCheck.shouldInstall) {
    return installCheck.message!;
  }

  const versionToInstall = version || platform.availableVersions[0];
  if (!versionToInstall) {
    return `❌ No versions available for platform "${platformId}"`;
  }

  return { item: platform, version: versionToInstall };
}

async function findPlatformById(
  ctx: Pick<PlatformToolsContext, 'boardsService'>,
  platformId: string
): Promise<{ platform: any; searchResults: any[] } | { error: string }> {
  const searchResults = await ctx.boardsService.search({ query: platformId });

  if (!searchResults || searchResults.length === 0) {
    return {
      error:
        `❌ Board platform "${platformId}" not found in Board Manager\n\n💡 Common fixes:\n• Run the ADD_BOARD_URL action first to add the board manager URL\n• Wait a moment for the package index to download\n• Check platform ID spelling (case-sensitive, usually format: "vendor:arch")\n• Verify the board manager URL is correct\n\nTry asking: "Add the board manager URL for [board name]"`,
    };
  }

  const { exactMap, caseInsensitiveMap } = BoardHelper.buildPlatformLookupMaps(searchResults);

  if (exactMap.size === 0) {
    return {
      error: `❌ Platform search returned invalid data for "${platformId}"\n\n💡 This is an internal error. Please try searching manually in Board Manager.`,
    };
  }

  const platform = BoardHelper.findMatchingPlatform(platformId, searchResults, exactMap, caseInsensitiveMap);
  if (!platform) {
    return { error: BoardHelper.formatPlatformSearchError(platformId, searchResults) };
  }

  return { platform, searchResults };
}

function checkPlatformInstallation(
  platform: any,
  requestedVersion?: string
): { shouldInstall: boolean; message?: string } {
  if (!platform.installedVersion) {
    return { shouldInstall: true };
  }

  const installedVersion = platform.installedVersion;
  if (requestedVersion && installedVersion !== requestedVersion) {
    return {
      shouldInstall: false,
      message: `ℹ️ Platform "${platform.name}" is already installed with version ${installedVersion}\n\n💡 To install version ${requestedVersion}, uninstall the current version first from Board Manager`,
    };
  }

  return {
    shouldInstall: false,
    message: `✅ Platform "${platform.name}" already installed (version ${installedVersion})`,
  };
}

async function installPlatform(
  ctx: PlatformToolsContext,
  params: PlatformInstallParams
): Promise<string> {
  const { platform, versionToInstall } = params;

  await ctx.boardsService.install({
    item: platform,
    version: versionToInstall,
    skipPostInstall: false,
  });

  ctx.outputChannels.getChannel('Arduino').appendLine(`Installed ${platform.name}@${versionToInstall}`);

  return `✅ Platform "${platform.name}" version ${versionToInstall} installed successfully`;
}

async function findPlatformForUninstall(
  ctx: Pick<PlatformToolsContext, 'boardsService'>,
  platformId: string
): Promise<any | string> {
  const searchResults = await ctx.boardsService.search({ query: platformId });

  if (!searchResults || searchResults.length === 0) {
    return `❌ Board platform "${platformId}" not found in Board Manager\n\n💡 Check platform ID spelling (case-sensitive)`;
  }

  const { exactMap, caseInsensitiveMap } = BoardHelper.buildPlatformLookupMaps(searchResults);

  if (exactMap.size === 0) {
    return `❌ Platform search returned invalid data for "${platformId}"\n\n💡 This is an internal error. Please try searching manually in Board Manager.`;
  }

  const platform = BoardHelper.findMatchingPlatform(platformId, searchResults, exactMap, caseInsensitiveMap);
  if (!platform) {
    return BoardHelper.formatPlatformSearchError(platformId, searchResults);
  }

  if (!platform.installedVersion) {
    return `ℹ️ Platform "${platform.name}" is not installed\n\n💡 Nothing to uninstall`;
  }

  return platform;
}

async function uninstallPlatform(ctx: PlatformToolsContext, platform: any): Promise<string> {
  const installedVersion = platform.installedVersion;

  await ctx.boardsService.uninstall({ item: platform });

  ctx.outputChannels.getChannel('Arduino').appendLine(`Uninstalled ${platform.name}@${installedVersion}`);

  return `✅ Platform "${platform.name}" version ${installedVersion} uninstalled successfully`;
}
