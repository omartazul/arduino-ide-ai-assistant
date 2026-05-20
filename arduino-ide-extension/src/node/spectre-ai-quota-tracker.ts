/**
 * Per-model quota and rate-limit tracker for Spectre AI requests.
 *
 * Manages RPM/RPD accounting, token reservations, spacing enforcement,
 * and produces quota updates for the request scheduler.
 *
 * @author Tazul Islam
 */

import { SpectreQuotaUpdate } from '../common/protocol/spectre-ai-service';
import { getPacificMidnight } from './spectre-ai-request-utils';

type ModelId = string;
type UnixMs = number;
type TokenCount = number;
type RequestCount = number;

type IsFlashLite = (model: ModelId) => boolean;

interface TokenUsage {
  time: UnixMs;
  tokens: TokenCount;
  reservation?: boolean;
}

export interface QuotaTrackerConfig {
  tokenCapacityPerMinute: TokenCount;
  rpmFlash: RequestCount;
  rpmFlashLite: RequestCount;
  rpdFlash: RequestCount;
  rpdFlashLite: RequestCount;
  rollingWindowMs: UnixMs;
  minSpacingMsFlash: UnixMs;
  minSpacingMsFlashLite: UnixMs;
}

export class SpectreAiQuotaTracker {
  private readonly recentCalls: Record<ModelId, UnixMs[]> = Object.create(null);
  private readonly dailyCalls: Record<ModelId, UnixMs[]> = Object.create(null);
  private readonly lastCallAt: Record<ModelId, UnixMs> = Object.create(null);
  private readonly tokenWindows: Record<ModelId, TokenUsage[]> = Object.create(null);

  private cachedRpmLists: Record<ModelId, UnixMs[]> = Object.create(null);
  private cachedDailyLists: Record<ModelId, UnixMs[]> = Object.create(null);

  private lastUsedModel: ModelId = 'gemini-3.1-flash-lite';

  constructor(
    private readonly config: QuotaTrackerConfig,
    private readonly isFlashLite: IsFlashLite
  ) {}

  setLastUsedModel(model: ModelId): void {
    this.lastUsedModel = model;
  }

  setLastCallAt(model: ModelId, ts: UnixMs): void {
    this.lastCallAt[model] = ts;
  }

  getLastCallAt(model: ModelId): UnixMs {
    return this.lastCallAt[model] || 0;
  }

  hasActiveTracking(): boolean {
    return (
      Object.values(this.tokenWindows).some((w) => w.length > 0) ||
      Object.values(this.recentCalls).some((l) => l.length > 0)
    );
  }

  isAllTrackingEmpty(queueLength: number): boolean {
    const afterRpm = Object.values(this.recentCalls).reduce(
      (a, l) => a + l.length,
      0
    );
    return (
      Object.values(this.tokenWindows).every((w) => w.length === 0) &&
      afterRpm === 0 &&
      queueLength === 0
    );
  }

  currentUsedTokens(): TokenCount {
    return Object.values(this.tokenWindows).reduce((total, window) => {
      return total + window.reduce((s: number, e: TokenUsage) => s + e.tokens, 0);
    }, 0);
  }

  totalRecentCallsCount(): number {
    return Object.values(this.recentCalls).reduce((a, l) => a + l.length, 0);
  }

  canStartNow(model: ModelId, reservationTokens: TokenCount): boolean {
    this.cleanWindows();
    const now = Date.now();

    if (this.isRpmLimitExceeded(model)) return false;
    if (this.isRpdLimitExceeded(model)) return false;
    if (this.isTokenLimitExceeded(reservationTokens)) return false;
    if (this.isSpacingViolated(model, now)) return false;

    return true;
  }

  computeNextAvailabilityMs(
    head: { model: ModelId; reservationTokens: TokenCount } | undefined
  ): UnixMs {
    const now = Date.now();
    if (!head) return now;

    const tokenDelay = this.calculateTokenDelay(head.model, head.reservationTokens, now);
    const rpmDelay = this.calculateRpmDelay(head.model, now);
    const spacingDelay = this.calculateSpacingDelay(head.model, now);

    return now + Math.max(tokenDelay, rpmDelay, spacingDelay);
  }

