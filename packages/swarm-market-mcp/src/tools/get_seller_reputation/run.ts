/**
 * get_seller_reputation core (CLAUDE.md "Review tools spec", Step 9 of the design).
 *
 * Comparison phase: the marketplace indexer's answer (one request). Commitment phase (`verify`) or
 * no indexer: from the chain — census via getClients + readAllFeedback, then the NewFeedback scan,
 * verifyReview + verifyPoP per review, one review per purchase (earliest wins), Rule C.
 */
import type {
  FeedbackEntry,
  FeedbackRevokedEvent,
  LogQueryOptions,
  NewFeedbackEvent,
  PoPResult,
  ProofOfPayment,
  ReviewDocument,
  ReviewVerification,
} from '@solarpunk/erc8004-adapter';
import { ReviewToolError, type MarketplaceTerms } from '../../reviews';
import type {
  GetSellerReputationArgs,
  InvalidReview,
  SellerReputation,
  VerifiedReview,
} from './models';

/** readAllFeedback is a view over every client; batch to stay within RPC gas/response limits. */
const CLIENT_BATCH = 100;

export interface GetSellerReputationDeps {
  terms: MarketplaceTerms;
  indexerReputation(agentId: string): Promise<Record<string, unknown> | null>;
  latestBlock(): Promise<number>;
  defaultFromBlock(latest: number): number;
  getClients(agentId: bigint, blockTag?: number): Promise<string[]>;
  readAllFeedback(agentId: bigint, clients: string[], blockTag?: number): Promise<FeedbackEntry[]>;
  getNewFeedbackEvents(agentId: bigint, options: LogQueryOptions): Promise<NewFeedbackEvent[]>;
  getFeedbackRevokedEvents(
    agentId: bigint,
    options: LogQueryOptions,
  ): Promise<FeedbackRevokedEvent[]>;
  verifyReview(entry: NewFeedbackEvent): Promise<ReviewVerification>;
  verifyPoP(input: {
    agentId: bigint;
    clientAddress: string;
    proofOfPayment: ProofOfPayment;
  }): Promise<PoPResult>;
  blockTimestamp(block: number): Promise<number>;
}

export async function runGetSellerReputation(
  args: GetSellerReputationArgs,
  deps: GetSellerReputationDeps,
): Promise<SellerReputation> {
  if (!/^(0|[1-9][0-9]*)$/.test(args.agentId)) {
    throw new ReviewToolError(
      'bad_request',
      `agentId must be a non-negative integer, got "${args.agentId}"`,
    );
  }
  const agentId = BigInt(args.agentId);
  const scale = deps.terms.score;

  // A missing or failing indexer is not an error: the chain is the source of truth.
  const indexer = await deps.indexerReputation(args.agentId).catch(() => null);
  if (indexer && !args.verify) {
    return {
      ...(indexer as unknown as SellerReputation),
      agentId: args.agentId,
      scale,
      source: 'indexer',
    };
  }

  const latest = await deps.latestBlock();
  const checkpointBlock = indexerCheckpoint(indexer) ?? latest;
  // State at the checkpoint needs an archive node unless it is the head.
  const blockTag = checkpointBlock === latest ? undefined : checkpointBlock;

  const clients = await deps.getClients(agentId, blockTag);
  let count = 0;
  for (let i = 0; i < clients.length; i += CLIENT_BATCH) {
    const entries = await deps.readAllFeedback(
      agentId,
      clients.slice(i, i + CLIENT_BATCH),
      blockTag,
    );
    count += entries.filter((e) => !e.isRevoked).length;
  }

  const fromBlock = Math.max(0, args.fromBlock ?? deps.defaultFromBlock(latest));
  const range = { fromBlock, toBlock: checkpointBlock };
  const [events, revocations] = await Promise.all([
    deps.getNewFeedbackEvents(agentId, range),
    deps.getFeedbackRevokedEvents(agentId, range),
  ]);
  const revoked = new Set(revocations.map((r) => key(r.clientAddress, r.feedbackIndex)));
  const live = events
    .filter((e) => !revoked.has(key(e.clientAddress, e.feedbackIndex)))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  // Verify the most recent `sample`, then score them in chain order.
  const checkedSet = args.sample !== undefined ? live.slice(-Math.max(0, args.sample)) : live;
  const invalid: InvalidReview[] = [];
  const valid: { event: NewFeedbackEvent; review: ReviewDocument; itemId: string }[] = [];
  const claimed = new Set<string>();
  for (const event of checkedSet) {
    const fail = (reason: string) =>
      invalid.push({
        feedbackIndex: event.feedbackIndex.toString(),
        clientAddress: event.clientAddress,
        reason,
      });

    const result = await deps.verifyReview(event);
    if (!result.valid) {
      fail(result.reason);
      continue;
    }
    const pop = await deps.verifyPoP({
      agentId,
      clientAddress: event.clientAddress,
      proofOfPayment: result.review.proofOfPayment,
    });
    if (!pop.valid) {
      fail(`pop:${pop.reason}`);
      continue;
    }
    // One review per purchase: the earliest valid review from the payer wins.
    const purchase = result.review.proofOfPayment.txHash.toLowerCase();
    if (claimed.has(purchase)) {
      fail('purchase_already_reviewed');
      continue;
    }
    claimed.add(purchase);
    valid.push({ event, review: result.review, itemId: pop.itemId });
  }

  const values = valid.map((v) => Number(v.event.value) / 10 ** v.event.valueDecimals);
  const newest = valid.at(-1);
  const lastEvent = [...events, ...revocations].sort(
    (a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex,
  )[0];
  const unscanned = Math.max(0, count - live.length);

  const chainView: SellerReputation = {
    agentId: args.agentId,
    score: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    scale,
    count,
    popValidCount: valid.length,
    lastReviewAt: newest
      ? new Date((await deps.blockTimestamp(newest.event.blockNumber)) * 1000).toISOString()
      : null,
    checkpoint: {
      block: checkpointBlock,
      lastEvent: lastEvent
        ? { block: lastEvent.blockNumber, txHash: lastEvent.transactionHash }
        : null,
    },
    source: 'chain',
    scannedFromBlock: fromBlock,
    unscanned,
    verification: {
      // Chain path: complete when every live entry fell inside the scan. Indexer path: the
      // indexer's count must equal the on-chain census at its own checkpoint.
      censusComplete: indexer ? Number(indexer.count) === count : unscanned === 0,
      checked: checkedSet.length,
      invalid,
    },
    reviews: args.verify ? valid.map(toVerifiedReview) : undefined,
  };

  if (!indexer) return chainView;
  return {
    ...(indexer as unknown as SellerReputation),
    agentId: args.agentId,
    scale,
    source: 'indexer',
    verification: chainView.verification,
    reviews: chainView.reviews,
  };
}

function toVerifiedReview(v: {
  event: NewFeedbackEvent;
  review: ReviewDocument;
  itemId: string;
}): VerifiedReview {
  return {
    feedbackIndex: v.event.feedbackIndex.toString(),
    clientAddress: v.event.clientAddress,
    value: Number(v.event.value) / 10 ** v.event.valueDecimals,
    ...(v.review.comment ? { comment: v.review.comment } : {}),
    createdAt: v.review.createdAt,
    itemId: v.itemId,
  };
}

function indexerCheckpoint(indexer: Record<string, unknown> | null): number | null {
  const block = (indexer?.checkpoint as { block?: unknown } | undefined)?.block;
  return typeof block === 'number' ? block : null;
}

function key(client: string, index: bigint): string {
  return `${client.toLowerCase()}:${index}`;
}
