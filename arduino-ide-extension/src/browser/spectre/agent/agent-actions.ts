/**
 * Spectre agent action implementations (sketch, board, platform, upload, etc.).
 *
 * @author Tazul Islam
 */

import { spectreError, spectreWarn, SKETCH_CONSTANTS, type ValidationResult } from '../../../common/protocol/spectre-types';
import { CurrentSketch } from '../../sketches-service-client-impl';
import * as SketchOperations from './sketch-operations';
import * as UploadTools from './upload-tools';
import * as AgentTools from './agent-tools';
import * as PlatformTools from './platform-tools';
import * as BoardTools from './board-tools';
import * as UiUtilities from '../ui/ui-utilities';
import { UploadHelper } from '../feature/upload-helper';

export interface AgentActionsTiming {
  AGENT_ERROR_DELAY: number;
  SKETCH_SAVE_DELAY: number;
  SERVICE_READY_WAIT: number;
  PORT_SELECTION_DELAY: number;
  DECORATION_AUTO_REMOVE: number;
  COMPILATION_TIMEOUT: number;
  UPLOAD_PREPARATION_DELAY: number;
  UPLOAD_START_DELAY: number;
  COMPILATION_CHECK_DELAY: number;
  UPLOAD_PROCESS_DELAY: number;
  BOARD_SELECTION_DELAY: number;
  PACKAGE_INDEX_POLL_INTERVAL: number;
}

export interface AgentActionsDeps {
  sketchesClient: any;
  commands: any;
  editorManager: any;
  outputChannels: any;
  boardsServiceProvider: any;
  boardsService: any;
  boardsDataStore: any;
  monitorManagerProxy: any;
  libraryService: any;
  configService: any;
  decorationTimers: any;

  getErrorMessage: (error: unknown) => string;
  getBoardSearchCache: () => any;
  setBoardSearchCache: (cache: any) => void;

  timing: AgentActionsTiming;
}

