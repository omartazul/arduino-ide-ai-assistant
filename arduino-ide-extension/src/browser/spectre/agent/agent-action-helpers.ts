/**
 * Agent action execution helpers.
 * Handles action history tracking and loop detection.
 *
 * @author Tazul Islam
 */

export interface ActionHistoryEntry {
  signature: string;
  normalizedSignature: string;
  timestamp: number;
  functionName: string;
  args: any;
  result?: { success: boolean; error?: string };
}

/**
 * Creates a loop detector for preventing infinite agent loops.
 */
export function createLoopDetector() {
  const recentActions = new Map<string, number>();
  const actionHistory: ActionHistoryEntry[] = [];

  return {
    detect: (functionCalls: Array<{ name: string; args: any }>) => {
      const signatures = functionCalls.map((fc) =>
        JSON.stringify({ name: fc.name, args: fc.args })
      );

      for (const sig of signatures) {
        const count = recentActions.get(sig) || 0;
        if (count >= 3) {
          return {
            isLoop: true,
            message: `Detected repeated action: ${JSON.parse(sig).name}`,
          };
        }
        recentActions.set(sig, count + 1);
      }

      return { isLoop: false };
    },
    addToHistory: (entry: ActionHistoryEntry) => {
      actionHistory.push(entry);
    },
    getHistory: () => actionHistory,
    clear: () => {
      recentActions.clear();
      actionHistory.length = 0;
    },
  };
}

/**
 * Normalizes function call signature for comparison.
 */
export function normalizeFunctionSignature(
  functionName: string,
  args: any
): string {
  // Create normalized version by sorting keys and removing volatile values
  const normalizedArgs = { ...args };
  
  // Remove timestamp-like fields
  delete normalizedArgs.timestamp;
  delete normalizedArgs.requestId;
  
  return JSON.stringify({
    name: functionName,
    args: normalizedArgs,
  });
}

/**
 * Creates action signature for tracking.
 */
export function createActionSignature(
  functionName: string,
  args: any
): string {
  return JSON.stringify({ name: functionName, args });
}

/**
 * Updates action history with execution result.
 */
export function updateActionHistory(
  actionHistory: ActionHistoryEntry[],
  functionName: string,
  args: any,
  result: any
): void {
  const signature = createActionSignature(functionName, args);
  const normalizedSignature = normalizeFunctionSignature(functionName, args);

  actionHistory.push({
    signature,
    normalizedSignature,
    timestamp: Date.now(),
    functionName,
    args,
    result:
      typeof result === 'string'
        ? { success: true }
        : { success: result.success, error: result.error },
  });
}

/**
 * Checks if action was recently executed.
 */
export function isRecentAction(
  actionHistory: ActionHistoryEntry[],
  functionName: string,
  args: any,
  timeWindowMs: number = 5000
): boolean {
  const normalizedSig = normalizeFunctionSignature(functionName, args);
  const now = Date.now();

  return actionHistory.some(
    (entry) =>
      entry.normalizedSignature === normalizedSig &&
      now - entry.timestamp < timeWindowMs
  );
}

/**
 * Gets recent action count for a specific function.
 */
export function getRecentActionCount(
  actionHistory: ActionHistoryEntry[],
  functionName: string,
  timeWindowMs: number = 60000
): number {
  const now = Date.now();
  return actionHistory.filter(
    (entry) =>
      entry.functionName === functionName &&
      now - entry.timestamp < timeWindowMs
  ).length;
}
