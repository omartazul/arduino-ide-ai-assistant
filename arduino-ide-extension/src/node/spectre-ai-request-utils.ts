import { SpectreAiRequest } from '../common/protocol/spectre-ai-service';
import {
  AGENT_MODE_INSTRUCTION,
  BASIC_MODE_INSTRUCTION,
} from './spectre-ai-instructions';

/**
 * Maps user-provided model name to valid Gemini endpoint.
 * Defaults to gemini-2.5-flash for unknown models.
 */
export function mapModel(model: string): string {
  return ['gemini-2.5-flash', 'gemini-2.5-flash-lite'].includes(model)
    ? model
    : 'gemini-2.5-flash';
}

/**
 * Builds final prompt with reasoning instruction.
 * Encourages step-by-step thinking for better quality responses.
 */
export function buildPrompt(userPrompt: string): string {
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
      if ('text' in msg) {
        promptEstimate += estimateTokens(msg.text);
      } else if ('parts' in msg) {
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
    'gemini-2.5-flash': 0.8,
    'gemini-2.5-flash-lite': 0.7,
  },
  agentMode: {
    'gemini-2.5-flash': 0.4,
    'gemini-2.5-flash-lite': 0.3,
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
  if (normalizedModel.includes('flash-lite') || normalizedModel.includes('flashlite')) {
    return config['gemini-2.5-flash-lite'];
  }
  if (normalizedModel.includes('flash')) {
    return config['gemini-2.5-flash'];
  }

  return config['gemini-2.5-flash'];
}
