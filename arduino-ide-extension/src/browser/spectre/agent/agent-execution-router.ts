/**
 * Agent function execution routing helpers for SpectreWidget.
 * Handles routing of AI agent function calls to appropriate backend methods.
 * 
 * @author Tazul Islam
 */

/**
 * Checks if result indicates success (no error marker).
 */
function isSuccessResult(result: string): boolean {
  return !result.includes('❌');
}

/**
 * Executes sketch-related functions.
 * Routes create_sketch, read_sketch, verify_sketch, upload_sketch calls.
 */
async function executeSketchFunction(
  name: string,
  args: Record<string, any>,
  handlers: {
    agentCreateSketch: (name?: string, code?: string) => Promise<string>;
    agentReadSketch: () => Promise<string>;
    agentVerifySketch: () => Promise<string>;
    agentUploadSketch: () => Promise<string>;
  }
): Promise<{ success: boolean; result?: string } | null> {
  let result: string;

  switch (name) {
    case 'create_sketch':
      result = await handlers.agentCreateSketch(args.name, args.code);
      return { success: isSuccessResult(result), result };

    case 'read_sketch':
      result = await handlers.agentReadSketch();
      return { success: isSuccessResult(result), result };

    case 'verify_sketch':
      result = await handlers.agentVerifySketch();
      return { success: isSuccessResult(result), result };

    case 'upload_sketch':
      result = await handlers.agentUploadSketch();
      return { success: isSuccessResult(result), result };

    default:
      return null;
  }
}

/**
 * Executes board-related functions.
 * Routes board selection, installation, configuration, and URL management calls.
 */
async function executeBoardFunction(
  name: string,
  args: Record<string, any>,
  handlers: {
    agentGetBoardsList: () => Promise<string>;
    agentSelectBoard: (name: string) => Promise<string>;
    agentSearchBoards: (query: string) => Promise<string>;
    agentInstallBoard: (platform: string, version?: string) => Promise<string>;
    agentUninstallBoard: (platform: string) => Promise<string>;
    agentAddBoardUrl: (url: string) => Promise<string>;
    agentRemoveBoardUrl: (url: string) => Promise<string>;
    agentFetchBoardUrls: (query: string) => Promise<string>;
    agentGetBoardConfig: (fqbn?: string) => Promise<string>;
    agentSetBoardConfig: (fqbn: string | undefined, options: string) => Promise<string>;
  }
): Promise<{ success: boolean; result?: string } | null> {
  const boardFunctions: { [key: string]: () => Promise<string> } = {
    get_boards: () => handlers.agentGetBoardsList(),
    select_board: () => handlers.agentSelectBoard(args.name),
    search_boards: () => handlers.agentSearchBoards(args.query),
    install_board: () => handlers.agentInstallBoard(args.platform, args.version),
    uninstall_board: () => handlers.agentUninstallBoard(args.platform),
    add_board_url: () => handlers.agentAddBoardUrl(args.url),
    remove_board_url: () => handlers.agentRemoveBoardUrl(args.url),
    fetch_board_urls: () => handlers.agentFetchBoardUrls(args.query),
    get_board_config: () => handlers.agentGetBoardConfig(args.fqbn),
    set_board_config: () => handlers.agentSetBoardConfig(args.fqbn, args.options),
  };

  const fn = boardFunctions[name];
  if (!fn) {
    return null;
  }

  const result = await fn();
  return { success: isSuccessResult(result), result };
}

/**
 * Executes port and library-related functions.
 * Routes port selection and library installation/uninstallation calls.
 */
async function executePortAndLibraryFunction(
  name: string,
  args: Record<string, any>,
  handlers: {
    agentGetPortsList: () => Promise<string>;
    agentSelectPort: (address: string) => Promise<string>;
    agentInstallLibrary: (name: string) => Promise<string>;
    agentUninstallLibrary: (name: string) => Promise<string>;
  }
): Promise<{ success: boolean; result?: string } | null> {
  let result: string;

  switch (name) {
    case 'get_ports':
      result = await handlers.agentGetPortsList();
      return { success: isSuccessResult(result), result };

    case 'select_port':
      result = await handlers.agentSelectPort(args.address);
      return { success: isSuccessResult(result), result };

    case 'install_library':
      result = await handlers.agentInstallLibrary(args.name);
      return { success: isSuccessResult(result), result };

    case 'uninstall_library':
      result = await handlers.agentUninstallLibrary(args.name);
      return { success: isSuccessResult(result), result };

    default:
      return null;
  }
}

