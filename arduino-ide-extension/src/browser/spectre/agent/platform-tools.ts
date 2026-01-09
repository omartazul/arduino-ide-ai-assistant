/**
 * Agent-mode platform (board package) install/uninstall/search helpers.
 *
 * @author Tazul Islam
 */

import { BoardsPackage } from '../../../common/protocol/boards-service';
import { BoardHelper } from '../board/board-helpers';
import { ValidationHelper } from '../utils/validation-helper';
import { executeAgentAction } from './agent-utils';

export interface PlatformToolsContext {
  boardsService: {
    search(params: { query: string }): Promise<BoardsPackage[]>;
    install(params: {
      item: BoardsPackage;
      version: string;
      skipPostInstall: boolean;
    }): Promise<void>;
    uninstall(params: { item: BoardsPackage }): Promise<void>;
  };
  outputChannels: {
    getChannel(id: string): { appendLine(line: string): void };
  };
}

interface PlatformInstallParams {
  platform: BoardsPackage;
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

async function executePlatformAction(
  platformId: string,
  operation: 'installation' | 'uninstallation',
  config: {
    logPrefix: string;
    actionDesc: string;
    errorHandler: (err: unknown) => string;
  },
  action: () => Promise<string>
): Promise<string> {
  const validation = validatePlatformId({
    platformId,
    operation,
  });
  if (validation) {
    return validation;
  }

  return executeAgentAction(config, action);
}

export async function agentInstallBoard(
  ctx: PlatformToolsContext,
  platformId: string,
  version?: string
): Promise<string> {
  return executePlatformAction(
    platformId,
    'installation',
    {
      logPrefix: `Platform "${platformId}" installation`,
      actionDesc: 'install board',
      errorHandler: (err) =>
        ValidationHelper.formatInstallationError(platformId, err),
    },
    async () => {
      const platform = await resolvePlatformForInstall(ctx, {
        platformId,
        version,
      });
      if (typeof platform === 'string') {
        return platform;
      }

      return await installPlatform(ctx, {
        platform: platform.item,
        versionToInstall: platform.version,
      });
    }
  );
}

export async function agentSearchBoards(
  ctx: Pick<PlatformToolsContext, 'boardsService'>,
  query: string
): Promise<string> {
  if (!query || !query.trim()) {
    return '❌ Search query is required';
  }

  return executeAgentAction(
    {
      logPrefix: 'Board search',
      actionDesc: 'search for boards',
    },
    async () => {
      const searchResults = await ctx.boardsService.search({ query });

      if (!searchResults || searchResults.length === 0) {
        return `❌ No board platforms found for "${query}"\n\n💡 Try:\n• Different search terms (manufacturer name, board name, etc.)\n• Adding the board manager URL first if it's a 3rd-party board`;
      }

      const platformsList = searchResults
        .slice(0, 10)
        .map((pkg, index) => {
          const installed = pkg.installedVersion
            ? ` ✅ v${pkg.installedVersion}`
            : '';
          const latest = pkg.availableVersions?.[0]
            ? ` (latest: v${pkg.availableVersions[0]})`
            : '';
          return `${index + 1}. **${pkg.name}** → Platform ID: **${
            pkg.id
          }**${installed}${latest}`;
        })
        .join('\n');

      const primaryPlatform = searchResults[0];
      const primaryId = primaryPlatform.id;

      return `📋 Found ${searchResults.length} platform(s) for "${query}":\n\n${platformsList}\n\n💡 **NEXT STEP:** Use this EXACT command to install:\n<action type="install_board" platform="${primaryId}" />`;
    }
  );
}

export async function agentUninstallBoard(
  ctx: PlatformToolsContext,
  platformId: string
): Promise<string> {
  return executePlatformAction(
    platformId,
    'uninstallation',
    {
      logPrefix: `Failed to uninstall platform "${platformId}"`,
      actionDesc: 'uninstall board',
      errorHandler: (err) =>
        ValidationHelper.formatUninstallError(platformId, err),
    },
    async () => {
      const platform = await findPlatformForUninstall(ctx, platformId);
      if (typeof platform === 'string') {
        return platform;
      }

      return await uninstallPlatform(ctx, platform);
    }
  );
}

function validatePlatformId(params: PlatformValidationParams): string | null {
  return BoardHelper.validatePlatformId(params.platformId, params.operation);
}

async function resolvePlatformForInstall(
  ctx: Pick<PlatformToolsContext, 'boardsService'>,
  params: PlatformResolveParams
): Promise<{ item: BoardsPackage; version: string } | string> {
  const { platformId, version } = params;

  const findResult = await findPlatformById(ctx, platformId);
  if ('error' in findResult) {
    return findResult.error;
  }

  const { platform } = findResult;
  const installCheck = checkPlatformInstallation(platform, version);
  if (!installCheck.shouldInstall) {
    return installCheck.message || 'Platform already installed';
  }

  const versionToInstall =
    version || (platform.availableVersions && platform.availableVersions[0]);
  if (!versionToInstall) {
    return `❌ No versions available for platform "${platformId}"`;
  }

  return { item: platform, version: versionToInstall };
}

async function findPlatformById(
  ctx: Pick<PlatformToolsContext, 'boardsService'>,
  platformId: string
): Promise<
  | { platform: BoardsPackage; searchResults: BoardsPackage[] }
  | { error: string }
> {
  const searchResults = await ctx.boardsService.search({ query: platformId });

  if (!searchResults || searchResults.length === 0) {
    return {
      error: `❌ Board platform "${platformId}" not found in Board Manager\n\n💡 Common fixes:\n• Run the ADD_BOARD_URL action first to add the board manager URL\n• Wait a moment for the package index to download\n• Check platform ID spelling (case-sensitive, usually format: "vendor:arch")\n• Verify the board manager URL is correct\n\nTry asking: "Add the board manager URL for [board name]"`,
    };
  }

  const { exactMap, caseInsensitiveMap } =
    BoardHelper.buildPlatformLookupMaps(searchResults);

  if (exactMap.size === 0) {
    return {
      error: `❌ Platform search returned invalid data for "${platformId}"\n\n💡 This is an internal error. Please try searching manually in Board Manager.`,
    };
  }

  const platform = BoardHelper.findMatchingPlatform(
    platformId,
    searchResults,
    exactMap,
    caseInsensitiveMap
  ) as BoardsPackage | undefined;

  if (!platform) {
    return {
      error: BoardHelper.formatPlatformSearchError(platformId, searchResults),
    };
  }

  return { platform, searchResults };
}

function checkPlatformInstallation(
  platform: BoardsPackage,
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

  ctx.outputChannels
    .getChannel('Arduino')
    .appendLine(`Installed ${platform.name}@${versionToInstall}`);

  return `✅ Platform "${platform.name}" version ${versionToInstall} installed successfully`;
}

async function findPlatformForUninstall(
  ctx: Pick<PlatformToolsContext, 'boardsService'>,
  platformId: string
): Promise<BoardsPackage | string> {
  const result = await findPlatformById(ctx, platformId);

  if ('error' in result) {
    return result.error;
  }

  const { platform } = result;

  if (!platform.installedVersion) {
    return `ℹ️ Platform "${platform.name}" is not installed\n\n💡 Nothing to uninstall`;
  }

  return platform;
}

async function uninstallPlatform(
  ctx: PlatformToolsContext,
  platform: BoardsPackage
): Promise<string> {
  const installedVersion = platform.installedVersion || 'unknown';

  await ctx.boardsService.uninstall({ item: platform });

  ctx.outputChannels
    .getChannel('Arduino')
    .appendLine(`Uninstalled ${platform.name}@${installedVersion}`);

  return `✅ Platform "${platform.name}" version ${installedVersion} uninstalled successfully`;
}
