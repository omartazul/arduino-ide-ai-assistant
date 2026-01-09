import { SpectreAiResponse } from '../common/protocol/spectre-ai-service';
import { TIMING_CONSTANTS } from '../common/protocol/spectre-types';
import { classifyError } from './spectre-ai-error-utils';
import {
  clampOutputTokens,
  getOptimalTemperature,
} from './spectre-ai-request-utils';

export function buildStandardGenConfig(params: {
  model: string;
  isAgentMode: boolean;
  generationConfig: any;
  thinkingBudget: number | undefined;
  maxOutputTokensCap: number;
}): any {
  const { model, isAgentMode, generationConfig, thinkingBudget, maxOutputTokensCap } =
    params;

  const optimalTemperature = getOptimalTemperature(isAgentMode, model);
  const genConfig: any = {
    temperature: optimalTemperature,
    topP: 0.95,
    maxOutputTokens: clampOutputTokens(
      generationConfig?.maxOutputTokens,
      maxOutputTokensCap
    ),
    ...generationConfig,
  };

  validateSamplingConfig(genConfig, optimalTemperature);
  applyThinkingConfig(genConfig, thinkingBudget, generationConfig);

  return genConfig;
}

export function applyThoughtSummary(
  res: SpectreAiResponse,
  includeThoughts: boolean | undefined
): void {
  if (!includeThoughts) {
    return;
  }
  if (!res.meta) {
    return;
  }
  if (!res.meta.thoughtsTokens) {
    return;
  }
  if (res.meta.thoughtSummary) {
    return;
  }
  res.meta.thoughtSummary = 'Thinking process applied (summary unavailable).';
}

export function decideStandardGenerationRetry(params: {
  err: unknown;
  msg: string;
  attempt: number;
  maxRetries: number;
  triedNoThinking: boolean;
  triedNoGoogleSearch: boolean;
}):
  | { action: 'retry-no-thinking' }
  | { action: 'retry-no-google-search' }
  | { action: 'retry'; backoffMs: number; delta: string }
  | { action: 'throw'; message: string } {
  const { err, msg, attempt, maxRetries, triedNoThinking, triedNoGoogleSearch } =
    params;

  if (!triedNoThinking && /Unknown name \"thinkingConfig\"/i.test(msg)) {
    return { action: 'retry-no-thinking' };
  }

  if (!triedNoGoogleSearch && /Unknown|google_search|googleSearch|tool/i.test(msg)) {
    return { action: 'retry-no-google-search' };
  }

  const { category, retryable, message } = classifyError(err);
  if (category === 'auth') {
    return {
      action: 'throw',
      message: 'Gemini authentication failed. Check API key.',
    };
  }
  if (category === 'quota') {
    return { action: 'throw', message: 'Remote quota exhausted.' };
  }
  if (retryable && attempt < maxRetries) {
    const isServiceIssue = /overloaded|503|Failed to parse stream|Error fetching/i.test(
      message
    );
    const baseDelay = isServiceIssue
      ? TIMING_CONSTANTS.SERVICE_OVERLOAD_BASE_DELAY
      : TIMING_CONSTANTS.NETWORK_RETRY_BASE_DELAY;
    const backoffMs = baseDelay * Math.pow(2, attempt);
    const delta = `${
      isServiceIssue ? 'Service overloaded' : 'Network error'
    } - retrying in ${(backoffMs / 1000).toFixed(1)}s...\n`;

    return { action: 'retry', backoffMs, delta };
  }

  return { action: 'throw', message: `Gemini request failed: ${message}` };
}

function validateSamplingConfig(genConfig: any, defaultTemperature: number) {
  const temp = genConfig.temperature;
  const isNumberTemp = typeof temp === 'number';
  const isValidTemperature = isNumberTemp && temp >= 0 && temp <= 2;
  if (!isValidTemperature) {
    genConfig.temperature = defaultTemperature;
  }

  const topP = genConfig.topP;
  const isNumberTopP = typeof topP === 'number';
  const isValidTopP = isNumberTopP && topP > 0 && topP <= 1;
  if (!isValidTopP) {
    genConfig.topP = 0.95;
  }
}

function applyThinkingConfig(
  genConfig: any,
  thinkingBudget: number | undefined,
  generationConfig: any
): void {
  let effectiveBudget =
    typeof thinkingBudget === 'number'
      ? thinkingBudget
      : (generationConfig as any)?.thinking?.budgetTokens;
  if (effectiveBudget === undefined) effectiveBudget = -1;
  if (effectiveBudget !== 0) {
    genConfig.thinkingConfig = { thinkingBudget: effectiveBudget };
  }
}
