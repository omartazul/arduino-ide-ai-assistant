/**
 * Memory Manager for Dynamic Conversation Retention
 *
 * Implements intelligent memory management with:
 * - Rolling buffer for recent messages (full fidelity)
 * - Automatic summarization of older messages
 * - Periodic compression of memory bank
 * - Token-aware prompt assembly
 *
 * @author Tazul Islam
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { ConversationMemory, RawMessage } from './memory-types';
import { TokenCounter } from '../utils/token-counter';
import { SpectreAiService } from '../../../common/protocol/spectre-ai-service';
import {
  spectreLog,
  spectreWarn,
  spectreError,
} from '../../../common/protocol/spectre-types';

function withTokenCount<
  T extends { text?: string; summary?: string; estimatedTokens?: number }
>(obj: T, contentType?: 'code' | 'json' | 'natural' | 'mixed'): T {
  if (obj.estimatedTokens === undefined) {
    const text = obj.text || obj.summary || '';
    obj.estimatedTokens = TokenCounter.estimate(text, contentType);
  }
  return obj;
}

type MemoryConfig = ConversationMemory['config'];
type SummaryEntry = ConversationMemory['memoryBank']['summaries'][number];

type TokenCount = {
  total: number;
  breakdown: {
    recentMessages: number;
    memoryBank: number;
    currentPrompt: number;
    systemPrompt: number;
  };
};

interface PromptAssemblyOptions {
  currentPrompt: string;
  additionalContext?: string;
  pinMessages?: string[];
  targetTokenBudget?: number;
}

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxRecentMessages: 40, // 20 turns (user + assistant pairs) - increased from 30
  memoryBankTokenCap: 100_000, // Still well below 1M limit, allows richer history
  summarizationTrigger: {
    minMessages: 30, // Summarize when buffer has 30+ messages (was 20)
    maxTokens: 25_000, // Or when recent messages > 25k tokens (was 15k)
  },
  compressionTrigger: {
    threshold: 0.9, // Compress when memory bank reaches 90% of cap
  },
};

@injectable()
export class MemoryManager {
  @inject(SpectreAiService)
  private readonly aiService!: SpectreAiService;

  /**
   * Creates a new conversation memory structure.
   */
  createConversation(
    sessionId: string,
    config?: Partial<MemoryConfig>
  ): ConversationMemory {
    return {
      sessionId,
      recentMessages: [],
      memoryBank: {
        summaries: [],
        totalTokens: 0,
        version: 1,
      },
      config: { ...DEFAULT_MEMORY_CONFIG, ...config },
      stats: {
        totalInteractions: 0,
        summarizationsPerformed: 0,
      },
    };
  }

  /**
   * Adds a new message to conversation memory.
   * Automatically triggers summarization if thresholds are exceeded.
   */
  async addMessage(
    memory: ConversationMemory,
    role: 'user' | 'assistant',
    text: string,
    parts?: any[]
  ): Promise<void> {
    const message: RawMessage = withTokenCount(
      {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role,
        text,
        parts,
        timestamp: Date.now(),
      },
      role === 'user' ? 'mixed' : 'natural'
    );

    memory.recentMessages.push(message);
    memory.stats.totalInteractions++;

    // Check if summarization is needed
    await this.checkAndSummarize(memory);
  }

  /**
   * Checks if summarization should be triggered and performs it.
   */
  private async checkAndSummarize(memory: ConversationMemory): Promise<void> {
    const { config, recentMessages } = memory;
    const trigger = config.summarizationTrigger;

    // Don't summarize if we haven't reached minimum messages
    if (recentMessages.length < trigger.minMessages) {
      return;
    }

    // Calculate total tokens in recent messages
    const recentTokens = recentMessages.reduce(
      (sum, msg) => sum + (msg.estimatedTokens || 0),
      0
    );

    // Trigger if either condition is met
    const shouldSummarize =
      recentMessages.length > config.maxRecentMessages ||
      recentTokens > trigger.maxTokens;

    if (shouldSummarize) {
      await this.summarizeOldMessages(memory);
    }
  }

  /**
   * Summarizes old messages and moves them to memory bank.
   * Keeps most recent messages in rolling buffer.
   */
  private async summarizeOldMessages(
    memory: ConversationMemory
  ): Promise<void> {
    const { config, recentMessages } = memory;

    // Keep most recent N messages, summarize the rest
    const keepCount = Math.floor(config.maxRecentMessages * 0.6); // Keep 60% of max
    const toSummarize = recentMessages.slice(
      0,
      recentMessages.length - keepCount
    );

    if (toSummarize.length === 0) {
      return;
    }

    try {
      const summary = await this.generateSummary(toSummarize);

      if (summary) {
        // Add summary to memory bank
        memory.memoryBank.summaries.push(summary);
        memory.memoryBank.totalTokens += summary.estimatedTokens || 0;

        // Remove summarized messages from recent buffer
        memory.recentMessages = recentMessages.slice(
          recentMessages.length - keepCount
        );

        memory.stats.summarizationsPerformed++;
        memory.stats.lastSummarizedAt = Date.now();

        await this.checkAndCompressMemoryBank(memory);
      }
    } catch (error) {
      spectreError('Failed to summarize messages:', error);
      // Keep messages in rolling buffer if summarization fails
    }
  }

  /**
   * Generates a concise summary of messages using Gemini.
   * Focuses on key intents, decisions, and code changes.
   */
  private async generateSummary(
    messages: RawMessage[]
  ): Promise<SummaryEntry | null> {
    if (messages.length === 0) return null;

    // Build conversation text with better formatting
    const conversationText = messages
      .map((msg, idx) => {
        const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
        return `${role} [${idx + 1}]:\n${msg.text}`;
      })
      .join('\n\n---\n\n');

    // Enhanced summarization prompt with structured output
    const summarizationPrompt = `You are a memory compression expert for Arduino development conversations. Analyze the following conversation and create an ULTRA-CONCISE summary.

**WHAT TO PRESERVE (Priority Order):**
1. 🎯 **User Goals**: What project is being built? What problem are they solving?
2. ⚙️ **Technical Specs**: Board model, pins used, baud rates, specific library versions
3. 💻 **Code State**: Key variables, functions created/modified, important logic
4. 🔧 **Decisions Made**: Why certain approaches were chosen over alternatives
5. ❌ **Errors Fixed**: What broke and how it was resolved
6. 💡 **Key Learnings**: Important insights or patterns discovered

**WHAT TO DISCARD:**
- Greetings, thanks, pleasantries
- Explanations that are easily re-derivable
- Debugging steps that led nowhere
- Repeated acknowledgements

**FORMAT:**
Use structured bullet points with emoji tags for quick scanning:
- 🎯 Goal: [main objective]
- ⚙️ Hardware: [board, sensors, connections]
- 💻 Code: [key functions/variables]
- 🔧 Setup: [important configurations]
- ❌ Issues: [problems and solutions]

**TARGET: 50-70% compression (quality over quantity)**

---

**CONVERSATION:**
${conversationText}

---

**COMPRESSED MEMORY:**`;

    try {
      const response = await this.aiService.generate({
        prompt: summarizationPrompt,
        model: 'gemini-3.1-flash-lite', // Use lightweight model for fast summarization
        generationConfig: {
          maxOutputTokens: 2048, // Increased from 1024 for better summaries
          temperature: 0.2, // Lower for more consistency
        },
        abortKey: `summarize-${Date.now()}`,
      });

      if (!response.text || response.text.trim() === '') {
        return null;
      }

      const summary: SummaryEntry = withTokenCount(
        {
          id: `summary-${Date.now()}`,
          summary: response.text.trim(),
          originalMessageIds: messages.map((m) => m.id),
          createdAt: Date.now(),
          category: this.categorizeSummary(response.text),
        },
        'natural'
      );

      return summary;
    } catch (error) {
      spectreError('Summary generation failed:', error);
      return null;
    }
  }

  /**
   * Categorizes a summary for better retrieval (future enhancement).
   */
  private categorizeSummary(summaryText: string): SummaryEntry['category'] {
    const lower = summaryText.toLowerCase();

    if (
      lower.includes('function') ||
      lower.includes('code') ||
      lower.includes('sketch')
    ) {
      return 'code_change';
    } else if (
      lower.includes('board') ||
      lower.includes('port') ||
      lower.includes('configured')
    ) {
      return 'configuration';
    } else if (
      lower.includes('error') ||
      lower.includes('debug') ||
      lower.includes('fix')
    ) {
      return 'debugging';
    } else if (
      lower.includes('learn') ||
      lower.includes('explain') ||
      lower.includes('understand')
    ) {
      return 'learning';
    }

    return 'general';
  }

  /**
   * Checks if memory bank needs compression and performs it.
   */
  private async checkAndCompressMemoryBank(
    memory: ConversationMemory
  ): Promise<void> {
    const { config, memoryBank } = memory;
    const threshold =
      config.memoryBankTokenCap * config.compressionTrigger.threshold;

    if (memoryBank.totalTokens > threshold) {
      await this.compressMemoryBank(memory);
    }
  }

  /**
   * Re-summarizes the memory bank into higher-level abstractions.
   * Preserves critical context while reducing token count.
   * IMPROVED: Keeps most recent summary separate, compresses older ones.
   */
  private async compressMemoryBank(memory: ConversationMemory): Promise<void> {
    const { memoryBank } = memory;

    if (memoryBank.summaries.length < 3) {
      return;
    }

    try {
      const { recentSummary, oldSummaries } =
        this.splitSummariesForCompression(memoryBank);
      const compressedSummary = await this.generateCompressedSummary(
        oldSummaries
      );

      if (compressedSummary) {
        this.updateMemoryBankWithCompression(
          memoryBank,
          compressedSummary,
          recentSummary,
          oldSummaries
        );
      }
    } catch (error) {
      spectreError('Memory bank compression failed:', error);
    }
  }

  /**
   * Splits summaries into recent (to keep) and old (to compress).
   */
  private splitSummariesForCompression(
    memoryBank: ConversationMemory['memoryBank']
  ): {
    recentSummary: SummaryEntry;
    oldSummaries: SummaryEntry[];
  } {
    const recentSummary = memoryBank.summaries[memoryBank.summaries.length - 1];
    const oldSummaries = memoryBank.summaries.slice(0, -1);
    return { recentSummary, oldSummaries };
  }

  /**
   * Generates a compressed summary from multiple old summaries.
   */
  private async generateCompressedSummary(
    oldSummaries: SummaryEntry[]
  ): Promise<SummaryEntry | null> {
    const combinedText = oldSummaries
      .map((s, idx) => `[Conversation Block ${idx + 1}]:\n${s.summary}`)
      .join('\n\n');

    const compressionPrompt = this.buildCompressionPrompt(combinedText);

    const response = await this.aiService.generate({
      prompt: compressionPrompt,
      model: 'gemini-3.1-flash-lite',
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.1,
      },
      abortKey: `compress-${Date.now()}`,
    });

    if (!response.text || response.text.trim() === '') {
      return null;
    }

    return withTokenCount(
      {
        id: `compressed-${Date.now()}`,
        summary: response.text.trim(),
        originalMessageIds: oldSummaries.flatMap((s) => s.originalMessageIds),
        createdAt: Date.now(),
        category: 'general' as const,
      },
      'natural'
    );
  }

  /**
   * Builds the compression prompt for meta-summarization.
   */
  private buildCompressionPrompt(combinedText: string): string {
    return `You are compressing long-term memory for an Arduino development assistant. The user has had an extended conversation with multiple topics.

**YOUR TASK:**
Create a PERSISTENT PROJECT MEMORY that captures:

1. 🏗️ **Project Identity**: What is being built? Core purpose?
2. 🔌 **Hardware Foundation**: Board, sensors, actuators, wiring
3. 🧩 **Key Libraries & Dependencies**: Installed and configured
4. 📋 **Established Patterns**: Reusable code structures
5. ⚠️ **Critical Learnings**: Important gotchas or best practices
6. 🎯 **Current State**: Where the project is now

**COMPRESSION PRINCIPLE:**
Think of this as a "project README" - someone reading this should understand:
- What's been accomplished
- Why certain choices were made
- What's important to remember going forward

**DO NOT include:**
- Step-by-step procedures (can be re-explained)
- Verbose explanations (keep it factual)
- Temporary debugging that's now resolved

---

**PREVIOUS CONVERSATION SUMMARIES:**
${combinedText}

---

**PERSISTENT PROJECT MEMORY (aim for 70-80% compression):**`;
  }

  /**
   * Updates memory bank with compressed summaries and logs results.
   */
  private updateMemoryBankWithCompression(
    memoryBank: ConversationMemory['memoryBank'],
    compressedSummary: SummaryEntry,
    recentSummary: SummaryEntry,
    oldSummaries: SummaryEntry[]
  ): void {
    memoryBank.summaries = [compressedSummary, recentSummary];
    memoryBank.totalTokens =
      (compressedSummary.estimatedTokens || 0) +
      (recentSummary.estimatedTokens || 0);
    memoryBank.lastCompressedAt = Date.now();

    const originalTokens = oldSummaries.reduce(
      (sum, s) => sum + (s.estimatedTokens || 0),
      0
    );
    const compressionRatio = Math.round(
      (1 - (compressedSummary.estimatedTokens || 0) / originalTokens) * 100
    );

    spectreLog(
      `✅ Compressed ${oldSummaries.length} old summaries to ${compressedSummary.estimatedTokens} tokens (${compressionRatio}% reduction)`
    );
    spectreLog(
      `📊 New memory bank: 2 summaries (compressed + recent), ${memoryBank.totalTokens} total tokens`
    );
  }

  /**
   * Assembles a prompt with memory bank + recent messages + current input.
   * Ensures total tokens stay within budget.
   */
  assemblePrompt(
    memory: ConversationMemory,
    options: PromptAssemblyOptions
  ): { prompt: string; tokenCount: TokenCount } {
    const {
      currentPrompt,
      additionalContext,
      targetTokenBudget = 50_000,
    } = options;

    const parts: string[] = [];
    let estimatedTokens = 0;

    // 1. Add memory bank summaries
    const memoryBankTokens = this.addMemoryBank(memory.memoryBank, parts);
    estimatedTokens += memoryBankTokens;

    // 2. Add recent messages
    const recentTokens = this.addRecentMessages(
      memory.recentMessages,
      parts,
      estimatedTokens,
      targetTokenBudget
    );
    estimatedTokens += recentTokens;

    // 3. Add additional context
    this.addAdditionalContext(
      additionalContext,
      parts,
      estimatedTokens,
      targetTokenBudget
    );

    // 4. Add current prompt
    parts.push(`[Current Request]:\n${currentPrompt}`);
    const currentTokens = TokenCounter.estimate(currentPrompt, 'mixed');
    estimatedTokens += currentTokens;

    const finalPrompt = parts.join('\n\n---\n\n');

    const tokenCount: TokenCount = {
      total: estimatedTokens,
      breakdown: {
        memoryBank: memoryBankTokens,
        recentMessages: recentTokens,
        currentPrompt: currentTokens,
        systemPrompt: 0,
      },
    };

    return { prompt: finalPrompt, tokenCount };
  }

  /**
   * Adds memory bank summaries to prompt parts.
   * Returns total tokens added.
   */
  private addMemoryBank(
    memoryBank: ConversationMemory['memoryBank'],
    parts: string[]
  ): number {
    if (memoryBank.summaries.length === 0) {
      return 0;
    }

    const memoryContext = memoryBank.summaries
      .map((s) => `[Historical Context]:\n${s.summary}`)
      .join('\n\n');

    parts.push(memoryContext);
    return memoryBank.totalTokens;
  }

  /**
   * Adds recent messages to prompt parts, working backwards to fit budget.
   * Returns total tokens added.
   */
  private addRecentMessages(
    recentMessages: RawMessage[],
    parts: string[],
    currentTokens: number,
    targetTokenBudget: number
  ): number {
    const recentContext: string[] = [];
    let addedTokens = 0;

    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const msg = recentMessages[i];
      const msgTokens =
        msg.estimatedTokens || TokenCounter.fastEstimate(msg.text);

      if (currentTokens + addedTokens + msgTokens > targetTokenBudget * 0.8) {
        break; // Leave room for current prompt
      }

      const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
      recentContext.unshift(`${roleLabel}: ${msg.text}`);
      addedTokens += msgTokens;
    }

    if (recentContext.length > 0) {
      parts.push('[Recent Conversation]:\n' + recentContext.join('\n\n'));
    }

    return addedTokens;
  }

  /**
   * Adds additional context if it fits within token budget.
   */
  private addAdditionalContext(
    additionalContext: string | undefined,
    parts: string[],
    currentTokens: number,
    targetTokenBudget: number
  ): void {
    if (!additionalContext || additionalContext.trim() === '') {
      return;
    }

    const contextTokens = TokenCounter.fastEstimate(additionalContext);
    if (currentTokens + contextTokens < targetTokenBudget * 0.9) {
      parts.push(additionalContext);
    } else {
      spectreWarn('Additional context too large, skipping');
    }
  }

  /**
   * Gets memory statistics for display.
   */
  getStats(memory: ConversationMemory): {
    recentMessages: number;
    summaries: number;
    totalTokens: number;
    memoryBankTokens: number;
    compressionRatio: string;
  } {
    const recentTokens = memory.recentMessages.reduce(
      (sum, m) => sum + (m.estimatedTokens || 0),
      0
    );

    const totalTokens = recentTokens + memory.memoryBank.totalTokens;
    const originalMessages = memory.stats.totalInteractions;
    const compressedMessages =
      memory.recentMessages.length + memory.memoryBank.summaries.length;

    const compressionRatio =
      originalMessages > 0
        ? `${compressedMessages}/${originalMessages}`
        : 'N/A';

    return {
      recentMessages: memory.recentMessages.length,
      summaries: memory.memoryBank.summaries.length,
      totalTokens,
      memoryBankTokens: memory.memoryBank.totalTokens,
      compressionRatio,
    };
  }
}
