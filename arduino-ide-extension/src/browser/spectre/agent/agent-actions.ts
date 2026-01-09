/**
 * Spectre agent action implementations (sketch, board, platform, upload, etc.).
 *
 * @author Tazul Islam
 */

import {
  spectreError,
  spectreWarn,
  SKETCH_CONSTANTS,
  type ValidationResult,
} from '../../../common/protocol/spectre-types';
import { CurrentSketch, SketchesServiceClientImpl } from '../../sketches-service-client-impl';
import {
  Sketch,
} from '../../../common/protocol/sketches-service';
import { BoardsService } from '../../../common/protocol/boards-service';
import { LibraryService } from '../../../common/protocol/library-service';
import * as SketchOperations from './sketch-operations';
import * as UploadTools from './upload-tools';
import * as AgentTools from './agent-tools';
import * as PlatformTools from './platform-tools';
import * as BoardTools from './board-tools';
import { executeAgentAction } from './agent-utils';
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
  sketchesClient: SketchesServiceClientImpl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commands: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editorManager: any;
  outputChannels: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getChannel(name: string): any;
    contentOfChannel?(name: string): Promise<string | undefined>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boardsServiceProvider: any;
  boardsService: BoardsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boardsDataStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitorManagerProxy: any;
  libraryService: LibraryService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decorationTimers: any;

  getErrorMessage: (error: unknown) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getBoardSearchCache: () => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setBoardSearchCache: (cache: any) => void;

  timing: AgentActionsTiming;
}

export interface CreateSketchArgs {
  name?: string;
  code?: string;
}

export interface SketchEditArgs {
  filePath: string;
  content: string;
}

export interface InstallBoardArgs {
  platformId: string;
  version?: string;
}

export interface BoardConfigArgs {
  fqbn?: string;
  options: string;
}

export type SelectBoardInput = string;
export type PortInput = string;
export type LibraryName = string;
export type Url = string;
export type UrlOrName = string;
export type Query = string;
export type PlatformId = string;
export type Fqbn = string;