  buildQuotaUpdate(params: {
    now: UnixMs;
    modelForRpm?: ModelId;
    queueLength: number;
    head?: { model: ModelId; reservationTokens: TokenCount };
  }): SpectreQuotaUpdate {
    const { now, modelForRpm, queueLength, head } = params;

    const model = this.resolveQuotaModel(modelForRpm, head?.model);
    const rpmLimit = this.isFlashLite(model) ? this.config.rpmFlashLite : this.config.rpmFlash;
    const rpmUsed = this.countRecentCalls(model, now);

    return {
      usedTokens: this.currentUsedTokens(),
      capacity: this.config.tokenCapacityPerMinute,
      rpmUsed,
      rpmLimit,
      queued: queueLength,
      nextAvailableMs: queueLength ? this.computeNextAvailabilityMs(head) : now,
    };
  }

  recordReservation(model: ModelId, tokens: TokenCount): void {
    if (!this.tokenWindows[model]) this.tokenWindows[model] = [];
    this.tokenWindows[model].push({
      time: Date.now(),
      tokens,
      reservation: true,
    });
    this.cleanWindows();
  }

  adjustReservation(model: ModelId, actual: TokenCount, reservation: TokenCount): void {
    const delta = actual - reservation;
    if (!delta) {
      return;
    }

    if (!this.tokenWindows[model]) this.tokenWindows[model] = [];
    this.tokenWindows[model].push({
      time: Date.now(),
      tokens: delta,
      reservation: false,
    });
    this.cleanWindows();
  }

  recordRpm(model: ModelId): void {
    const now = Date.now();

    if (!this.recentCalls[model]) this.recentCalls[model] = [];
    if (!this.dailyCalls[model]) this.dailyCalls[model] = [];

    this.recentCalls[model].push(now);
    this.dailyCalls[model].push(now);

    const RPM_CLEANUP_THRESHOLD = 100;
    const RPD_CLEANUP_THRESHOLD = 200;

    if (this.recentCalls[model].length > RPM_CLEANUP_THRESHOLD) {
      const rpmCutoff = now - this.config.rollingWindowMs;
      this.recentCalls[model] = this.recentCalls[model].filter((t) => t >= rpmCutoff);
    }

    if (this.dailyCalls[model].length > RPD_CLEANUP_THRESHOLD) {
      const pacificMidnight = getPacificMidnight();
      this.dailyCalls[model] = this.dailyCalls[model].filter((t) => t >= pacificMidnight);
    }
  }

  cleanWindows(): void {
    const now = Date.now();
    const rpmCutoff = now - this.config.rollingWindowMs;
    const pacificMidnight = getPacificMidnight();

    const didClean =
      this.cleanTokenWindows(rpmCutoff) ||
      this.cleanRecentCalls(rpmCutoff) ||
      this.cleanDailyCalls(pacificMidnight);

    if (didClean) {
      this.rebuildCaches(rpmCutoff, pacificMidnight);
    } else {
      this.ensureCachesInitialized(rpmCutoff, pacificMidnight);
    }
  }

  countRecentCalls(model: ModelId, now: UnixMs): number {
    return (this.recentCalls[model] || []).filter((t) => now - t < this.config.rollingWindowMs)
      .length;
  }

  calculateRpmDelay(model: ModelId, now: UnixMs): UnixMs {
    const limit = this.isFlashLite(model) ? this.config.rpmFlashLite : this.config.rpmFlash;
    const rpmList = (this.recentCalls[model] || []).filter(
      (t) => now - t < this.config.rollingWindowMs
    );
    if (rpmList.length >= limit) {
      return rpmList[0] + this.config.rollingWindowMs - now;
    }
    return 0;
  }

  // Internal helpers

  private resolveQuotaModel(modelForRpm?: ModelId, headModel?: ModelId): ModelId {
    return modelForRpm || headModel || this.lastUsedModel;
  }

  private isRpmLimitExceeded(model: ModelId): boolean {
    const rpmLimit = this.isFlashLite(model) ? this.config.rpmFlashLite : this.config.rpmFlash;
    const rpmList = this.cachedRpmLists[model] || [];
    return rpmList.length >= rpmLimit;
  }

