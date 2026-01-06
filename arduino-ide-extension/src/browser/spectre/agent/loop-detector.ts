export interface LoopDetectorActionRecord {
  signature: string;
  normalizedSignature: string;
  timestamp: number;
  functionName: string;
  args: any;
  result?: { success: boolean; error?: string };
}

export type DetectLoopResult =
  | { signature: string; functionName: string; args: any }
  | null;

export type DetectLoopFn = (
  functionCalls: Array<{ name: string; args: any }>
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
    loopDetectionWindow = 5,
    maxIdenticalActions = 1,
  } = params;

  const actionHistory: Array<LoopDetectorActionRecord> = [];

  const normalizeArgs = (name: string, args: any): any => {
    const normalized: any = {};

    for (const key in args) {
      let value = args[key];

      if (typeof value === 'string') {
        value = value.toLowerCase().trim().replace(/\s+/g, ' ');

        if (name === 'select_board' || name === 'search_boards') {
          value = value.replace(/^arduino\s+/i, '').trim();
        } else if (name === 'install_library' || name === 'uninstall_library') {
          value = value.trim();
        } else if (name === 'select_port') {
          value = value.trim();
        }
      }

      normalized[key] = value;
    }

    return normalized;
  };

  const getSortedArgsSignature = (name: string, args: any): string => {
    const sortedArgs = Object.keys(args || {})
      .sort()
      .reduce((acc, key) => {
        acc[key] = args[key];
        return acc;
      }, {} as any);

    return `${name}:${JSON.stringify(sortedArgs)}`;
  };

  const getSortedNormalizedArgsSignature = (name: string, args: any): string => {
    const normalized = normalizeArgs(name, args || {});
    const sortedArgs = Object.keys(normalized)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalized[key];
        return acc;
      }, {} as any);

    return `${name}:${JSON.stringify(sortedArgs)}`;
  };

  const pushActionRecord = (record: LoopDetectorActionRecord): void => {
    actionHistory.push(record);
    if (actionHistory.length > loopDetectionWindow) {
      actionHistory.shift();
    }
  };

  const countBy = (selector: (record: LoopDetectorActionRecord) => string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const record of actionHistory) {
      const key = selector(record);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };

  const checkRepeatedFailures = (functionName: string | undefined): DetectLoopResult => {
    if (!functionName) {
      return null;
    }

    const recentFailures = actionHistory
      .slice(-5)
      .filter((r) => r.functionName === functionName && r.result?.success === false);

    if (recentFailures.length >= 3) {
      warn(`🔴 Loop detected: ${functionName} failed ${recentFailures.length} times`);
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
    const counts = countBy(selector);
    const count = counts.get(signature) || 0;
    if (count > maxIdenticalActions) {
      warn(`🔴 Loop detected: ${signatureName} signature repeated ${count} times`);
      return recordToReturn;
    }
    return null;
  };

  const detectLoop: DetectLoopFn = (
    functionCalls: Array<{ name: string; args: any }>
  ): DetectLoopResult => {
    const exactSig = functionCalls
      .map((fc) => getSortedArgsSignature(fc.name, fc.args))
      .join('|');

    const normalizedSig = functionCalls
      .map((fc) => getSortedNormalizedArgsSignature(fc.name, fc.args))
      .join('|');

    const record = {
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
