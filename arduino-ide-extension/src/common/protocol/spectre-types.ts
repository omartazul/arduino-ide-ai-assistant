/**
 * Timing constants for Spectre AI service.
 * Shared between frontend and backend for consistent timing behavior.
 *
 * @author Tazul Islam
 */
export const TIMING_CONSTANTS = {
  /** Delay for client ready wait (ms) */
  CLIENT_READY_WAIT: 1500,
  /** Interval for processing queue (ms) */
  QUEUE_PROCESSING_INTERVAL: 25,
  /** Delay for retry on network errors (ms) */
  NETWORK_RETRY_BASE_DELAY: 1000,
  /** Delay for retry on service overload (ms) */
  SERVICE_OVERLOAD_BASE_DELAY: 3000,
  /** Maximum time to wait for API response before timing out (ms) */
  REQUEST_TIMEOUT: 120000, // 2 minutes
  /** Maximum time without receiving data during streaming (ms) */
  STREAM_INACTIVITY_TIMEOUT: 30000, // 30 seconds
} as const;

/**
 * Sketch operation constants.
 * Used by SpectreWidget for sketch creation, output analysis, and error detection.
 */
export const SKETCH_CONSTANTS = {
  /** Maximum lines to analyze from output channel for error detection */
  RECENT_OUTPUT_LINE_COUNT: 200,
  /** Character limit for debug output display */
  DEBUG_OUTPUT_CHAR_LIMIT: 1200,
  /** Maximum retry attempts for sketch creation */
  MAX_SKETCH_CREATION_RETRIES: 5,
  /** Delay between sketch creation retries (ms) */
  SKETCH_CREATION_RETRY_DELAY: 500,
} as const;

/**
 * Debug logging configuration.
 * In production (NODE_ENV=production): Always disabled
 * In development: Controlled by SPECTRE_DEBUG environment variable
 *   - SPECTRE_DEBUG=true: Enable debug logs (default for development)
 *   - SPECTRE_DEBUG=false: Disable debug logs
 *
 * This allows developers to reduce noise in development while keeping
 * production builds completely clean.
 */
const DEBUG_ENABLED =
  process.env.NODE_ENV !== 'production' &&
  process.env.SPECTRE_DEBUG !== 'false';

/**
 * Debug logging utility - can be disabled for production.
 * Use this instead of console.log for development/debug output.
 */
export const spectreLog = DEBUG_ENABLED ? console.log.bind(console) : () => {};

/**
 * Warning logging utility - always enabled.
 * Use for non-critical issues that should be visible in production.
 */
export const spectreWarn = console.warn.bind(console);

/**
 * Error logging utility - always enabled.
 * Use for critical errors that should always be logged.
 */
export const spectreError = console.error.bind(console);

/**
 * Board information interface.
 * Represents an Arduino board with its fully qualified board name (FQBN).
 */
export interface BoardInfo {
  name: string;
  fqbn: string;
  port?: PortInfo;
}

/**
 * Port information interface.
 * Represents a communication port (serial, network, etc.).
 */
export interface PortInfo {
  address: string;
  protocol: string;
  protocolLabel?: string;
  properties?: Record<string, string>;
  hardwareId?: string;
}

/**
 * Detected port interface.
 * Represents a port detected by the Arduino CLI with associated board information.
 */
export interface DetectedPort {
  port: PortInfo;
  matchingBoards?: Array<{
    name: string;
    fqbn: string;
  }>;
}

/**
 * Board and port validation result.
 * Returned by validation methods to indicate configuration status.
 * Uses 'any' for board/port to accommodate different Arduino types.
 */
export interface ValidationResult {
  valid: boolean;
  message?: string;
  board?: any; // BoardIdentifier or similar Arduino type
  port?: any; // Port or similar Arduino type
}
