/**
 * Detects repeated agent actions to prevent infinite loops.
 *
 * @author Tazul Islam
 */

export interface LoopDetectorActionRecord {
  signature: string;
  normalizedSignature: string;
  timestamp: number;
  functionName: string;
  args: unknown;
  result?: { success: boolean; error?: string };
}

export type DetectLoopResult = {
  signature: string;
  functionName: string;
  args: unknown;
} | null;

export type DetectLoopFn = (
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>
) => DetectLoopResult;

export function createLoopDetector(params: {
  warn: (message: string) => void;
  now?: () => number;
  loopDetectionWindow?: number;
  maxIdenticalActions?: number;
}): {
  detectLoop: DetectLoopFn;
  actionHistory: Array<LoopDetectorActionRecord>;
} {
  const {
    warn,
    now = () => Date.now(),
    loopDetectionWindow = 8,
    maxIdenticalActions = 2,
  } = params;

  const actionHistory: Array<LoopDetectorActionRecord> = [];

  const normalizeArgs = (
    name: string,
    args: Record<string, unknown>
  ): Record<string, unknown> => {
    const normalized: Record<string, unknown> = {};

    for (const key in args) {
      let value = args[key];

      if (typeof value === 'string') {
        // Use a temporary variable to perform string operations
        // This avoids TypeScript confusion about narrowing mutable 'unknown' type
        let strValue = value.toLowerCase().trim().replace(/\s+/g, ' ');

        if (name === 'select_board' || name === 'search_boards') {
          strValue = strValue.replace(/^arduino\s+/i, '').trim();
        } else if (name === 'install_library' || name === 'uninstall_library') {
          strValue = strValue.trim();
        } else if (name === 'select_port') {
          strValue = strValue.trim();
        }
        value = strValue;
      }

      normalized[key] = value;
    }

    return normalized;
  };

  const getSortedArgsSignatureBase = (
    name: string,
    args: Record<string, unknown>
  ): string => {
    const sortedArgs = Object.keys(args || {})
      .sort()
      .reduce((acc, key) => {
        acc[key] = args[key];
        return acc;
      }, {} as Record<string, unknown>);

    return `${name}:${JSON.stringify(sortedArgs)}`;
  };

  const getSortedArgsSignature = (
    name: string,
    args: Record<string, unknown>
  ): string => getSortedArgsSignatureBase(name, args || {});

  const getSortedNormalizedArgsSignature = (
    name: string,
    args: Record<string, unknown>
  ): string => {
    const normalized = normalizeArgs(name, args || {});
    return getSortedArgsSignatureBase(name, normalized);
  };

  const pushActionRecord = (record: LoopDetectorActionRecord): void => {
    actionHistory.push(record);
    if (actionHistory.length > loopDetectionWindow) {
      actionHistory.shift();
    }
  };

  const countTrailingMatches = (params: {
    signature: string;
    selector: (record: LoopDetectorActionRecord) => string;
  }): number => {
    const { signature, selector } = params;
    let count = 0;
    for (let i = actionHistory.length - 1; i >= 0; i--) {
      if (selector(actionHistory[i]) === signature) {
        count++;
      } else {
        break;
      }
    }
    return count;
  };

  const checkRepeatedFailures = (
    functionName: string | undefined
  ): DetectLoopResult => {
    if (!functionName) {
      return null;
    }

    const recentFailures = actionHistory
      .slice(-5)
      .filter(
        (r) => r.functionName === functionName && r.result?.success === false
      );

    if (recentFailures.length >= 3) {
      warn(
        `🔴 Loop detected: ${functionName} failed ${recentFailures.length} times`
      );
      return recentFailures[recentFailures.length - 1];
    }

    return null;
  };

  const checkSignatureRepeat = (params: {
    signature: string;
    signatureName: string;
    selector: (record: LoopDetectorActionRecord) => string;
    recordToReturn: LoopDetectorActionRecord;
  }): DetectLoopResult => {
    const { signature, signatureName, selector, recordToReturn } = params;
    const count = countTrailingMatches({ signature, selector });
    if (count > maxIdenticalActions) {
      warn(
        `🔴 Loop detected: ${signatureName} signature repeated ${count} consecutive times`
      );
      return recordToReturn;
    }
    return null;
  };

  const detectLoop: DetectLoopFn = (
    functionCalls: Array<{ name: string; args: Record<string, unknown> }>
  ): DetectLoopResult => {
    const exactSig = functionCalls
      .map((fc) => getSortedArgsSignature(fc.name, fc.args))
      .join('|');

    const normalizedSig = functionCalls
      .map((fc) => getSortedNormalizedArgsSignature(fc.name, fc.args))
      .join('|');

    const record: LoopDetectorActionRecord = {
      signature: exactSig,
      normalizedSignature: normalizedSig,
      timestamp: now(),
      functionName: functionCalls[0]?.name || 'unknown',
      args: functionCalls[0]?.args || {},
    };

    pushActionRecord(record);

    const failureLoop = checkRepeatedFailures(functionCalls[0]?.name);
    if (failureLoop) {
      return failureLoop;
    }

    const normalizedLoop = checkSignatureRepeat({
      signature: normalizedSig,
      signatureName: 'Normalized',
      selector: (r) => r.normalizedSignature,
      recordToReturn: record,
    });
    if (normalizedLoop) {
      return normalizedLoop;
    }

    const exactLoop = checkSignatureRepeat({
      signature: exactSig,
      signatureName: 'Exact',
      selector: (r) => r.signature,
      recordToReturn: record,
    });
    if (exactLoop) {
      return exactLoop;
    }

    return null;
  };

  return { detectLoop, actionHistory };
}
