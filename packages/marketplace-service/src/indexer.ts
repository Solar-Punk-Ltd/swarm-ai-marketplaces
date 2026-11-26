import type {
  FeedbackRevokedEvent,
  LogQueryOptions,
  NewFeedbackEvent,
  PoPResult,
  ProofOfPayment,
  ResponseAppendedEvent,
  ReviewVerification,
} from '@solarpunk/erc8004-adapter';
import type { IndexedReview, IndexStore } from './index-store.js';

export interface IndexerDeps {
  store: IndexStore;
  latestBlock(): Promise<number>;
  getNewFeedbackEvents(agentId: null, options: LogQueryOptions): Promise<NewFeedbackEvent[]>;
  getFeedbackRevokedEvents(
    agentId: null,
    options: LogQueryOptions,
  ): Promise<FeedbackRevokedEvent[]>;
  getResponseAppendedEvents(
    agentId: null,
    options: LogQueryOptions,
  ): Promise<ResponseAppendedEvent[]>;
  verifyReview(
    entry: Pick<
      NewFeedbackEvent,
      'agentId' | 'clientAddress' | 'value' | 'valueDecimals' | 'feedbackURI' | 'feedbackHash'
    >,
  ): Promise<ReviewVerification>;
  verifyPoP(input: {
    agentId: bigint;
    clientAddress: string;
    proofOfPayment: ProofOfPayment;
  }): Promise<PoPResult>;
  blockTimestamp(block: number): Promise<number>;
  log?: (message: string) => void;
}

export interface IndexerOptions {
  startBlock: number; // first block ever ingested (used only before the first checkpoint)
  confirmations: number; // stay this far behind head (reorgs)
  maxBlocksPerTick: number;
  chunkSize: number; // eth_getLogs page size
  verifyBatch: number;
  maxAttempts: number; // fetch retries before an unresolvable review is marked invalid
  pollMs: number;
}

export interface TickResult {
  ingested: { from: number; to: number; events: number } | null;
  verified: number;
  caughtUp: boolean;
}

// A missing chunk may just not have propagated yet; everything else is a final verdict.
const TRANSIENT = new Set(['soc_unavailable', 'content_unavailable']);

/**
 * Step 9 indexer: a cache over chain events + Swarm content, never an authority. It ingests
 * NewFeedback / FeedbackRevoked / ResponseAppended for every agent behind a confirmation depth,
 * then verifies each review once (verifyReview + verifyPoP). Scoring (Rule C, one review per
 * purchase) happens at read time in reputation.ts, so revocations re-open purchases naturally.
 */
export class ReviewIndexer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly deps: IndexerDeps,
    private readonly options: IndexerOptions,
  ) {}

  async tick(): Promise<TickResult> {
    const { store } = this.deps;
    const safeHead = (await this.deps.latestBlock()) - this.options.confirmations;
    const from = (store.getCheckpoint() ?? this.options.startBlock - 1) + 1;

    let ingested: TickResult['ingested'] = null;
    let caughtUp = true;
    if (from <= safeHead) {
      const to = Math.min(safeHead, from + this.options.maxBlocksPerTick - 1);
      const range = { fromBlock: from, toBlock: to, chunkSize: this.options.chunkSize };
      const [feedback, revocations, responses] = await Promise.all([
        this.deps.getNewFeedbackEvents(null, range),
        this.deps.getFeedbackRevokedEvents(null, range),
        this.deps.getResponseAppendedEvents(null, range),
      ]);
      store.ingest(to, { feedback, revocations, responses });
      ingested = { from, to, events: feedback.length + revocations.length + responses.length };
      caughtUp = to === safeHead;
    }

    let verified = 0;
    for (const review of store.pending(this.options.verifyBatch)) {
      await this.verify(review);
      verified++;
    }
    return { ingested, verified, caughtUp };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      let delay = this.options.pollMs;
      try {
        const result = await this.tick();
        if (result.ingested && result.ingested.events > 0) {
          this.deps.log?.(
            `indexed blocks ${result.ingested.from}–${result.ingested.to}: ${result.ingested.events} events, ${result.verified} verified`,
          );
        }
        // Backfilling: go again right away.
        if (!result.caughtUp || result.verified === this.options.verifyBatch) delay = 0;
      } catch (err) {
        this.deps.log?.(`indexer tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.running) this.timer = setTimeout(loop, delay);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async verify(review: IndexedReview): Promise<void> {
    const { store } = this.deps;
    const key = review;
    const agentId = BigInt(review.agentId);

    const result = await this.deps.verifyReview({
      agentId,
      clientAddress: review.clientAddress,
      value: BigInt(review.value),
      valueDecimals: review.valueDecimals,
      feedbackURI: review.feedbackURI,
      feedbackHash: review.feedbackHash,
    });
    if (!result.valid) {
      const retry = TRANSIENT.has(result.reason) && review.attempts + 1 < this.options.maxAttempts;
      store.markVerified(key, { status: retry ? 'pending' : 'invalid', reason: result.reason });
      return;
    }

    let pop: PoPResult;
    try {
      pop = await this.deps.verifyPoP({
        agentId,
        clientAddress: review.clientAddress,
        proofOfPayment: result.review.proofOfPayment,
      });
    } catch (err) {
      // RPC trouble is not a verdict on the review.
      const message = err instanceof Error ? err.message : String(err);
      store.markVerified(key, { status: 'pending', reason: `rpc: ${message}` });
      return;
    }
    const comment = result.review.comment ?? null;
    const { proofOfPayment } = result.review;
    if (!pop.valid) {
      store.markVerified(key, {
        status: 'invalid',
        reason: `pop:${pop.reason}`,
        comment,
        proofOfPayment,
      });
      return;
    }

    store.markVerified(key, {
      status: 'valid',
      purchaseTx: result.review.proofOfPayment.txHash,
      itemId: pop.itemId,
      blockTime: await this.deps.blockTimestamp(review.blockNumber),
      comment,
      proofOfPayment,
    });
  }
}