export function createAgentActions(deps: AgentActionsDeps): {
  agentCreateSketch: (args?: CreateSketchArgs) => Promise<string>;
  agentReadSketch: () => Promise<string>;
  agentVerifySketch: () => Promise<string>;
  agentUploadSketch: () => Promise<string>;
  agentGetBoardsList: () => Promise<string>;
  agentSelectBoard: (input: SelectBoardInput) => Promise<string>;
  agentSearchBoards: (query: Query) => Promise<string>;
  agentInstallBoard: (args: InstallBoardArgs) => Promise<string>;
  agentUninstallBoard: (platformId: PlatformId) => Promise<string>;
  agentAddBoardUrl: (url: Url) => Promise<string>;
  agentRemoveBoardUrl: (urlOrName: UrlOrName) => Promise<string>;
  agentFetchBoardUrls: (query: Query) => Promise<string>;
  agentGetBoardConfig: (fqbn?: Fqbn) => Promise<string>;
  agentSetBoardConfig: (args: BoardConfigArgs) => Promise<string>;
  agentGetPortsList: () => Promise<string>;
  agentSelectPort: (port: PortInput) => Promise<string>;
  agentInstallLibrary: (name: LibraryName) => Promise<string>;
  agentUninstallLibrary: (name: LibraryName) => Promise<string>;
} {
  const delay = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  };

  const readArduinoOutputChannel = async (): Promise<string> => {
    try {
      // Ensure the channel/resource exists before reading it.
      deps.outputChannels.getChannel('Arduino');
      const content = await deps.outputChannels.contentOfChannel?.('Arduino');
      return content || '';
    } catch (err) {
      spectreWarn('Failed to read Arduino output channel:', err);
      return '';
    }
  };

  const checkCompilationErrors = async (): Promise<string | null> => {
    try {
      const content = await readArduinoOutputChannel();
      if (!content) return null;
      const lines = content.split('\n');
      const recentLines = lines.slice(
        -SKETCH_CONSTANTS.RECENT_OUTPUT_LINE_COUNT
      );

      return UploadHelper.extractFirstError(recentLines);
    } catch (error) {
      spectreWarn('Failed to check compilation errors:', error);
      return null;
    }
  };

  const getValidCurrentSketch = async (): Promise<Sketch> => {
    const sketch = await deps.sketchesClient.currentSketch();
    if (!CurrentSketch.isValid(sketch)) {
      throw new Error('No valid sketch is currently open');
    }
    return sketch;
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

  const showInlineDiff = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    uri: any,
    path: string,
    oldCode: string,
    newCode: string
  ) => {
    await UiUtilities.showInlineDiff(
      {
        editorManager: deps.editorManager,
        decorationTimers: deps.decorationTimers,
        timing: {
          DECORATION_AUTO_REMOVE: deps.timing.DECORATION_AUTO_REMOVE,
        },
      },
      {
        uri,
        oldCode,
        newCode,
      }
    );
  };

  const agentModifySketch = async (
    filePathOrArgs: string | SketchEditArgs,
    contentArg?: string
  ): Promise<string> => {
    const filePath = typeof filePathOrArgs === 'string' ? filePathOrArgs : filePathOrArgs.filePath;
    const content = typeof filePathOrArgs === 'string' ? contentArg! : filePathOrArgs.content;
    return await SketchOperations.agentModifySketch(
      {
        sketchesClient: {
            currentSketch: async () => {
              const sketch = await deps.sketchesClient.currentSketch();
              if (CurrentSketch.isValid(sketch)) {
                return sketch;
              }
              throw new Error('No valid sketch is currently open');
            },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        commands: deps.commands,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editorManager: deps.editorManager,
        delay,
        timing: {
          SKETCH_SAVE_DELAY: deps.timing.SKETCH_SAVE_DELAY,
          SERVICE_READY_WAIT: deps.timing.SERVICE_READY_WAIT,
          PORT_SELECTION_DELAY: deps.timing.PORT_SELECTION_DELAY,
          AGENT_ERROR_DELAY: deps.timing.AGENT_ERROR_DELAY,
        },
        showInlineDiff,
        getErrorMessage: deps.getErrorMessage,
        logError: (message: string, error: unknown) =>
          spectreError(message, error),
        agentModifySketch, // Recursive reference
      },
      filePath,
      content
    );
  };

  const sketchOpsDeps = () => ({
    sketchesClient: {
      currentSketch: async () => {
        const sketch = await deps.sketchesClient.currentSketch();
        if (CurrentSketch.isValid(sketch)) {
          return sketch;
        }
        throw new Error('No valid sketch is currently open');
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commands: deps.commands,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editorManager: deps.editorManager,
    delay,
    timing: { 
      AGENT_ERROR_DELAY: deps.timing.AGENT_ERROR_DELAY,
      SKETCH_SAVE_DELAY: deps.timing.SKETCH_SAVE_DELAY,
      SERVICE_READY_WAIT: deps.timing.SERVICE_READY_WAIT,
      PORT_SELECTION_DELAY: deps.timing.PORT_SELECTION_DELAY,
    },
    agentModifySketch,
    showInlineDiff,
    getErrorMessage: deps.getErrorMessage,
    logError: (message: string, error: unknown) =>
      spectreError(message, error),
  });

  const libraryDeps = () => ({
    libraryService: deps.libraryService,
    outputChannels: deps.outputChannels,
  });

  const packageIndexDeps = () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commands: deps.commands,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boardsService: deps.boardsService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configService: deps.configService,
    delay,
    timing: {
      PACKAGE_INDEX_POLL_INTERVAL: deps.timing.PACKAGE_INDEX_POLL_INTERVAL,
    },
  });

  const boardDeps = () => ({
    delay,
    timing: { BOARD_SELECTION_DELAY: deps.timing.BOARD_SELECTION_DELAY },
    getErrorMessage: deps.getErrorMessage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boardsServiceProvider: deps.boardsServiceProvider as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boardsService: deps.boardsService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boardsDataStore: deps.boardsDataStore as any,
    getBoardSearchCache: deps.getBoardSearchCache,
    setBoardSearchCache: deps.setBoardSearchCache,
  });

  const platformDeps = () => ({
    boardsService: deps.boardsService,
    outputChannels: deps.outputChannels,
  });

  const platformSearchDeps = () => ({
    boardsService: deps.boardsService,
  });

  return {
    agentCreateSketch: async (args?: CreateSketchArgs): Promise<string> => {
      const { name, code } = args || {};
      return await SketchOperations.agentCreateSketch(
        sketchOpsDeps(),
        name,
        code
      );
    },

    agentReadSketch: async (): Promise<string> => {
      return SketchOperations.agentReadSketch(sketchOpsDeps());
    },

    agentVerifySketch: async (): Promise<string> => {
      return executeAgentAction(
        {
          logPrefix: 'Sketch verification',
          actionDesc: 'verify sketch',
          getErrorMessage: deps.getErrorMessage,
        },
        async () => {
          await delay(deps.timing.SKETCH_SAVE_DELAY);

          const sketch = await getValidCurrentSketch();

          const validation = validateBoardAndPort(false);
          if (!validation.valid) {
            throw new Error(validation.message || 'Validation failed');
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
        }
      );
    },

    agentUploadSketch: async (): Promise<string> => {
      return executeAgentAction(
        {
          logPrefix: 'Upload',
          actionDesc: 'upload sketch',
          getErrorMessage: deps.getErrorMessage,
        },
        async () => {
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
            sketchesClient: {
              currentSketch: async () => {
                const sketch = await deps.sketchesClient.currentSketch();
                if (CurrentSketch.isValid(sketch)) {
                  return sketch;
                }
                throw new Error('No valid sketch is currently open');
              },
            },
            validateBoardAndPort,
            boardsServiceProvider: deps.boardsServiceProvider,
            monitorManagerProxy: deps.monitorManagerProxy,
          });
        }
      );
    },

    agentInstallLibrary: async (name: LibraryName): Promise<string> => {
      return await AgentTools.agentInstallLibrary(libraryDeps(), name);
    },

    agentUninstallLibrary: async (name: LibraryName): Promise<string> => {
      return await AgentTools.agentUninstallLibrary(libraryDeps(), name);
    },

    agentAddBoardUrl: async (url: Url): Promise<string> => {
      return await AgentTools.agentAddBoardUrl(packageIndexDeps(), url);
    },

    agentRemoveBoardUrl: async (urlOrName: UrlOrName): Promise<string> => {
      return await AgentTools.agentRemoveBoardUrl(
        packageIndexDeps(),
        urlOrName
      );
    },

    agentFetchBoardUrls: async (query: Query): Promise<string> => {
      return await AgentTools.agentFetchBoardUrls(packageIndexDeps(), query);
    },

    agentInstallBoard: async (args: InstallBoardArgs): Promise<string> => {
      const { platformId, version } = args;
      return await PlatformTools.agentInstallBoard(
        platformDeps(),
        platformId,
        version
      );
    },

    agentSearchBoards: async (query: Query): Promise<string> => {
      return await PlatformTools.agentSearchBoards(platformSearchDeps(), query);
    },

    agentUninstallBoard: async (platformId: PlatformId): Promise<string> => {
      return await PlatformTools.agentUninstallBoard(
        platformDeps(),
        platformId
      );
    },

    agentSelectBoard: async (input: SelectBoardInput): Promise<string> => {
      return await BoardTools.agentSelectBoard(boardDeps(), input);
    },

    agentSelectPort: async (port: PortInput): Promise<string> => {
      return await BoardTools.agentSelectPort(boardDeps(), port);
    },

    agentGetBoardsList: async (): Promise<string> => {
      return await BoardTools.agentGetBoardsList(boardDeps());
    },

    agentGetPortsList: async (): Promise<string> => {
      return await BoardTools.agentGetPortsList(boardDeps());
    },

    agentGetBoardConfig: async (fqbn?: Fqbn): Promise<string> => {
      return await BoardTools.agentGetBoardConfig(boardDeps(), fqbn);
    },

    agentSetBoardConfig: async (args: BoardConfigArgs): Promise<string> => {
      const { fqbn, options } = args;
      return await BoardTools.agentSetBoardConfig(boardDeps(), fqbn, options);
    },
  };
}

export type AgentActions = ReturnType<typeof createAgentActions>;
