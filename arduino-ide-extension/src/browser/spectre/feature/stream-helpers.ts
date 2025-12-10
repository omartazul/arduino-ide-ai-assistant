/**
 * Stream management helpers for handling streaming responses.
 * Manages stream state, buffers, and progressive rendering.
 *
 * @author Tazul Islam
 */

export interface StreamState {
  buffer: string;
  lastFlush: number;
  started: boolean;
}

/**
 * Creates a new stream state.
 */
export function createStreamState(): StreamState {
  return {
    buffer: '',
    lastFlush: Date.now(),
    started: false,
  };
}

/**
 * Calculates chunk size based on buffer length for progressive rendering.
 */
export function calculateStreamChunkSize(bufferLength: number): number {
  if (bufferLength > 1000) return 120;
  if (bufferLength > 500) return 80;
  if (bufferLength > 150) return 40;
  return 24;
}

/**
 * Determines if stream should be flushed based on timing and buffer size.
 */
export function shouldFlushStream(
  buffer: string,
  lastFlush: number,
  flushInterval: number = 100
): boolean {
  const now = Date.now();
  return buffer.length > 0 && now - lastFlush >= flushInterval;
}

/**
 * Extracts a chunk from the buffer for progressive rendering.
 */
export function extractStreamChunk(buffer: string, chunkSize: number): {
  chunk: string;
  remaining: string;
} {
  if (buffer.length <= chunkSize) {
    return { chunk: buffer, remaining: '' };
  }

  const chunk = buffer.slice(0, chunkSize);
  const remaining = buffer.slice(chunkSize);

  return { chunk, remaining };
}