  private isRpdLimitExceeded(model: ModelId): boolean {
    const rpdLimit = this.isFlashLite(model) ? this.config.rpdFlashLite : this.config.rpdFlash;
    const dailyList = this.cachedDailyLists[model] || [];
    return dailyList.length >= rpdLimit;
  }

  private isTokenLimitExceeded(reservationTokens: TokenCount): boolean {
    const used = this.currentUsedTokens();
    return used + reservationTokens > this.config.tokenCapacityPerMinute;
  }

  private isSpacingViolated(model: ModelId, now: UnixMs): boolean {
    const last = this.getLastCallAt(model);
    const minSpacing = this.isFlashLite(model)
      ? this.config.minSpacingMsFlashLite
      : this.config.minSpacingMsFlash;
    return now - last < minSpacing;
  }

  private calculateSpacingDelay(model: ModelId, now: UnixMs): UnixMs {
    const minSpacing = this.isFlashLite(model)
      ? this.config.minSpacingMsFlashLite
      : this.config.minSpacingMsFlash;
    return Math.max(0, this.getLastCallAt(model) + minSpacing - now);
  }

  private calculateTokenDelay(
    model: ModelId,
    reservationTokens: TokenCount,
    now: UnixMs
  ): UnixMs {
    const used = this.currentUsedTokens();
    if (used + reservationTokens <= this.config.tokenCapacityPerMinute) return 0;

    let cumulative = used;
    const window = this.tokenWindows[model] || [];
    for (const entry of window) {
      const expiry = entry.time + this.config.rollingWindowMs;
      cumulative -= entry.tokens;
      if (cumulative + reservationTokens <= this.config.tokenCapacityPerMinute) {
        return Math.max(0, expiry - now);
      }
    }
    return 0;
  }

  private shouldCleanWindow<T>(window: T[], predicate: (item: T) => boolean): boolean {
    if (window.length === 0) return false;
    const expiredCount = window.filter(predicate).length;
    return expiredCount > window.length * 0.3;
  }

  private cleanMap<T>(map: Record<ModelId, T[]>, predicate: (item: T) => boolean): boolean {
    let changed = false;
    for (const k in map) {
      const list = map[k];
      if (!this.shouldCleanWindow(list, predicate)) {
        continue;
      }

      map[k] = list.filter((item: T) => !predicate(item));
      changed = true;
      if (map[k].length === 0) {
        delete map[k];
      }
    }
    return changed;
  }

  private cleanTokenWindows(rpmCutoff: UnixMs): boolean {
    return this.cleanMap<TokenUsage>(this.tokenWindows, (e) => e.time < rpmCutoff);
  }

  private cleanRecentCalls(rpmCutoff: UnixMs): boolean {
    return this.cleanMap<UnixMs>(this.recentCalls, (t) => t < rpmCutoff);
  }

  private cleanDailyCalls(pacificMidnight: UnixMs): boolean {
    return this.cleanMap<UnixMs>(this.dailyCalls, (t) => t < pacificMidnight);
  }

  private buildFilteredLists(source: Record<ModelId, UnixMs[]>, cutoff: UnixMs): Record<ModelId, UnixMs[]> {
    const result: Record<ModelId, UnixMs[]> = Object.create(null);
    for (const k in source) {
      const filtered = source[k].filter((t) => t >= cutoff);
      if (filtered.length > 0) {
        result[k] = filtered;
      }
    }
    return result;
  }

  private rebuildCaches(rpmCutoff: UnixMs, pacificMidnight: UnixMs): void {
    this.cachedRpmLists = this.buildFilteredLists(this.recentCalls, rpmCutoff);
    this.cachedDailyLists = this.buildFilteredLists(this.dailyCalls, pacificMidnight);
  }

  private ensureCachesInitialized(rpmCutoff: UnixMs, pacificMidnight: UnixMs): void {
    if (Object.keys(this.cachedRpmLists).length === 0) {
      this.cachedRpmLists = this.buildFilteredLists(this.recentCalls, rpmCutoff);
    }
    if (Object.keys(this.cachedDailyLists).length === 0) {
      this.cachedDailyLists = this.buildFilteredLists(this.dailyCalls, pacificMidnight);
    }
  }
}
