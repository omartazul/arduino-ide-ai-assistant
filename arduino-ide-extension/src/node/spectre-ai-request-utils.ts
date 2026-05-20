/**
 * Request shaping and model utilities for Spectre AI.
 *
 * Includes model capability resolution, token estimation, prompt building,
 * and helpers for mapping/validating supported endpoint models.
 *
 * @author Tazul Islam
 */

import {
  SpectreAiRequest,
  SpectreThinkingLevel,
} from '../common/protocol/spectre-ai-service';
import {
  AGENT_MODE_INSTRUCTION,
  BASIC_MODE_INSTRUCTION,
} from './spectre-ai-instructions';
import { normalizeThinkingLevel } from '../common/spectre-utils';

export const SUPPORTED_MODELS = [
  'gemini-3.1-flash-lite',
  'gemma-4-31b',
  'gemma-4-26b',
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

const AVAILABLE_MODELS: Record<SupportedModel, string> = {
  'gemini-3.1-flash-lite': 'gemini-3.1-flash-lite',
  'gemma-4-31b': 'gemma-4-31b-it',
  'gemma-4-26b': 'gemma-4-26b-a4b-it',
};

const MODEL_CAPABILITIES: Record<
  SupportedModel,
  { googleSearch: boolean; functionCalling: boolean; thinking: boolean }
> = {
  'gemini-3.1-flash-lite': {
    googleSearch: true,
    functionCalling: true,
    thinking: true,
  },
  'gemma-4-31b': { googleSearch: true, functionCalling: true, thinking: true },
  'gemma-4-26b': { googleSearch: true, functionCalling: true, thinking: true },
};

export function isSupportedModel(model: string | undefined): model is SupportedModel {
  if (!model) return false;
  return (SUPPORTED_MODELS as readonly string[]).includes(model);
}

export function resolveSupportedModel(model: string | undefined): SupportedModel {
  const resolved = model || 'gemini-3.1-flash-lite';
  if (isSupportedModel(resolved)) {
    return resolved;
  }
  throw new Error(
    `Unsupported model: ${model ?? 'undefined'}. Allowed models: ${SUPPORTED_MODELS.join(', ')}`
  );
}

export function supportsThinking(model: string): boolean {
  const resolved = resolveCapabilityModel(model);
  return resolved ? MODEL_CAPABILITIES[resolved].thinking : false;
}

export function supportsFunctionCalling(model: string): boolean {
  const resolved = resolveCapabilityModel(model);
  return resolved ? MODEL_CAPABILITIES[resolved].functionCalling : false;
}

export function supportsGoogleSearch(model: string): boolean {
  const resolved = resolveCapabilityModel(model);
  return resolved ? MODEL_CAPABILITIES[resolved].googleSearch : false;
}

function resolveCapabilityModel(model: string): SupportedModel | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes('gemini-3.1-flash-lite')) {
    return 'gemini-3.1-flash-lite';
  }
  if (normalized.includes('gemma-4-31b')) {
    return 'gemma-4-31b';
  }
  if (normalized.includes('gemma-4-26b')) {
    return 'gemma-4-26b';
  }
  return undefined;
}

/**
 * Maps supported model name to valid Gemini endpoint.
 */
export function mapModel(model: SupportedModel): string {
  return AVAILABLE_MODELS[model];
}

export function resolveThinkingLevelForModel(
  model: string,
  raw: string | undefined
): SpectreThinkingLevel | undefined {
  const normalized = normalizeThinkingLevel(raw);
  if (normalized === 'OFF') {
    return undefined;
  }
  const resolved = resolveCapabilityModel(model);
  if (!resolved || !MODEL_CAPABILITIES[resolved].thinking) {
    return undefined;
  }
  // Gemma 4 models only support OFF and HIGH. Map LOW/MEDIUM -> HIGH.
  if (resolved.startsWith('gemma-4-')) {
    return 'HIGH';
  }

  // Other models: respect user's selected (normalized) level
  return normalized;
}

export function getThinkingConfig(
  model: string,
  raw: string | undefined
): { thinkingLevel: SpectreThinkingLevel } | undefined {
  const level = resolveThinkingLevelForModel(model, raw);
  return level ? { thinkingLevel: level } : undefined;
}

