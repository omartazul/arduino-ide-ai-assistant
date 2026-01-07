/**
 * Agent-mode board/port selection helpers.
 *
 * @author Tazul Islam
 */

import { spectreError, spectreWarn } from '../../../common/protocol/spectre-types';
import { BoardHelper } from '../board/board-helpers';

export interface BoardToolsTiming {
  BOARD_SELECTION_DELAY: number;
}

export interface BoardToolsContext {
  delay(ms: number): Promise<void>;
  timing: BoardToolsTiming;

  getErrorMessage(error: unknown): string;

  boardsServiceProvider: {
    ready: Promise<void>;
    boardList: any;
    boardsConfig: any;
    detectedPorts: Record<string, any>;
    updateConfig(update: any): any;
  };

  boardsService: {
    getInstalledBoards(): Promise<any[]>;
    searchBoards(params: { query: string }): Promise<any[]>;
    getBoardDetails(params: { fqbn: string }): Promise<any>;
  };

  boardsDataStore: {
    selectConfigOption(params: { fqbn: string; optionsToUpdate: Array<{ option: string; selectedValue: string }> }): Promise<boolean>;
    appendConfigToFqbn(fqbn: string): Promise<string | undefined>;
  };

  getBoardSearchCache(): any;
  setBoardSearchCache(cache: any): void;
}

export async function agentSelectBoard(ctx: BoardToolsContext, input: string): Promise<string> {
  try {
    await ctx.boardsServiceProvider.ready;
    const allBoards = await getInstalledBoards(ctx);
    const matchedBoard = findBoardByName(ctx, input.toLowerCase().trim(), allBoards);

    if (!matchedBoard) {
      return `❌ Board not found: "${input}". Check installed boards in Tools → Board menu.`;
    }

    return await selectAndValidateBoard(ctx, matchedBoard);
  } catch (error: unknown) {
    spectreError('❌ Board selection error:', error);
    return `❌ Failed to select board: ${ctx.getErrorMessage(error)}`;
  }
}

export async function agentSelectPort(ctx: BoardToolsContext, port: string): Promise<string> {
  try {
    const detectedPorts = Object.values(ctx.boardsServiceProvider.detectedPorts);
    const targetPort = detectedPorts.find((dp: any) => dp.port.address === port);

    if (targetPort) {
      ctx.boardsServiceProvider.updateConfig({
        protocol: targetPort.port.protocol,
        address: targetPort.port.address,
      });
      await ctx.delay(ctx.timing.BOARD_SELECTION_DELAY);
      return `✅ Port selected: ${targetPort.port.address} (${targetPort.port.protocolLabel || targetPort.port.protocol})`;
    }

    const availablePorts = detectedPorts.map((dp: any) => dp.port.address).join(', ');
    if (availablePorts) {
      return `❌ Port "${port}" not found. Available ports: ${availablePorts}. Please check your Arduino connection or use one of the available ports.`;
    }

    return `❌ Port "${port}" not found and no development boards detected. Please check your board connection.`;
  } catch (error: unknown) {
    spectreError('❌ Port selection error:', error);
    return `❌ Failed to select port: ${ctx.getErrorMessage(error)}`;
  }
}

export async function agentGetBoardsList(ctx: BoardToolsContext): Promise<string> {
  try {
    const connectedBoardsText = getConnectedBoardsText(ctx);
    const allAvailableBoards = await getAvailableBoardsText(ctx);
    return buildBoardsListMessage(connectedBoardsText, allAvailableBoards);
  } catch (error: unknown) {
    return `❌ Failed to get board list: ${ctx.getErrorMessage(error)}`;
  }
}

