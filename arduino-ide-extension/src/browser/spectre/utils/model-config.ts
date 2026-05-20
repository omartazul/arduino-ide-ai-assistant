/**
 * Configuration and model helpers.
 * Handles model configuration, limits, and preferences.
 *
 * @author Tazul Islam
 */

/**
 * Model configuration interface.
 */
interface ModelConfig {
  characterLimit: number;
  rpmLimit: number;
}

/**
 * Model configurations map.
 */
const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // Current supported models (see preferences schema)
  'gemini-3.1-flash-lite': {
    characterLimit: 100_000,
    rpmLimit: 15, // 500 RPD
  },
  'gemma-4-31b': {
    characterLimit: 100_000,
    rpmLimit: 15, // 1,500 RPD
  },
  'gemma-4-26b': {
    characterLimit: 100_000,
    rpmLimit: 15, // 1,500 RPD
  },
};

const DEFAULT_CONFIG: ModelConfig = {
  characterLimit: 100_000,
  rpmLimit: 10,
};

/**
 * Gets model configuration.
 */
function getModelConfig(model: string): ModelConfig {
  return MODEL_CONFIGS[model] || DEFAULT_CONFIG;
}

/**
 * Gets character limit for a specific model.
 */
export function getCharacterLimit(model: string): number {
  return getModelConfig(model).characterLimit;
}

/**
 * Gets RPM (Requests Per Minute) limit for a specific model.
 */
export function getRpmLimit(model: string): number {
  return getModelConfig(model).rpmLimit;
}

/**
 * Calculates current RPM based on request logs.
 */
export function calculateCurrentRpm(
  requestLogs: Array<{ timestamp: number }>,
  now: number
): number {
  const oneMinuteAgo = now - 60 * 1000;
  const recentRequests = requestLogs.filter(
    (log) => log.timestamp > oneMinuteAgo
  );
  return recentRequests.length;
}

/**
 * Gets daily stats from tracker.
 */
export function getDailyStats(dailyTracker: {
  requestCount: number;
  tokenCount: number;
}): { requests: number; tokens: number } {
  return {
    requests: dailyTracker.requestCount,
    tokens: dailyTracker.tokenCount,
  };
}

/**
 * Gets Pacific date string for daily tracking.
 */
export function getPacificDate(): string {
  const now = new Date();
  const pacificTime = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
  );
  return pacificTime.toISOString().split('T')[0];
}
