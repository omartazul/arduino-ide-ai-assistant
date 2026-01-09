/**
 * Agent function execution routing helpers for SpectreWidget.
 * Handles routing of AI agent function calls to appropriate backend methods.
 *
 * @author Tazul Islam
 */

import type { AgentActions } from './agent-actions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FunctionCallArgs = Record<string, any>;

type FunctionCall = {
  name: string;
  args: FunctionCallArgs;
};

type FunctionCallSuccessResult = { success: boolean; result?: string };

/**
 * Checks if result indicates success (no error marker).
 */
function isSuccessResult(result: string): boolean {
  return !result.includes('❌');
}

async function toSuccessResult(
  run: () => Promise<string>
): Promise<FunctionCallSuccessResult> {
  const result = await run();
  return { success: isSuccessResult(result), result };
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
  functionCall: FunctionCall,
  allHandlers: AgentActions,
  spectreError: (message: string, error: unknown) => void
): Promise<{ success: boolean; result?: string; error?: string }> {
  const { name, args } = functionCall;

  const routes: Record<string, () => Promise<string>> = {
    // Sketch
    create_sketch: () => allHandlers.agentCreateSketch({ name: args.name, code: args.code }),
    read_sketch: () => allHandlers.agentReadSketch(),
    verify_sketch: () => allHandlers.agentVerifySketch(),
    upload_sketch: () => allHandlers.agentUploadSketch(),

    // Board
    get_boards: () => allHandlers.agentGetBoardsList(),
    select_board: () => allHandlers.agentSelectBoard(args.name),
    search_boards: () => allHandlers.agentSearchBoards(args.query),
    install_board: () =>
      allHandlers.agentInstallBoard({ platformId: args.platform, version: args.version }),
    uninstall_board: () => allHandlers.agentUninstallBoard(args.platform),
    add_board_url: () => allHandlers.agentAddBoardUrl(args.url),
    remove_board_url: () => allHandlers.agentRemoveBoardUrl(args.url),
    fetch_board_urls: () => allHandlers.agentFetchBoardUrls(args.query),
    get_board_config: () => allHandlers.agentGetBoardConfig(args.fqbn),
    set_board_config: () =>
      allHandlers.agentSetBoardConfig({ fqbn: args.fqbn, options: args.options }),

    // Port + library
    get_ports: () => allHandlers.agentGetPortsList(),
    select_port: () => allHandlers.agentSelectPort(args.address),
    install_library: () => allHandlers.agentInstallLibrary(args.name),
    uninstall_library: () => allHandlers.agentUninstallLibrary(args.name),
  };

  try {
    const route = routes[name];
    if (route) {
      return await toSuccessResult(route);
    }

    // Unknown function
    return {
      success: false,
      error: `Unknown function: ${name}`,
    };
  } catch (error: unknown) {
    spectreError(`Function execution failed: ${name}`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
