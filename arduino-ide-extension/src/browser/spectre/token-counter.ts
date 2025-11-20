/**
 * Token Counting Utilities for Spectre AI
 *
 * Provides accurate token estimation for Gemini models using
 * content-aware heuristics calibrated against actual API usage.
 *
 * For production use, consider integrating @google/generative-ai's
 * countTokens() method for exact counts.
 */

import { TokenCount } from './memory-types';

/**
 * Token estimation based on content type.
 * Calibrated against actual Gemini tokenization patterns.
 */
export class TokenCounter {
  /**
   * Estimates tokens for arbitrary text using content-aware heuristics.
   *
   * Heuristics (based on empirical testing):
   * - JSON/structured data: ~3 chars/token
   * - Code (C++/Arduino): ~3.5 chars/token
   * - Natural language: ~4.5 chars/token
   * - Mixed content: ~4 chars/token (conservative)
   *
   * @param text Text to estimate tokens for
   * @param contentType Optional hint about content type
   * @returns Estimated token count
   */
  static estimate(
    text: string,
    contentType?: 'code' | 'json' | 'natural' | 'mixed'
  ): number {
    if (!text || text.length === 0) return 0;

    const length = text.length;

    // Detect content type if not provided
    if (!contentType) {
      contentType = this.detectContentType(text);
    }

    // Apply content-specific estimation
    switch (contentType) {
      case 'json':
        // JSON is very token-dense due to structure
        return Math.ceil(length / 3);

      case 'code':
        // Code has moderate token density
        return Math.ceil(length / 3.5);

      case 'natural':
        // Natural language is least token-dense
        // For English: ~0.22 tokens/char on average
        const words = text.split(/\s+/).length;
        return Math.ceil(words * 1.3); // ~1.3 tokens per word

      case 'mixed':
      default:
        // Conservative estimate for mixed content
        return Math.ceil(length / 4);
    }
  }

  /**
   * Detects the predominant content type in text.
   */
  private static detectContentType(
    text: string
  ): 'code' | 'json' | 'natural' | 'mixed' {
    const sample = text.slice(0, 1000); // Analyze first 1k chars

    // JSON detection
    if (sample.match(/^\s*[\[{]/) && sample.match(/[\]}]\s*$/)) {
      const jsonChars = (sample.match(/[{}[\]:,]/g) || []).length;
      if (jsonChars / sample.length > 0.05) return 'json';
    }

    // Code detection (C++/Arduino patterns)
    const codePatterns = [
      /\b(void|int|float|char|bool|byte|String)\b/g,
      /\b(setup|loop|pinMode|digitalWrite|analogRead)\b/g,
      /#include\s*[<"]/g,
      /[(){};]/g,
    ];

    let codeScore = 0;
    for (const pattern of codePatterns) {
      const matches = sample.match(pattern);
      if (matches) codeScore += matches.length;
    }

    if (codeScore > sample.length * 0.02) return 'code';

    // Natural language (default for conversational text)
    const sentenceEndings = (sample.match(/[.!?]\s/g) || []).length;
    const words = sample.split(/\s+/).length;

    if (words > 10 && sentenceEndings / words > 0.05) return 'natural';

    return 'mixed';
  }

  /**
   * Counts tokens in a conversation with detailed breakdown.
   *
   * @param recentMessages Recent messages in rolling buffer
   * @param memoryBankSummaries Summaries from memory bank
   * @param currentPrompt Current user input
   * @param systemPrompt System prompt or additional context
   * @returns Token count with breakdown
   */
  static countConversation(
    recentMessages: Array<{ text: string; role: 'user' | 'assistant' }>,
    memoryBankSummaries: Array<{ summary: string }>,
    currentPrompt: string,
    systemPrompt?: string
  ): TokenCount {
    let recentTokens = 0;
    let memoryTokens = 0;

    // Count recent messages
    for (const msg of recentMessages) {
      const contentType = msg.role === 'assistant' ? 'natural' : 'mixed';
      recentTokens += this.estimate(msg.text, contentType);
    }

    // Count memory bank summaries
    for (const summary of memoryBankSummaries) {
      memoryTokens += this.estimate(summary.summary, 'natural');
    }

    const currentTokens = this.estimate(currentPrompt, 'mixed');
    const systemTokens = systemPrompt
      ? this.estimate(systemPrompt, 'natural')
      : 0;

    return {
      total: recentTokens + memoryTokens + currentTokens + systemTokens,
      breakdown: {
        recentMessages: recentTokens,
        memoryBank: memoryTokens,
        currentPrompt: currentTokens,
        systemPrompt: systemTokens,
      },
    };
  }

  /**
   * Estimates tokens for a sketch file with language detection.
   */
  static estimateSketchFile(filename: string, content: string): number {
    const ext = filename.split('.').pop()?.toLowerCase();

    const contentType =
      ext === 'ino' || ext === 'cpp' || ext === 'h'
        ? 'code'
        : ext === 'json'
        ? 'json'
        : 'mixed';

    return this.estimate(content, contentType);
  }

  /**
   * Fast approximation for quick checks (when precision isn't critical).
   * Uses simple 4 chars/token heuristic.
   */
  static fastEstimate(text: string): number {
    return Math.max(1, Math.ceil((text || '').length / 4));
  }

  /**
   * Formats token count for display.
   */
  static formatCount(count: number): string {
    if (count < 1_000) {
      return `${count}`;
    } else if (count < 10_000) {
      return `${(count / 1_000).toFixed(1)}k`;
    } else {
      return `${Math.round(count / 1_000)}k`;
    }
  }

  /**
   * Calculates percentage of budget used.
   */
  static percentageUsed(used: number, cap: number): number {
    return Math.round((used / cap) * 100);
  }
}

/**
 * Decorator to cache token counts on objects with estimatedTokens field.
 */
export function withTokenCount<
  T extends { text?: string; summary?: string; estimatedTokens?: number }
>(obj: T, contentType?: 'code' | 'json' | 'natural' | 'mixed'): T {
  if (obj.estimatedTokens === undefined) {
    const text = obj.text || obj.summary || '';
    obj.estimatedTokens = TokenCounter.estimate(text, contentType);
  }
  return obj;
}
