/**
 * Streaming controller for Spectre assistant responses.
 *
 * @author Tazul Islam
 */

import { spectreWarn } from '../../../common/protocol/spectre-types';

export interface StreamEvent {
  key: string;
  delta?: string;
  done?: boolean;
  error?: string;
}

export interface StreamControllerDeps {
  streamFallbackTimeoutMs: number;
  setBusyDone: () => void;
  focusInput: () => void;
  mutateLastAssistant: (
    mutator: (text: string) => string,
    requestSeq: number
  ) => Promise<void>;
}

/**
 * Owns the buffered streaming reveal (ticker + fallback) and processes stream events.
 * Intentionally does NOT call AI APIs; it just updates UI state via the provided deps.
 */
export class StreamController {
  private currentAbortKey?: string;
  private currentRequestSeq?: number;

  private streamBuffer = '';
  private streamTicker?: number;
  private streamDone = false;
  private streamStarted = false;
  private streamFallbackTimer?: number;

  constructor(private readonly deps: StreamControllerDeps) {}

  hasStreamStarted(): boolean {
    return this.streamStarted;
  }

  detach(): void {
    this.stop();
    this.currentAbortKey = undefined;
    this.currentRequestSeq = undefined;
  }

  attach(streamKey: string, requestSeq: number): void {
    // Reset any previous streaming animation state (clears buffer, timers, and flags)
    this.stop();

    // Store the current stream key and request sequence for onStream callback
    this.currentAbortKey = streamKey;
    this.currentRequestSeq = requestSeq;
  }

  stop(): void {
    if (this.streamTicker) {
      clearInterval(this.streamTicker);
      this.streamTicker = undefined;
    }
    // Cancel fallback timeout to prevent memory leak
    if (this.streamFallbackTimer) {
      clearTimeout(this.streamFallbackTimer);
      this.streamFallbackTimer = undefined;
    }
    this.streamBuffer = '';
    this.streamDone = false;
    this.streamStarted = false;
  }

  onStream(event: StreamEvent): void {
    if (!this.isValidStreamEvent(event)) {
      return;
    }

    if (this.currentRequestSeq === undefined) {
      spectreWarn(
        'Received stream event for unknown request sequence - ignoring'
      );
      return;
    }

    if (event.error) {
      this.handleStreamError(event.error, this.currentRequestSeq);
      return;
    }

    if (event.delta) {
      this.handleStreamDelta(event.delta, this.currentRequestSeq);
    }

    if (event.done) {
      this.handleStreamCompletion(this.currentRequestSeq);
    }
  }

  private isValidStreamEvent(event: { key: string }): boolean {
    return !!(this.currentAbortKey && event.key === this.currentAbortKey);
  }

  private handleStreamError(error: string, requestSeq: number): void {
    this.stop();
    void this.deps.mutateLastAssistant(
      (prev) => prev + `\n\nError: ${error}`,
      requestSeq
    );
    this.deps.setBusyDone();
    this.deps.focusInput();
  }

  private handleStreamDelta(delta: string, requestSeq: number): void {
    if (!this.streamStarted) this.streamStarted = true;
    this.streamBuffer += delta;
    this.startStreamTicker(requestSeq);
  }

  private handleStreamImmediateCompletion(requestSeq: number): void {
    if (this.streamBuffer.length > 0) {
      const remaining = this.streamBuffer;
      this.streamBuffer = '';
      void this.deps.mutateLastAssistant(
        (prev) => prev + remaining,
        requestSeq
      );
    }
    this.deps.setBusyDone();
    this.deps.focusInput();
  }

  private handleStreamCompletion(requestSeq: number): void {
    if (!this.streamTicker) {
      this.handleStreamImmediateCompletion(requestSeq);
      return;
    }

    this.setupStreamFallbackTimer();
  }

  private setupStreamFallbackTimer(): void {
    this.streamDone = true;
    // Cancel any existing fallback timer to prevent leaks
    if (this.streamFallbackTimer) {
      clearTimeout(this.streamFallbackTimer);
    }
    // Fallback: if ticker doesn't complete within timeout, force completion
    this.streamFallbackTimer = window.setTimeout(() => {
      if (this.streamDone && this.streamTicker) {
        spectreWarn('Stream ticker timeout - forcing completion');
        this.stop();
        if (
          this.streamBuffer.length > 0 &&
          this.currentRequestSeq !== undefined
        ) {
          const seq = this.currentRequestSeq;
          const remaining = this.streamBuffer;
          this.streamBuffer = '';
          void this.deps.mutateLastAssistant((prev) => prev + remaining, seq);
        }
        this.deps.setBusyDone();
        this.deps.focusInput();
      }
      this.streamFallbackTimer = undefined;
    }, this.deps.streamFallbackTimeoutMs);
  }

  private startStreamTicker(requestSeq: number): void {
    if (this.streamTicker) return;
    const seq = requestSeq ?? this.currentRequestSeq;
    if (seq === undefined) return;
    const TICK_MS = 25;
    this.streamTicker = window.setInterval(() => {
      if (this.shouldAbortStream(seq)) {
        this.stop();
        return;
      }
      if (this.streamBuffer.length > 0) {
        const step = this.calculateChunkSize(this.streamBuffer.length);
        const take = this.streamBuffer.slice(0, step);
        this.streamBuffer = this.streamBuffer.slice(step);
        void this.deps.mutateLastAssistant((prev) => prev + take, seq);
      } else if (this.streamDone) {
        this.flushStreamBuffer();
      }
    }, TICK_MS);
  }

  private shouldAbortStream(seq: number): boolean {
    return seq !== this.currentRequestSeq || !this.currentAbortKey;
  }

  private calculateChunkSize(bufferLength: number): number {
    if (bufferLength > 1000) return 120;
    if (bufferLength > 500) return 80;
    if (bufferLength > 150) return 40;
    return 24;
  }

  private flushStreamBuffer(): void {
    this.stop();
    this.deps.setBusyDone();
    this.deps.focusInput();
  }
}
