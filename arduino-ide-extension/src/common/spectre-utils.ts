/**
 * Shared utilities for Spectre AI functionality.
 * Used across both browser and node environments.
 *
 * @author Tazul Islam
 */

import { SpectreThinkingLevel } from './protocol/spectre-ai-service';

/**
 * Normalizes thinking level input to a valid SpectreThinkingLevel.
 * Converts input string to uppercase and validates against known levels.
 * Defaults to 'OFF' if invalid.
 *
 * @param raw - Raw thinking level string (case-insensitive)
 * @returns Normalized thinking level or 'OFF' if invalid
 */
export function normalizeThinkingLevel(
  raw: string | undefined
): SpectreThinkingLevel {
  const upper = String(raw ?? 'OFF').toUpperCase();

  switch (upper) {
    case 'LOW':
    case 'MEDIUM':
    case 'HIGH':
      return upper;
    default:
      return 'OFF';
  }
}
