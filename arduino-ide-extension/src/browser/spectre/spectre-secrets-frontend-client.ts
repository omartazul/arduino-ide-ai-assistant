/**
 * Frontend client for Spectre secrets status updates.
 *
 * @author Tazul Islam
 */

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import {
  SpectreSecretsServiceClient,
  SpectreSecretsStatus,
} from '../../common/protocol/spectre-secrets-service';

/**
 * Frontend client implementation for receiving API key status updates from the backend.
 * This allows the UI to reactively update when the API key is set, cleared, or validated.
 */
@injectable()
export class SpectreSecretsFrontendClient
  implements SpectreSecretsServiceClient
{
  private readonly onStatusChangeEmitter = new Emitter<SpectreSecretsStatus>();

  /**
   * Event that fires when the API key status changes.
   * Components can subscribe to this to update their UI accordingly.
   */
  get onStatusChangeEvent(): Event<SpectreSecretsStatus> {
    return this.onStatusChangeEmitter.event;
  }

  /**
   * Called by the backend when API key status changes.
   * @param status The new API key status
   */
  onStatusChange(status: SpectreSecretsStatus): void {
    this.onStatusChangeEmitter.fire(status);
  }
}
