/**
 * Frontend client for Spectre AI streaming and quota updates.
 *
 * @author Tazul Islam
 */

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import {
  SpectreAiClient,
  SpectreQuotaUpdate,
} from '../../common/protocol/spectre-ai-service';

/**
 * Frontend client implementation for receiving AI streaming responses and quota updates from the backend.
 * This enables real-time UI updates as AI generates responses token-by-token and tracks API usage limits.
 */
@injectable()
export class SpectreAiFrontendClient implements SpectreAiClient {
  private readonly onStreamEmitter = new Emitter<{
    key: string;
    delta?: string;
    done?: boolean;
    error?: string;
  }>();
  private readonly onQuotaEmitter = new Emitter<SpectreQuotaUpdate>();

  /**
   * Event that fires for each streaming response chunk from the AI.
   * Subscribers receive incremental text deltas, completion signals, and errors.
   */
  get onStreamEvent(): Event<{
    key: string;
    delta?: string;
    done?: boolean;
    error?: string;
  }> {
    return this.onStreamEmitter.event;
  }

  /**
   * Event that fires when API quota/usage information is updated.
   * Allows UI to display remaining credits, rate limits, or usage warnings.
   */
  get onQuotaEvent(): Event<SpectreQuotaUpdate> {
    return this.onQuotaEmitter.event;
  }

  /**
   * Called by the backend for each chunk of streaming AI response.
   * @param event Stream event containing request key, text delta, completion status, or error
   */
  onStream(event: {
    key: string;
    delta?: string;
    done?: boolean;
    error?: string;
  }): void {
    this.onStreamEmitter.fire(event);
  }

  /**
   * Called by the backend when quota or usage information changes.
   * @param update Quota update information including limits and current usage
   */
  onQuota(update: SpectreQuotaUpdate): void {
    this.onQuotaEmitter.fire(update);
  }
}