export function createAgentActions(deps: AgentActionsDeps): {
  agentCreateSketch: (name?: string, code?: string) => Promise<string>;
  agentReadSketch: () => Promise<string>;
  agentVerifySketch: () => Promise<string>;
  agentUploadSketch: () => Promise<string>;
  agentGetBoardsList: () => Promise<string>;
  agentSelectBoard: (input: string) => Promise<string>;
  agentSearchBoards: (query: string) => Promise<string>;
  agentInstallBoard: (platformId: string, version?: string) => Promise<string>;
  agentUninstallBoard: (platformId: string) => Promise<string>;
  agentAddBoardUrl: (url: string) => Promise<string>;
  agentRemoveBoardUrl: (urlOrName: string) => Promise<string>;
  agentFetchBoardUrls: (query: string) => Promise<string>;
  agentGetBoardConfig: (fqbn?: string) => Promise<string>;
  agentSetBoardConfig: (fqbn: string | undefined, options: string) => Promise<string>;
  agentGetPortsList: () => Promise<string>;
  agentSelectPort: (port: string) => Promise<string>;
  agentInstallLibrary: (name: string) => Promise<string>;
  agentUninstallLibrary: (name: string) => Promise<string>;
} {
  const delay = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  };

  const tryModernChannelApi = async (): Promise<string | null> => {
    try {
      const managerAny = deps.outputChannels as any;
      if (typeof managerAny.contentOfChannel === 'function') {
        return (await managerAny.contentOfChannel('Arduino')) || '';
      }
    } catch {
      // Fallback to direct channel access
    }
    return null;
  };

  const extractChannelText = (outputChannel: any): string => {
    try {
      if ('getText' in outputChannel) {
        return outputChannel.getText();
      }
      if ('text' in outputChannel) {
        return outputChannel.text;
      }
      if ('append' in outputChannel && 'clear' in outputChannel) {
        if (outputChannel._lines) {
          return outputChannel._lines.join('\n');
        }
        if (outputChannel.document?.getText) {
          return outputChannel.document.getText();
        }
      }
    } catch (err) {
      spectreWarn('Failed to read output channel:', err);
    }
    return '';
  };

  const readArduinoOutputChannel = async (): Promise<string> => {
    const modernResult = await tryModernChannelApi();
    if (modernResult !== null) {
      return modernResult;
    }

    const outputChannel = deps.outputChannels.getChannel('Arduino');
    if (!outputChannel) {
      spectreWarn('Arduino output channel not found');
      return '';
    }

    return extractChannelText(outputChannel);
  };

  const checkCompilationErrors = async (): Promise<string | null> => {
    try {
      const content = await readArduinoOutputChannel();
      if (!content) return null;
      const lines = content.split('\n');
      const recentLines = lines.slice(-SKETCH_CONSTANTS.RECENT_OUTPUT_LINE_COUNT);

      const uploadErrorLines = UploadHelper.scanForUploadErrors(recentLines);
      const compilationErrorLines = UploadHelper.scanForCompilationErrors(recentLines);

      if (uploadErrorLines.length > 0) {
        return uploadErrorLines.join('\n');
      }

      if (compilationErrorLines.length > 0) {
        return compilationErrorLines.join('\n');
      }

      const potentialErrors = UploadHelper.findPotentialErrors(recentLines);
      if (potentialErrors.length > 0) {
        return potentialErrors.join('\n');
      }

      return null;
    } catch (error) {
      spectreWarn('Failed to check compilation errors:', error);
      return null;
    }
  };

  const validateBoardAndPort = (requirePort = false): ValidationResult => {
    const currentConfig = deps.boardsServiceProvider.boardsConfig;
    const selectedBoard = currentConfig.selectedBoard;
    const selectedPort = currentConfig.selectedPort;

    if (!selectedBoard) {
      return {
        valid: false,
        message:
          '❌ No board selected. Please select a board first using [ACTION:GET_BOARDS] to see available boards, then [ACTION:SELECT_BOARD:board_name].',
      };
    }

    if (requirePort && !selectedPort) {
      return {
        valid: false,
        message:
          '❌ No port selected. Please select a port first using [ACTION:GET_PORTS] to see available ports, then [ACTION:SELECT_PORT:port_address].',
      };
    }

    return {
      valid: true,
      board: selectedBoard,
      port: selectedPort,
    };
  };

  const agentModifySketch = async (filePath: string, content: string): Promise<string> => {
    return await SketchOperations.agentModifySketch(
      {
        delay,
        editorManager: deps.editorManager,
        timing: {
          SKETCH_SAVE_DELAY: deps.timing.SKETCH_SAVE_DELAY,
          SERVICE_READY_WAIT: deps.timing.SERVICE_READY_WAIT,
          PORT_SELECTION_DELAY: deps.timing.PORT_SELECTION_DELAY,
        },
        showInlineDiff: async (uri: any, path: string, oldCode: string, newCode: string) => {
          await UiUtilities.showInlineDiff(
            {
              editorManager: deps.editorManager,
              decorationTimers: deps.decorationTimers,
              timing: { DECORATION_AUTO_REMOVE: deps.timing.DECORATION_AUTO_REMOVE },
            },
            {
              uri,
              oldCode,
              newCode,
            }
          );
        },
        getErrorMessage: deps.getErrorMessage,
        logError: (message: string, error: unknown) => spectreError(message, error),
      },
      filePath,
      content
    );
  };

  const boardDeps = () => ({
    delay,
    timing: { BOARD_SELECTION_DELAY: deps.timing.BOARD_SELECTION_DELAY },
    getErrorMessage: deps.getErrorMessage,
    boardsServiceProvider: deps.boardsServiceProvider as any,
    boardsService: deps.boardsService as any,
    boardsDataStore: deps.boardsDataStore as any,
    getBoardSearchCache: deps.getBoardSearchCache,
    setBoardSearchCache: deps.setBoardSearchCache,
  });

  return {
    agentCreateSketch: async (name?: string, code?: string): Promise<string> => {
      return await SketchOperations.agentCreateSketch(
        {
          sketchesClient: deps.sketchesClient,
          commands: deps.commands,
          editorManager: deps.editorManager,
          delay,
          timing: { AGENT_ERROR_DELAY: deps.timing.AGENT_ERROR_DELAY },
          agentModifySketch,
        },
        name,
        code
      );
    },

    agentReadSketch: async (): Promise<string> => {
      return SketchOperations.agentReadSketch({
        sketchesClient: deps.sketchesClient,
        commands: deps.commands,
        editorManager: deps.editorManager,
        delay,
        timing: { AGENT_ERROR_DELAY: deps.timing.AGENT_ERROR_DELAY },
        agentModifySketch,
      });
    },

    agentVerifySketch: async (): Promise<string> => {
      await delay(deps.timing.SKETCH_SAVE_DELAY);

      const sketch = await deps.sketchesClient.currentSketch();
      if (!CurrentSketch.isValid(sketch)) {
        throw new Error('No valid sketch is currently open');
      }

      const validation = validateBoardAndPort(false);
      if (!validation.valid) {
        throw new Error(validation.message!);
      }

      await deps.commands.executeCommand('arduino-verify-sketch');
      await delay(deps.timing.COMPILATION_TIMEOUT);

      let verificationErrors = await checkCompilationErrors();
      if (!verificationErrors) {
        await delay(deps.timing.UPLOAD_PREPARATION_DELAY);
        verificationErrors = await checkCompilationErrors();
      }

      if (verificationErrors) {
        throw new Error(
          `Sketch verification failed with errors:\n\n${verificationErrors}\n\n⚠️ Please fix these compilation errors before proceeding.`
        );
      }

      return `✅ Sketch verification completed successfully for: ${sketch.name}`;
    },

    agentUploadSketch: async (): Promise<string> => {
      return await UploadTools.agentUploadSketch({
        delay,
        timing: {
          COMPILATION_TIMEOUT: deps.timing.COMPILATION_TIMEOUT,
          UPLOAD_START_DELAY: deps.timing.UPLOAD_START_DELAY,
          COMPILATION_CHECK_DELAY: deps.timing.COMPILATION_CHECK_DELAY,
          UPLOAD_PROCESS_DELAY: deps.timing.UPLOAD_PROCESS_DELAY,
          SKETCH_SAVE_DELAY: deps.timing.SKETCH_SAVE_DELAY,
        },
        readArduinoOutputChannel,
        commands: deps.commands,
        sketchesClient: deps.sketchesClient,
        validateBoardAndPort,
        boardsServiceProvider: deps.boardsServiceProvider,
        monitorManagerProxy: deps.monitorManagerProxy,
      });
    },

    agentInstallLibrary: async (name: string): Promise<string> => {
      return await AgentTools.agentInstallLibrary(
        {
          libraryService: deps.libraryService,
          outputChannels: deps.outputChannels,
        },
        name
      );
    },

    agentUninstallLibrary: async (name: string): Promise<string> => {
      return await AgentTools.agentUninstallLibrary(
        {
          libraryService: deps.libraryService,
          outputChannels: deps.outputChannels,
        },
        name
      );
    },

    agentAddBoardUrl: async (url: string): Promise<string> => {
      return await AgentTools.agentAddBoardUrl(
        {
          commands: deps.commands,
          boardsService: deps.boardsService,
          configService: deps.configService,
          delay,
          timing: { PACKAGE_INDEX_POLL_INTERVAL: deps.timing.PACKAGE_INDEX_POLL_INTERVAL },
        },
        url
      );
    },

    agentRemoveBoardUrl: async (urlOrName: string): Promise<string> => {
      return await AgentTools.agentRemoveBoardUrl(
        {
          commands: deps.commands,
          boardsService: deps.boardsService,
          configService: deps.configService,
          delay,
          timing: { PACKAGE_INDEX_POLL_INTERVAL: deps.timing.PACKAGE_INDEX_POLL_INTERVAL },
        },
        urlOrName
      );
    },

    agentFetchBoardUrls: async (query: string): Promise<string> => {
      return await AgentTools.agentFetchBoardUrls({}, query);
    },

    agentInstallBoard: async (platformId: string, version?: string): Promise<string> => {
      return await PlatformTools.agentInstallBoard(
        {
          boardsService: deps.boardsService,
          outputChannels: deps.outputChannels,
        },
        platformId,
        version
      );
    },

    agentSearchBoards: async (query: string): Promise<string> => {
      return await PlatformTools.agentSearchBoards(
        {
          boardsService: deps.boardsService,
        },
        query
      );
    },

    agentUninstallBoard: async (platformId: string): Promise<string> => {
      return await PlatformTools.agentUninstallBoard(
        {
          boardsService: deps.boardsService,
          outputChannels: deps.outputChannels,
        },
        platformId
      );
    },

    agentSelectBoard: async (input: string): Promise<string> => {
      return await BoardTools.agentSelectBoard(boardDeps(), input);
    },

    agentSelectPort: async (port: string): Promise<string> => {
      return await BoardTools.agentSelectPort(boardDeps(), port);
    },

    agentGetBoardsList: async (): Promise<string> => {
      return await BoardTools.agentGetBoardsList(boardDeps());
    },

    agentGetPortsList: async (): Promise<string> => {
      return await BoardTools.agentGetPortsList(boardDeps());
    },

    agentGetBoardConfig: async (fqbn?: string): Promise<string> => {
      return await BoardTools.agentGetBoardConfig(boardDeps(), fqbn);
    },

    agentSetBoardConfig: async (fqbn: string | undefined, options: string): Promise<string> => {
      return await BoardTools.agentSetBoardConfig(boardDeps(), fqbn, options);
    },
  };
}
