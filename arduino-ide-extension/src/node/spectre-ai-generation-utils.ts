/**
 * Generation configuration and retry helpers for Spectre AI requests.
 *
 * Builds standardized generation configs, validates sampling parameters,
 * and decides retry/backoff behavior for failed generation attempts.
 *
 * @author Tazul Islam
 */

import { SpectreAiResponse } from '../common/protocol/spectre-ai-service';
import { TIMING_CONSTANTS } from '../common/protocol/spectre-types';
import { classifyError } from './spectre-ai-error-utils';
import {
  clampOutputTokens,
  getThinkingConfig,
  getOptimalTemperature,
} from './spectre-ai-request-utils';

export function buildStandardGenConfig(params: {
  model: string;
  isAgentMode: boolean;
  generationConfig: any;
  thinkingLevel: string | undefined;
  maxOutputTokensCap: number;
}): any {
  const { model, isAgentMode, generationConfig, thinkingLevel, maxOutputTokensCap } =
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
  const thinkingConfig = getThinkingConfig(model, thinkingLevel);
  if (thinkingConfig) {
    genConfig.thinkingConfig = thinkingConfig;
  } else if ('thinkingConfig' in genConfig) {
    delete genConfig.thinkingConfig;
  }

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
  attempt: number;
  maxRetries: number;
}):
  | { action: 'retry'; backoffMs: number; delta: string }
  | { action: 'throw'; message: string } {
  const { err, attempt, maxRetries } = params;

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