/**
 * Executes a function call from the AI agent by routing to the appropriate agent method.
 * This is the main entry point for agent function execution.
 * 
 * @param functionCall Function name and arguments from AI
 * @param allHandlers Combined handlers for all agent functions
 * @param spectreError Error logging function
 * @returns Result with success flag and optional result/error message
 */
export async function executeFunctionCall(
  functionCall: {
    name: string;
    args: Record<string, any>;
  },
  allHandlers: {
    // Sketch handlers
    agentCreateSketch: (name?: string, code?: string) => Promise<string>;
    agentReadSketch: () => Promise<string>;
    agentVerifySketch: () => Promise<string>;
    agentUploadSketch: () => Promise<string>;
    // Board handlers
    agentGetBoardsList: () => Promise<string>;
    agentSelectBoard: (name: string) => Promise<string>;
    agentSearchBoards: (query: string) => Promise<string>;
    agentInstallBoard: (platform: string, version?: string) => Promise<string>;
    agentUninstallBoard: (platform: string) => Promise<string>;
    agentAddBoardUrl: (url: string) => Promise<string>;
    agentRemoveBoardUrl: (url: string) => Promise<string>;
    agentFetchBoardUrls: (query: string) => Promise<string>;
    agentGetBoardConfig: (fqbn?: string) => Promise<string>;
    agentSetBoardConfig: (fqbn: string | undefined, options: string) => Promise<string>;
    // Port and library handlers
    agentGetPortsList: () => Promise<string>;
    agentSelectPort: (address: string) => Promise<string>;
    agentInstallLibrary: (name: string) => Promise<string>;
    agentUninstallLibrary: (name: string) => Promise<string>;
  },
  spectreError: (message: string, error: any) => void
): Promise<{ success: boolean; result?: string; error?: string }> {
  const { name, args } = functionCall;

  try {
    // Try sketch functions
    const sketchResult = await executeSketchFunction(name, args, {
      agentCreateSketch: allHandlers.agentCreateSketch,
      agentReadSketch: allHandlers.agentReadSketch,
      agentVerifySketch: allHandlers.agentVerifySketch,
      agentUploadSketch: allHandlers.agentUploadSketch,
    });
    if (sketchResult) return sketchResult;

    // Try board functions
    const boardResult = await executeBoardFunction(name, args, {
      agentGetBoardsList: allHandlers.agentGetBoardsList,
      agentSelectBoard: allHandlers.agentSelectBoard,
      agentSearchBoards: allHandlers.agentSearchBoards,
      agentInstallBoard: allHandlers.agentInstallBoard,
      agentUninstallBoard: allHandlers.agentUninstallBoard,
      agentAddBoardUrl: allHandlers.agentAddBoardUrl,
      agentRemoveBoardUrl: allHandlers.agentRemoveBoardUrl,
      agentFetchBoardUrls: allHandlers.agentFetchBoardUrls,
      agentGetBoardConfig: allHandlers.agentGetBoardConfig,
      agentSetBoardConfig: allHandlers.agentSetBoardConfig,
    });
    if (boardResult) return boardResult;

    // Try port and library functions
    const portLibResult = await executePortAndLibraryFunction(name, args, {
      agentGetPortsList: allHandlers.agentGetPortsList,
      agentSelectPort: allHandlers.agentSelectPort,
      agentInstallLibrary: allHandlers.agentInstallLibrary,
      agentUninstallLibrary: allHandlers.agentUninstallLibrary,
    });
    if (portLibResult) return portLibResult;

    // Unknown function
    return {
      success: false,
      error: `Unknown function: ${name}`,
    };
  } catch (error: any) {
    spectreError(`Function execution failed: ${name}`, error);
    return {
      success: false,
      error: error?.message || String(error),
    };
  }
}
