/**
 * Agent-mode upload helpers.
 *
 * @author Tazul Islam
 */

import { spectreWarn } from '../../../common/protocol/spectre-types';
import { DetectedPort } from '../../../common/protocol/boards-service';
import { Sketch } from '../../../common/protocol/sketches-service';
import { CurrentSketch } from '../../sketches-service-client-impl';
import { BoardHelper } from '../board/board-helpers';
import { UploadHelper } from '../feature/upload-helper';

export interface UploadToolsTiming {
  COMPILATION_TIMEOUT: number;
  UPLOAD_START_DELAY: number;
  COMPILATION_CHECK_DELAY: number;
  UPLOAD_PROCESS_DELAY: number;
  SKETCH_SAVE_DELAY: number;
}

export interface UploadToolsContext {
  delay(ms: number): Promise<void>;
  timing: UploadToolsTiming;

  readArduinoOutputChannel(): Promise<string>;
  commands: {
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  };
  sketchesClient: { currentSketch(): Promise<Sketch> };

  validateBoardAndPort(requirePort?: boolean): {
    valid: boolean;
    message?: string;
  };

  boardsServiceProvider: {
    boardsConfig: {
      selectedPort?: { address: string; protocol: string } | undefined;
    };
    detectedPorts?: Record<string, DetectedPort> | undefined;
    updateConfig(params: unknown): Promise<unknown>;
  };

  monitorManagerProxy: {
    isWSConnected(): Promise<boolean>;
    disconnect(): void;
    startMonitor(): Promise<void>;
  };
}

type UploadAttempt = {
  ok: boolean;
  errText?: string;
  diff?: string;
  shouldRetry?: boolean;
  analysis?: ReturnType<typeof UploadHelper.analyzeUploadOutput>;
};

type UploadCommandResult =
  | { success: true }
  | { success: false; result: UploadAttempt };

export async function agentUploadSketch(
  ctx: UploadToolsContext
): Promise<string> {
  await ctx.delay(ctx.timing.SKETCH_SAVE_DELAY);

  const sketch = await validateCurrentSketch(ctx);
  validateUploadEnvironment(ctx);

  return await withMonitorDisconnected(ctx, async () => {
    return await executeUploadWithRetry(ctx, sketch);
  });
}

async function validateCurrentSketch(
  ctx: Pick<UploadToolsContext, 'sketchesClient'>
): Promise<Sketch> {
  const sketch = await ctx.sketchesClient.currentSketch();
  if (!CurrentSketch.isValid(sketch)) {
    throw new Error('No valid sketch is currently open');
  }
  return sketch;
}

function validateUploadEnvironment(
  ctx: Pick<UploadToolsContext, 'validateBoardAndPort'>
): void {
  const validation = ctx.validateBoardAndPort(true);
  if (!validation.valid) {
    throw new Error(validation.message || 'Unknown validation error');
  }
}

async function executeUploadWithRetry(
  ctx: UploadToolsContext,
  sketch: Sketch
): Promise<string> {
  const attempt = await attemptUploadOnCurrentPort(ctx);
  if (attempt.ok) {
    return `✅ Sketch uploaded successfully to board: ${sketch.name}`;
  }

  return await handleUploadFailure(ctx, attempt);
}

async function handleUploadFailure(
  ctx: UploadToolsContext,
  attempt: UploadAttempt
): Promise<string> {
  const firstErr = attempt.errText || '';

  if (
    attempt.shouldRetry ||
    BoardHelper.isPortRelatedError(firstErr, attempt.shouldRetry)
  ) {
    const retryResult = await retryUploadOnAlternatePorts(ctx, firstErr);
    if (retryResult.ok) {
      return `✅ Sketch uploaded successfully on alternate port ${retryResult.address}.`;
    }
  }

  throw UploadHelper.formatUploadError(
    firstErr || 'Upload failed with unknown error.'
  );
}

async function attemptUploadOnCurrentPort(
  ctx: UploadToolsContext
): Promise<UploadAttempt> {
  const before = await ctx.readArduinoOutputChannel();

  const commandResult = await executeUploadCommand(ctx);
  if (!commandResult.success) {
    return commandResult.result;
  }

  await ctx.delay(ctx.timing.COMPILATION_TIMEOUT);
  const firstAttempt = await analyzeUploadAttempt(ctx, before);
  if (firstAttempt.ok) {
    return firstAttempt;
  }

  await ctx.delay(ctx.timing.UPLOAD_START_DELAY);
  return await analyzeUploadAttempt(ctx, before, firstAttempt);
}

async function executeUploadCommand(
  ctx: Pick<UploadToolsContext, 'commands'>
): Promise<UploadCommandResult> {
  try {
    await ctx.commands.executeCommand('arduino-upload-sketch');
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      result: { ok: false, errText: msg, shouldRetry: false },
    };
  }
}

async function analyzeUploadAttempt(
  ctx: Pick<UploadToolsContext, 'readArduinoOutputChannel'>,
  before: string,
  previousAttempt?: UploadAttempt
): Promise<UploadAttempt> {
  const after = await ctx.readArduinoOutputChannel();
  const diff = computeOutputDiff(before, after);
  const analysis = UploadHelper.analyzeUploadOutput(diff);

  if (analysis.success) {
    return { ok: true, diff, shouldRetry: false };
  }

  if (shouldAssumeSuccess(previousAttempt, analysis)) {
    return { ok: true, diff, shouldRetry: false };
  }

  if (previousAttempt) {
    return buildFinalUploadFailure(analysis, previousAttempt, diff);
  }

  return { ok: false, analysis, diff };
}

function computeOutputDiff(before: string, after: string): string {
  return after.startsWith(before) ? after.slice(before.length) : after;
}

