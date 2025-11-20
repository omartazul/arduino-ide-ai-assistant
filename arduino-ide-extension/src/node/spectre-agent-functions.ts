/**
 * Function declarations for Spectre AI agent mode.
 * Defines all available tools/actions that the AI can invoke autonomously.
 *
 * These schemas tell the AI what capabilities it has WITHOUT prescribing workflows.
 * The AI discovers how to combine these tools dynamically based on user needs.
 *
 * @author Tazul Islam
 */

import { FunctionDeclaration } from '../common/protocol/spectre-ai-service';

/**
 * All available functions for the Spectre AI agent.
 * These are passed to Gemini's function calling API.
 */
export const AGENT_FUNCTIONS: FunctionDeclaration[] = [
  // ===== Sketch Management =====
  {
    name: 'create_sketch',
    description:
      'Creates a new Arduino sketch or updates the current sketch with the provided code. The code should be complete, compilable Arduino C++ code.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Complete Arduino sketch code including setup() and loop() functions',
        },
        name: {
          type: 'string',
          description: 'Optional name for the sketch',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'read_sketch',
    description:
      'Reads the content of the currently open Arduino sketch. Use this before modifying sketches to see what code exists. Returns the complete sketch code.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'verify_sketch',
    description:
      'Compiles the current Arduino sketch to check for errors without uploading to hardware. Returns compilation results.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'upload_sketch',
    description:
      'Uploads the current Arduino sketch to the connected board. Board and port must be selected first. Returns upload status.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },

  // ===== Board Management =====
  {
    name: 'get_boards',
    description:
      'Lists all available Arduino boards (both connected devices and installed platforms). Use this to see what boards are available for selection.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'select_board',
    description:
      'Selects an Arduino board by name. Supports fuzzy matching (e.g., "uno" matches "Arduino Uno"). Use get_boards first to see available options.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Board name or partial name (fuzzy match supported)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_boards',
    description:
      'Searches for board platforms in the Board Manager. Returns exact platform IDs needed for installation. ALWAYS use this before install_board to get the correct platform ID.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (board name, vendor, architecture, etc.)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'install_board',
    description:
      'Installs a board platform from Board Manager. Use search_boards first to get the exact platform ID. For third-party boards, add_board_url must be called first.',
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description:
            'Exact platform ID from search_boards (format: "vendor:arch", e.g., "esp32:esp32")',
        },
        version: {
          type: 'string',
          description: 'Optional version to install (defaults to latest)',
        },
      },
      required: ['platform'],
    },
  },
  {
    name: 'uninstall_board',
    description:
      'Uninstalls a board platform. Use search_boards to find the exact platform ID.',
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'Exact platform ID to uninstall (format: "vendor:arch")',
        },
      },
      required: ['platform'],
    },
  },
  {
    name: 'add_board_url',
    description:
      'Adds a board manager URL to Arduino preferences. Required for third-party board platforms (ESP32, STM32, MiniCore, etc.). After adding, wait 2-3 seconds for package index to download, then use search_boards.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Board manager package index URL (must end in .json)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'remove_board_url',
    description:
      'Removes a board manager URL by name or exact URL. Supports fuzzy matching (e.g., "MiniCore" matches any URL containing "minicore").',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Board name for fuzzy match (e.g., "ESP32") or exact URL',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'fetch_board_urls',
    description:
      'Fetches board manager URLs from the official Arduino Wiki. Use this to discover URLs for third-party boards dynamically without hardcoding.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Board name to search for (e.g., "ESP32", "STM32", "MiniCore")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_board_config',
    description:
      'Gets configuration options for a board (CPU speed, programmer, upload method, etc.). Returns available options and current selections.',
    parameters: {
      type: 'object',
      properties: {
        fqbn: {
          type: 'string',
          description:
            'Optional FQBN (Fully Qualified Board Name). If not provided, uses currently selected board.',
        },
      },
    },
  },
  {
    name: 'set_board_config',
    description:
      'Sets board configuration options (CPU speed, programmer, upload method, etc.). Use get_board_config first to see available options.',
    parameters: {
      type: 'object',
      properties: {
        options: {
          type: 'string',
          description:
            'Configuration options in format "key=value,key2=value2" (e.g., "cpu=80,flash=4M")',
        },
        fqbn: {
          type: 'string',
          description:
            'Optional FQBN. If not provided, uses currently selected board.',
        },
      },
      required: ['options'],
    },
  },

  // ===== Port Management =====
  {
    name: 'get_ports',
    description:
      'Lists all available serial ports with detected board information. Use this to see what ports are available for selection.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'select_port',
    description:
      'Selects a serial port for uploading sketches. Use get_ports first to see available options.',
    parameters: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Port address (e.g., "COM3", "/dev/ttyUSB0")',
        },
      },
      required: ['address'],
    },
  },

  // ===== Library Management =====
  {
    name: 'install_library',
    description:
      'Installs an Arduino library from the Library Manager. Automatically installs dependencies if needed.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Library name (case-sensitive, e.g., "Servo", "WiFiNINA")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'uninstall_library',
    description: 'Uninstalls an Arduino library. Use the exact library name.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Library name to uninstall',
        },
      },
      required: ['name'],
    },
  },
];

/**
 * Maps function names to their execution handlers.
 * This will be used by the backend to actually execute function calls.
 */
export type FunctionExecutor = (
  args: Record<string, any>
) => Promise<{ success: boolean; result?: string; error?: string }>;