export async function agentGetPortsList(ctx: BoardToolsContext): Promise<string> {
  try {
    const detectedPorts = Object.values(ctx.boardsServiceProvider.detectedPorts);
    if (detectedPorts.length === 0) {
      return '❌ No development boards detected. Please check:\n• Board is connected via USB cable\n• Board drivers are installed\n• Cable supports data transfer (not power-only)\n• Board is powered on';
    }

    const portsList = detectedPorts
      .map((dp: any) => {
        const boardInfo = dp.matchingBoards?.length > 0 ? ` (Board: ${dp.matchingBoards[0].name})` : '';
        return `- ${dp.port.address} (${dp.port.protocolLabel || dp.port.protocol})${boardInfo}`;
      })
      .join('\n');

    return `📋 Available ports:\n${portsList}\n\n💡 Use [ACTION:SELECT_PORT:address] to select a port.`;
  } catch (error: unknown) {
    spectreError('❌ Port listing error:', error);
    return `❌ Failed to list ports: ${ctx.getErrorMessage(error)}`;
  }
}

export async function agentGetBoardConfig(ctx: BoardToolsContext, fqbn?: string): Promise<string> {
  try {
    const targetFqbn = await resolveBoardFqbn(ctx, fqbn);
    if (targetFqbn.startsWith('❌')) {
      return targetFqbn;
    }
    return await formatBoardConfig(ctx, targetFqbn);
  } catch (error: unknown) {
    spectreError('❌ Board config error:', error);
    return `❌ Failed to get board configuration: ${ctx.getErrorMessage(error)}`;
  }
}

function getConnectedBoardsText(ctx: BoardToolsContext): string {
  const boardList = ctx.boardsServiceProvider.boardList;
  return boardList.boards
    .filter((board: any) => board.board && board.board.fqbn)
    .map((board: any) => `- ${board.board.name} (FQBN: ${board.board.fqbn}) [Connected]`)
    .join('\n');
}

async function getAvailableBoardsText(ctx: BoardToolsContext): Promise<string[]> {
  try {
    const searchResults = await ctx.boardsService.searchBoards({ query: '' });
    return searchResults
      .filter((board: any) => board.fqbn && board.name)
      .map((board: any) => `- ${board.name} (FQBN: ${board.fqbn})`)
      .slice(0, 20);
  } catch (searchError) {
    spectreWarn('Failed to search boards:', searchError);
    return [];
  }
}

function buildBoardsListMessage(connectedBoardsText: string, allAvailableBoards: string[]): string {
  let result = '📋 **Available Boards:**\n';

  if (connectedBoardsText) {
    result += '\n**🔌 Connected Boards:**\n' + connectedBoardsText + '\n';
  }

  if (allAvailableBoards.length > 0) {
    result += '\n**📚 All Available Boards (from installed platforms):**\n' + allAvailableBoards.join('\n') + '\n';
  }

  if (!connectedBoardsText && allAvailableBoards.length === 0) {
    result +=
      'No boards available. Please:\n1. Connect your development board, or\n2. Install board packages via Boards Manager\n3. Make sure the IDE can detect your hardware';
  }

  result += '\n\n💡 Use [ACTION:SELECT_BOARD:board_name] to select any board by its name from the list above.';
  return result;
}

async function formatBoardConfig(ctx: BoardToolsContext, targetFqbn: string): Promise<string> {
  const boardDetails = await ctx.boardsService.getBoardDetails({ fqbn: targetFqbn });
  if (!boardDetails) {
    return `❌ Could not get board details for ${targetFqbn}. Make sure the board platform is installed.`;
  }

  if (boardDetails.configOptions.length === 0) {
    return `✅ Board "${targetFqbn}" has no configuration options available.`;
  }

  const configList = boardDetails.configOptions
    .map((option: any) => {
      const availableValues = option.values
        .map((v: any) => `${v.value}="${v.label}"${v.selected ? ' (current)' : ''}`)
        .join(', ');
      return `- **${option.option}** (${option.label}): ${availableValues}`;
    })
    .join('\n');

  const boardName = ctx.boardsServiceProvider.boardsConfig.selectedBoard?.name || targetFqbn;
  return `⚙️ **Board Configuration for "${boardName}":**\n\n${configList}\n\n💡 Use [ACTION:SET_BOARD_CONFIG:option=value] to configure options.`;
}

