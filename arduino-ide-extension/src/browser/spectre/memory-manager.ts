/**
 * Memory Manager for Dynamic Conversation Retention
 *
 * Implements intelligent memory management with:
 * - Rolling buffer for recent messages (full fidelity)
 * - Automatic summarization of older messages
 * - Periodic compression of memory bank
 * - Token-aware prompt assembly
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
  ConversationMemory,
  RawMessage,
  SummaryEntry,
  MemoryConfig,
  DEFAULT_MEMORY_CONFIG,
  PromptAssemblyOptions,
  TokenCount,
} from './memory-types';
import { TokenCounter, withTokenCount } from './token-counter';
import { SpectreAiService } from '../../common/protocol/spectre-ai-service';
import {
  spectreLog,
  spectreWarn,
  spectreError,
} from '../../common/protocol/spectre-types';

@injectable()
export class MemoryManager {
  @inject(SpectreAiService)
  private readonly aiService: SpectreAiService;

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
    text: string
  ): Promise<void> {
    const message: RawMessage = withTokenCount(
      {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role,
        text,
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

    spectreLog(`📝 Summarizing ${toSummarize.length} old messages...`);

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

        spectreLog(`✅ Summarized into ${summary.estimatedTokens} tokens`);

        // Check if memory bank needs compression
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
- Redundant confirmations

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
        model: 'gemini-2.5-flash-lite', // Use lite for speed
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

    spectreLog(
      `🔍 Memory bank check: ${memoryBank.totalTokens} tokens vs ${threshold} threshold`
    );

    if (memoryBank.totalTokens > threshold) {
      spectreLog(
        `⚠️ TRIGGERING COMPRESSION: ${memoryBank.totalTokens} > ${threshold}`
      );
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

    // Need at least 3 summaries to compress (keep recent, compress old)
    if (memoryBank.summaries.length < 3) {
      return;
    }

    spectreLog(
      `🗜️ Compressing memory bank (${memoryBank.summaries.length} summaries, ${memoryBank.totalTokens} tokens)...`
    );

    try {
      // STRATEGY: Keep most recent summary intact, compress older ones
      const recentSummary =
        memoryBank.summaries[memoryBank.summaries.length - 1];
      const oldSummaries = memoryBank.summaries.slice(0, -1);

      const combinedText = oldSummaries
        .map((s, idx) => `[Conversation Block ${idx + 1}]:\n${s.summary}`)
        .join('\n\n');

      // Enhanced meta-summarization prompt
      const compressionPrompt = `You are compressing long-term memory for an Arduino development assistant. The user has had an extended conversation with multiple topics.

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

      const response = await this.aiService.generate({
        prompt: compressionPrompt,
        model: 'gemini-2.5-flash', // Use full model for better quality compression
        generationConfig: {
          maxOutputTokens: 4096, // Increased for comprehensive compression
          temperature: 0.1, // Very deterministic
        },
        abortKey: `compress-${Date.now()}`,
      });

      if (response.text && response.text.trim() !== '') {
        // Create compressed version of old summaries
        const compressedSummary: SummaryEntry = withTokenCount(
          {
            id: `compressed-${Date.now()}`,
            summary: response.text.trim(),
            originalMessageIds: oldSummaries.flatMap(
              (s) => s.originalMessageIds
            ),
            createdAt: Date.now(),
            category: 'general',
          },
          'natural'
        );

        // KEEP: Most recent summary + compressed older ones
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
          (1 - compressedSummary.estimatedTokens! / originalTokens) * 100
        );

        spectreLog(
          `✅ Compressed ${oldSummaries.length} old summaries to ${compressedSummary.estimatedTokens} tokens (${compressionRatio}% reduction)`
        );
        spectreLog(
          `📊 New memory bank: 2 summaries (compressed + recent), ${memoryBank.totalTokens} total tokens`
        );
      }
    } catch (error) {
      spectreError('Memory bank compression failed:', error);
      // Keep existing summaries if compression fails
    }
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
    const { memoryBank, recentMessages } = memory;

    const parts: string[] = [];
    let estimatedTokens = 0;

    // 1. Memory Bank (if exists)
    if (memoryBank.summaries.length > 0) {
      const memoryContext = memoryBank.summaries
        .map((s) => `[Historical Context]:\n${s.summary}`)
        .join('\n\n');

      parts.push(memoryContext);
      estimatedTokens += memoryBank.totalTokens;
    }

    // 2. Recent Messages (working backwards to fit budget)
    const recentContext: string[] = [];
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const msg = recentMessages[i];
      const msgTokens =
        msg.estimatedTokens || TokenCounter.fastEstimate(msg.text);

      if (estimatedTokens + msgTokens > targetTokenBudget * 0.8) {
        break; // Leave room for current prompt
      }

      recentContext.unshift(
        `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.text}`
      );
      estimatedTokens += msgTokens;
    }

    if (recentContext.length > 0) {
      parts.push('[Recent Conversation]:\n' + recentContext.join('\n\n'));
    }

    // 3. Additional Context (sketch files, etc.)
    if (additionalContext && additionalContext.trim() !== '') {
      const contextTokens = TokenCounter.fastEstimate(additionalContext);
      if (estimatedTokens + contextTokens < targetTokenBudget * 0.9) {
        parts.push(additionalContext);
        estimatedTokens += contextTokens;
      } else {
        spectreWarn('Additional context too large, skipping');
      }
    }

    // 4. Current Prompt
    parts.push(`[Current Request]:\n${currentPrompt}`);
    const currentTokens = TokenCounter.estimate(currentPrompt, 'mixed');
    estimatedTokens += currentTokens;

    const finalPrompt = parts.join('\n\n---\n\n');

    const tokenCount: TokenCount = {
      total: estimatedTokens,
      breakdown: {
        memoryBank: memoryBank.totalTokens,
        recentMessages:
          estimatedTokens - memoryBank.totalTokens - currentTokens,
        currentPrompt: currentTokens,
        systemPrompt: 0,
      },
    };

    return { prompt: finalPrompt, tokenCount };
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
