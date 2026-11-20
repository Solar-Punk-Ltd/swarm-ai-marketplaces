import { Duration, Size, type BatchId, type PostageBatchOptions } from '@ethersphere/bee-js';
import type { Store } from './db.js';

/** The slice of Bee the batch manager needs (narrow, so tests can fake it). */
export interface BatchBee {
  buyStorage(size: Size, duration: Duration, options?: PostageBatchOptions): Promise<BatchId>;
  getPostageBatch(batchId: string): Promise<{ usable: boolean }>;
}

export type BatchLookup = { batchId: string } | { retryAfter: number };

/**
 * One marketplace-owned postage batch per seller, bought lazily on the seller's first review.
 *
 * Batches are immutable: a mutable batch overwrites old chunks once full, which would break older
 * reviews' feed indexes. A new batch takes several blocks to become usable, so the purchase runs
 * in the background and callers get `retryAfter` until it is. The batch key is the Bee node's
 * own: sellers never get a write path to it.
 */
export class BatchManager {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly bee: BatchBee,
    private readonly store: Store,
    private readonly options: { sizeMb: number; ttlDays: number; retryAfterSeconds: number },
  ) {}

  async usableBatch(agentId: bigint): Promise<BatchLookup> {
    const key = agentId.toString();
    const row = this.store.getBatch(key);

    if (row?.status === 'usable' && row.batchId) return { batchId: row.batchId };

    if (row?.status === 'pending' && row.batchId) {
      const batch = await this.bee.getPostageBatch(row.batchId);
      if (batch.usable) {
        this.store.setBatch(key, 'usable', row.batchId);
        return { batchId: row.batchId };
      }
      return this.retry();
    }

    // No batch yet, a failed purchase, or a purchase interrupted by a restart: (re)start it.
    if (!this.inflight.has(key)) this.startPurchase(key);
    return this.retry();
  }

  /** Resolves once any purchase in flight has settled (tests / graceful shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  private startPurchase(agentId: string): void {
    this.store.setBatch(agentId, 'pending', null);
    const purchase = this.bee
      .buyStorage(
        Size.fromMegabytes(this.options.sizeMb),
        Duration.fromDays(this.options.ttlDays),
        {
          immutableFlag: true,
          waitForUsable: false,
          label: `reviews-agent-${agentId}`,
        },
      )
      .then((batchId) => this.store.setBatch(agentId, 'pending', batchId.toHex()))
      .catch((err: unknown) =>
        this.store.setBatch(
          agentId,
          'failed',
          null,
          err instanceof Error ? err.message : String(err),
        ),
      )
      .finally(() => this.inflight.delete(agentId));
    this.inflight.set(agentId, purchase);
  }

  private retry(): BatchLookup {
    return { retryAfter: this.options.retryAfterSeconds };
  }
}