export async function agentSetBoardConfig(
  ctx: BoardToolsContext,
  fqbn: string | undefined,
  options: string
): Promise<string> {
  try {
    const targetFqbn = await resolveBoardFqbn(ctx, fqbn);
    if (targetFqbn.startsWith('❌')) {
      return targetFqbn;
    }

    const optionsToUpdate = BoardHelper.parseConfigOptions(options);
    const updateResult = await applyBoardConfigUpdate(ctx, targetFqbn, optionsToUpdate);

    if (typeof updateResult === 'string') {
      return updateResult;
    }

    const optionsText = optionsToUpdate.map((o) => `${o.option}=${o.selectedValue}`).join(', ');
    return `✅ Board configuration updated: ${optionsText}\n\nFull FQBN: ${updateResult.updatedFqbn || targetFqbn}`;
  } catch (error: unknown) {
    spectreError('❌ Board config update error:', error);
    return `❌ Failed to set board configuration: ${ctx.getErrorMessage(error)}`;
  }
}

async function getInstalledBoards(ctx: BoardToolsContext): Promise<any[]> {
  const installedBoards = await ctx.boardsService.getInstalledBoards();
  return installedBoards.filter((board: any) => board.fqbn && board.name);
}

function findBoardByName(ctx: BoardToolsContext, inputName: string, boards: any[]): any | null {
  const cache = ctx.getBoardSearchCache();
  if (!BoardHelper.isBoardCacheValid(cache)) {
    ctx.setBoardSearchCache(BoardHelper.buildBoardCache(boards));
  }

  const result = BoardHelper.findBoardByName(inputName, ctx.getBoardSearchCache());
  return result.board;
}

async function selectAndValidateBoard(ctx: BoardToolsContext, matchedBoard: any): Promise<string> {
  const currentConfig = ctx.boardsServiceProvider.boardsConfig;
  if (currentConfig?.selectedBoard?.fqbn === matchedBoard.fqbn) {
    return `✅ Board already selected: ${matchedBoard.name} (${matchedBoard.fqbn}). No action needed - board configuration is ready.`;
  }

  ctx.boardsServiceProvider.updateConfig({
    name: matchedBoard.name,
    fqbn: matchedBoard.fqbn,
  });

  await ctx.delay(ctx.timing.BOARD_SELECTION_DELAY);

  const updatedConfig = ctx.boardsServiceProvider.boardsConfig;
  if (updatedConfig?.selectedBoard?.fqbn === matchedBoard.fqbn) {
    return `✅ Board selected: ${matchedBoard.name} (${matchedBoard.fqbn})`;
  }

  spectreWarn('⚠️ Selection validation failed');
  return `⚠️ Board selected but validation failed: ${matchedBoard.name}`;
}

async function resolveBoardFqbn(ctx: BoardToolsContext, fqbn: string | undefined): Promise<string> {
  if (fqbn) {
    return fqbn;
  }

  const currentBoard = ctx.boardsServiceProvider.boardsConfig.selectedBoard;
  if (!currentBoard?.fqbn) {
    return `❌ No board selected. Please select a board first using [ACTION:SELECT_BOARD:board_name].`;
  }

  return currentBoard.fqbn;
}

async function applyBoardConfigUpdate(
  ctx: BoardToolsContext,
  targetFqbn: string,
  optionsToUpdate: Array<{ option: string; selectedValue: string }>
): Promise<{ updatedFqbn: string | undefined } | string> {
  const success = await ctx.boardsDataStore.selectConfigOption({
    fqbn: targetFqbn,
    optionsToUpdate,
  });

  if (!success) {
    return `❌ Failed to update board configuration. Please check that the options exist and values are valid.`;
  }

  const updatedFqbn = await ctx.boardsDataStore.appendConfigToFqbn(targetFqbn);

  if (updatedFqbn) {
    ctx.boardsServiceProvider.updateConfig({
      name: ctx.boardsServiceProvider.boardsConfig.selectedBoard?.name || 'Platform Board',
      fqbn: updatedFqbn,
    });
  }

  return { updatedFqbn };
}