function shouldAssumeSuccess(
  previousAttempt: UploadAttempt | undefined,
  analysis: ReturnType<typeof UploadHelper.analyzeUploadOutput>
): boolean {
  return !previousAttempt && hasNoErrorIndicators(analysis.error);
}

function buildFinalUploadFailure(
  analysis: ReturnType<typeof UploadHelper.analyzeUploadOutput>,
  previousAttempt: UploadAttempt,
  diff: string
): UploadAttempt {
  const finalError =
    analysis.error ||
    previousAttempt.analysis?.error ||
    'Upload failed with unclear error';
  const shouldRetry =
    analysis.shouldRetry ?? previousAttempt.analysis?.shouldRetry ?? false;
  return { ok: false, errText: finalError, diff, shouldRetry };
}

function hasNoErrorIndicators(error: string | undefined): boolean {
  if (!error) return true;
  const errorLower = error.toLowerCase();
  return (
    !errorLower.includes('error') &&
    !errorLower.includes('failed') &&
    !errorLower.includes('timeout')
  );
}

function getAlternateSerialPorts(
  ctx: Pick<UploadToolsContext, 'boardsServiceProvider'>
): DetectedPort[] {
  const cfg = ctx.boardsServiceProvider.boardsConfig;
  const currentPort = cfg.selectedPort;
  const detected = Object.values(ctx.boardsServiceProvider.detectedPorts || {});

  const serialPorts = detected.filter(
    (dp): dp is DetectedPort => !!dp?.port && dp.port.protocol === 'serial'
  );

  return BoardHelper.getAlternateSerialPorts(serialPorts, currentPort?.address);
}

async function retryUploadOnAlternatePorts(
  ctx: UploadToolsContext,
  firstErr: string
): Promise<{ ok: boolean; errText?: string; address?: string }> {
  const candidates = getAlternateSerialPorts(ctx);

  if (candidates.length === 0) {
    throw new Error(
      `Upload failed due to port issues, but no alternate ports available.\n\nError: ${firstErr}`
    );
  }

  return await tryAlternatePorts(ctx, candidates, firstErr);
}

async function tryAlternatePorts(
  ctx: UploadToolsContext,
  candidates: DetectedPort[],
  firstErr: string
): Promise<{ ok: boolean; errText?: string; address?: string }> {
  const tried: string[] = [];

  for (const cand of candidates) {
    const attemptResult = await tryUploadOnPort(ctx, cand);
    tried.push(attemptResult.address);

    const decision = decideAfterAlternateAttempt(attemptResult, tried.length);
    if (decision) {
      return decision;
    }
  }

  throwAllPortsFailed(firstErr, tried);
}

function decideAfterAlternateAttempt(
  attemptResult: {
    ok: boolean;
    address: string;
    errText?: string;
    shouldStop: boolean;
  },
  triedCount: number
): { ok: boolean; errText?: string; address?: string } | null {
  if (attemptResult.ok) {
    return { ok: true, address: attemptResult.address };
  }

  if (attemptResult.shouldStop) {
    return { ok: false, errText: attemptResult.errText };
  }

  if (triedCount >= 2) {
    return { ok: false, errText: attemptResult.errText };
  }

  return null;
}

function throwAllPortsFailed(firstErr: string, tried: string[]): never {
  const triedMsg = tried.length ? ` Tried ports: ${tried.join(', ')}.` : '';
  throw new Error(
    `Upload failed on all available ports.${triedMsg}\n\nLast error: ${firstErr}`
  );
}
async function tryUploadOnPort(
  ctx: UploadToolsContext,
  cand: DetectedPort
): Promise<{
  ok: boolean;
  address: string;
  errText?: string;
  shouldStop: boolean;
}> {
  const addr = cand.port.address;

  ctx.boardsServiceProvider.updateConfig({
    protocol: cand.port.protocol,
    address: addr,
  });

  await ctx.delay(ctx.timing.UPLOAD_PROCESS_DELAY);

  const attempt = await attemptUploadOnCurrentPort(ctx);
  if (attempt.ok) {
    return { ok: true, address: addr, shouldStop: true };
  }

  const shouldStop = shouldStopPortRetries(attempt);
  return { ok: false, address: addr, errText: attempt.errText, shouldStop };
}

function shouldStopPortRetries(attempt: UploadAttempt): boolean {
  const isPortRelated = (
    errText: string,
    shouldRetry: boolean | undefined
  ): boolean => {
    if (shouldRetry === false) return false;
    const portIndicators = [
      'port',
      'serial',
      'access denied',
      'permission',
      'device not found',
    ];
    return portIndicators.some((indicator) =>
      errText.toLowerCase().includes(indicator)
    );
  };

  return (
    attempt.shouldRetry === false ||
    !isPortRelated(attempt.errText || '', attempt.shouldRetry)
  );
}

async function withMonitorDisconnected<T>(
  ctx: Pick<UploadToolsContext, 'monitorManagerProxy' | 'delay' | 'timing'>,
  operation: () => Promise<T>
): Promise<T> {
  let restoreMonitor = false;
  try {
    restoreMonitor = await ctx.monitorManagerProxy.isWSConnected();
  } catch (err) {
    spectreWarn('Monitor connection check failed:', err);
  }

  if (restoreMonitor) {
    try {
      ctx.monitorManagerProxy.disconnect();
    } catch (err) {
      spectreWarn('Monitor disconnect failed:', err);
    }
    await ctx.delay(ctx.timing.COMPILATION_CHECK_DELAY);
  }

  try {
    return await operation();
  } finally {
    if (restoreMonitor) {
      try {
        await ctx.monitorManagerProxy.startMonitor();
      } catch (err) {
        spectreWarn('Monitor restart failed:', err);
      }
    }
  }
}
