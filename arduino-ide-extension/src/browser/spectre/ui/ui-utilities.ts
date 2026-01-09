/**
 * UI Utilities
 *
 * This file consolidates legacy modules:
 * - ui-utilities.ts
 * - widget-utilities.ts
 * - inline-diff.ts
 *
 * @author Tazul Islam
 */

import type { SpectreAiService } from '../../../common/protocol/spectre-ai-service';
import {
  spectreError,
  spectreWarn,
} from '../../../common/protocol/spectre-types';
import { UIHelper } from './ui-helper';

// ============================================================================
// DOM Helpers
// ============================================================================

/**
 * Schedules a scroll-to-bottom after DOM updates.
 * Uses double rAF to be more reliable across render cycles.
 */
export function deferScrollToBottom(
  root: HTMLElement | undefined,
  selector: string
): void {
  if (!root) return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => scrollToBottom(root, selector));
  });
}

/**
 * Scrolls the selected container to its bottom.
 */
export function scrollToBottom(root: HTMLElement, selector: string): void {
  const container = root.querySelector(selector) as HTMLElement | null;
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}

/**
 * Auto-grows a textarea up to a max height.
 */
export function autoGrowTextArea(
  el: HTMLTextAreaElement | null,
  maxHeight = 300
): void {
  if (!el) return;
  el.style.height = 'auto';
  const newHeight = Math.min(maxHeight, el.scrollHeight);
  el.style.height = newHeight + 'px';
}

// ============================================================================
// Code Block Parsing
// ============================================================================

export type CodeBlock = {
  code: string;
  type: 'block' | 'inline';
  language?: string;
};

// Supports fenced blocks with optional language tag.
const FENCED_CODE_BLOCK_REGEX =
  /```(?:(cpp|c|arduino|ino|javascript|python|js|py))?\n([\s\S]*?)```/g;

/**
 * Extracts explicit code blocks from text.
 */
export function extractExplicitCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = FENCED_CODE_BLOCK_REGEX.exec(text)) !== null) {
    blocks.push({
      code: match[2].trim(),
      type: 'block',
      language: match[1] || 'cpp',
    });
  }

  return blocks;
}

// Matches only Arduino-ish fenced blocks for suppression purposes.
export const ARDUINO_FENCED_BLOCK_REGEX =
  /```(?:cpp|c|arduino|ino)\n([\s\S]*?)\n```/gi;

// Looser matcher used when splitting text around fenced blocks.
export const ANY_FENCED_BLOCK_SPLIT_REGEX =
  /```(?:cpp|c|arduino|ino)?\n?([\s\S]*?)\n?```/g;

// ============================================================================
// Clock Management
// ============================================================================

export interface ClockStateData {
  now: number;
  requestLogs: Array<{ timestamp: number }>;
  dailyTracker: { date: string; requestCount: number; tokenCount: number };
}

/**
 * Starts a clock ticker that updates state periodically.
 */
export function restartClock(params: {
  existingTicker: number | undefined;
  stateData: ClockStateData;
  getPacificDate: () => string;
  persistTrackingData: () => void;
  update: () => void;
}): number {
  const { existingTicker, stateData } = params;
  if (existingTicker) {
    clearInterval(existingTicker);
  }

  return window.setInterval(() => {
    const now = Date.now();
    stateData.now = now;

    const sixtySecondsAgo = now - 60 * 1000;
    const originalLogCount = stateData.requestLogs.length;
    stateData.requestLogs = stateData.requestLogs.filter(
      (log) => log.timestamp > sixtySecondsAgo
    );

    const currentDate = params.getPacificDate();
    if (stateData.dailyTracker.date !== currentDate) {
      stateData.dailyTracker = {
        date: currentDate,
        requestCount: 0,
        tokenCount: 0,
      };
      params.persistTrackingData();
    }

    if (stateData.requestLogs.length !== originalLogCount) {
      params.persistTrackingData();
    }

    params.update();
  }, 1000);
}

/**
 * Stops a running clock ticker.
 */
export function stopClock(ticker: number | undefined): void {
  if (ticker) {
    clearInterval(ticker);
  }
}

// ============================================================================
// Quota Management
// ============================================================================

/**
 * Fetches and updates quota information for the current model.
 */
export async function refreshQuotaForCurrentModel(params: {
  ai: SpectreAiService;
  model: string;
  getFallbackRpmLimit: () => number;
  setStateData: (patch: Partial<any>) => void;
}): Promise<void> {
  try {
    const quota = await params.ai.getQuota(params.model);
    params.setStateData({
      quotaUsed: quota.usedTokens,
      quotaCapacity: quota.capacity,
      rpmUsed: quota.rpmUsed,
      rpmLimit: quota.rpmLimit,
      queueSize: quota.queued,
      nextAvailableMs: quota.nextAvailableMs,
    });
  } catch (error) {
    spectreWarn(
      'Failed to fetch quota from backend, using client-calculated RPM limit:',
      error
    );
    params.setStateData({ rpmLimit: params.getFallbackRpmLimit() });
  }
}

// ============================================================================
// Inline Diff
// ============================================================================

export interface InlineDiffTiming {
  DECORATION_AUTO_REMOVE: number;
}

export interface InlineDiffContext {
  editorManager: { open(uri: any): Promise<any> };
  decorationTimers: Set<number>;
  timing: InlineDiffTiming;
}

export interface ShowInlineDiffParams {
  uri: any;
  oldCode: string;
  newCode: string;
}

/**
 * Applies an inline diff visualization (Keep/Undo style) and schedules auto-removal of decorations.
 * Also writes the new content into the editor model.
 */
export async function showInlineDiff(
  ctx: InlineDiffContext,
  params: ShowInlineDiffParams
): Promise<void> {
  const { uri, oldCode, newCode } = params;
  const monaco = await getMonacoControl(ctx, uri);
  if (!monaco) return;

  const { control, model } = monaco;
  const oldLines = oldCode.split('\n');
  const newLines = newCode.split('\n');

  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: newCode }],
    () => null
  );

  const { decorations, contentWidgets } = UIHelper.computeDiffElements(
    oldLines,
    newLines
  );
  const decorationIds = control.deltaDecorations([], decorations);
  const zoneIds = UIHelper.createViewZones(control, contentWidgets);

  control.pushUndoStop();
  control.focus();

  scheduleDecorationsRemoval(ctx, control, decorationIds, zoneIds);
}

async function getMonacoControl(
  ctx: InlineDiffContext,
  uri: any
): Promise<{ control: any; model: any } | null> {
  const editor = await ctx.editorManager.open(uri);
  if (!editor) {
    spectreError('Could not open editor');
    return null;
  }

  const monacoEditor = editor.editor;
  if (!('getControl' in monacoEditor)) {
    spectreError('Not a Monaco editor');
    return null;
  }

  const control = (monacoEditor as any).getControl();
  const model = control.getModel();
  if (!model) {
    spectreError('No model found');
    return null;
  }

  return { control, model };
}

function scheduleDecorationsRemoval(
  ctx: InlineDiffContext,
  control: any,
  decorationIds: string[],
  zoneIds: string[]
): void {
  const timerId = window.setTimeout(() => {
    ctx.decorationTimers.delete(timerId);
    control.deltaDecorations(decorationIds, []);
    control.changeViewZones((changeAccessor: any) => {
      zoneIds.forEach((zoneId) => changeAccessor.removeZone(zoneId));
    });
  }, ctx.timing.DECORATION_AUTO_REMOVE);

  ctx.decorationTimers.add(timerId);
}