/**
 * Builds final prompt with reasoning instruction.
 * Encourages step-by-step thinking for better quality responses.
 */
export function buildPrompt(
  userPrompt: string,
  thinkingLevel?: string
): string {
  if (normalizeThinkingLevel(thinkingLevel) === 'OFF') {
    return userPrompt;
  }
  return `Think step by step, then answer clearly.\n\n${userPrompt}`;
}

/**
 * Clamps output token limit to valid range.
 * Ensures requests stay within Gemini API constraints (max 65,536 tokens).
 * Defaults to 16,384 tokens for balanced response length and quota usage.
 */
export function clampOutputTokens(
  requested: number | undefined,
  maxOutputTokens = 65_536
): number {
  let val = typeof requested === 'number' && requested > 0 ? requested : 16384;
  val = Math.min(val, maxOutputTokens);
  return val;
}

/**
 * Delays execution for specified milliseconds.
 * Used for retry backoff and pacing.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Estimates token count using improved heuristics for different content types.
 *
 * Still not perfect (only a real tokenizer is), but reduces estimation error.
 */
export function estimateTokens(text: string): number {
  const clean = (text || '').trim();
  if (!clean) return 4;

  const len = clean.length;

  const hasCodeBlock = /```/.test(clean);
  const hasCode =
    hasCodeBlock ||
    /(?:function|class|const|let|var|return|if|for|while)\s*[\(\{]/.test(clean);
  const hasJson =
    /^\s*[\{\[]/.test(clean) || (clean.includes('\":') && clean.includes('{'));

  let baseTokens = 0;

  if (hasJson) {
    baseTokens = Math.ceil(len / 3);
  } else if (hasCode) {
    baseTokens = Math.ceil(len / 3.5);
  } else {
    const words = clean.split(/\s+/).length;
    baseTokens = Math.ceil(words * 1.3);

    const charBasedTokens = Math.ceil(len / 4.5);
    baseTokens = Math.max(baseTokens, charBasedTokens);
  }

  const overhead = 5;

  return Math.max(4, baseTokens + overhead);
}

export function estimateTotalInputTokens(request: SpectreAiRequest): number {
  let promptEstimate = 0;

  const systemInstruction =
    request.enableAgentMode === true
      ? AGENT_MODE_INSTRUCTION
      : BASIC_MODE_INSTRUCTION;
  promptEstimate += estimateTokens(systemInstruction);

  if (request.context?.conversation && request.context.conversation.length > 0) {
    for (const msg of request.context.conversation) {
      if ('text' in msg && msg.text) {
        promptEstimate += estimateTokens(msg.text);
      }
      if ('parts' in msg && msg.parts) {
        promptEstimate += estimateTokens(JSON.stringify(msg.parts));
      }
    }
  }

  promptEstimate += estimateTokens(request.prompt);

  return promptEstimate;
}

/**
 * Gets the timestamp for the start of today in Pacific Time.
 * Used for daily quota (RPD) tracking that resets at midnight PT.
 */
export function getPacificMidnight(): number {
  const now = new Date();
  const pacificTime = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
  );
  pacificTime.setHours(0, 0, 0, 0);
  return pacificTime.getTime();
}

/**
 * Temperature settings for different modes and models.
 */
const TEMPERATURE_CONFIG = {
  basicMode: {
    'gemini-3.1-flash-lite': 0.7,
    'gemma-4-31b': 0.8,
    'gemma-4-26b': 0.8,
  },
  agentMode: {
    'gemini-3.1-flash-lite': 0.3,
    'gemma-4-31b': 0.4,
    'gemma-4-26b': 0.4,
  },
} as const;

/**
 * Gets the optimal temperature for the current mode and model.
 */
export function getOptimalTemperature(isAgentMode: boolean, model: string): number {
  const config = isAgentMode
    ? TEMPERATURE_CONFIG.agentMode
    : TEMPERATURE_CONFIG.basicMode;

  const normalizedModel = model.toLowerCase();
  if (normalizedModel.includes('gemma-4-31b')) {
    return config['gemma-4-31b'];
  }
  if (normalizedModel.includes('gemma-4-26b')) {
    return config['gemma-4-26b'];
  }
  return config['gemini-3.1-flash-lite'];
}
