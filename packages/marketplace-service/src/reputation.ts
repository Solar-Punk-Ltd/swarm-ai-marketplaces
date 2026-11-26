import type { Request, RequestHandler, Response } from 'express';
import type { ProofOfPayment } from '@solarpunk/erc8004-adapter';
import type { IndexedReview, IndexStore } from './index-store.js';
import { ServiceError, sendError } from './errors.js';

/** The JSON body of GET /v1/sellers/:agentId/reputation. */
export interface SellerReputation {
  agentId: string;
  score: number | null; // average of PoP-valid reviews on the marketplace scale
  scale: { min: number; max: number; decimals: number };
  count: number; // anchored, non-revoked entries (what a buyer's census compares)
  popValidCount: number; // Rule C subset, one per purchase
  pendingCount: number; // not verified yet — may still join popValidCount
  recency: string | null; // newest PoP-valid review (ISO-8601)
  lastReviewAt: string | null; // same as recency (name used by the MCP tool)
  checkpoint: { block: number; lastEvent: { block: number; txHash: string } | null };
  popValidClients: string[]; // the Sybil-filtered client set for getSummary (Rule B)
  responseCount: number;
}

/** One review as GET /v1/sellers/:agentId/reviews lists it. */
export interface SellerReview {
  feedbackIndex: string;
  clientAddress: string;
  value: number; // on the marketplace scale (the on-chain value, not the file's)
  /** counted — in the score; pending — not verified yet; not_counted — `reason` says why. */
  status: 'counted' | 'pending' | 'not_counted';
  reason: string | null;
  comment: string | null; // from the review file on Swarm; null until it has been verified
  reviewedAt: string | null; // anchoring block time (ISO-8601), once verified
  anchorTx: string; // the giveFeedback transaction: the on-chain proof
  anchorBlock: number;
  purchaseTx: string | null; // the settlement the review's Proof-of-Purchase cites
  itemId: string | null;
  feedbackURI: string;
  feedbackHash: string;
}

export interface SellerReviews {
  agentId: string;
  scale: SellerReputation['scale'];
  checkpoint: { block: number };
  reviews: SellerReview[]; // newest first, revoked entries excluded
}

/**
 * Rule C at read time: a review counts if it is anchored, not revoked, and verified; one per
 * purchase — the earliest such review from the payer (verifyPoP already pinned client = payer).
 * Computing it here, not at ingest, lets a revocation free its purchase for a later review.
 */
function countedReviews(live: IndexedReview[]): IndexedReview[] {
  const claimed = new Set<string>();
  return live.filter((r) => {
    if (r.status !== 'valid' || !r.purchaseTx || claimed.has(r.purchaseTx)) return false;
    claimed.add(r.purchaseTx);
    return true;
  });
}

function requireCheckpoint(store: IndexStore): number {
  const checkpoint = store.getCheckpoint();
  if (checkpoint === null) {
    throw new ServiceError('indexer_unavailable', 'The indexer has not completed its first pass');
  }
  return checkpoint;
}

const scaled = (r: IndexedReview) => Number(r.value) / 10 ** r.valueDecimals;

export function sellerReputation(
  store: IndexStore,
  agentId: string,
  scale: SellerReputation['scale'],
): SellerReputation {
  const checkpoint = requireCheckpoint(store);
  const live = store.reviewsFor(agentId).filter((r) => !r.revoked);
  const winners = countedReviews(live);

  const values = winners.map(scaled);
  const newest = Math.max(0, ...winners.map((r) => r.blockTime ?? 0));
  const recency = newest > 0 ? new Date(newest * 1000).toISOString() : null;

  return {
    agentId,
    score: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    scale,
    count: live.length,
    popValidCount: winners.length,
    pendingCount: live.filter((r) => r.status === 'pending').length,
    recency,
    lastReviewAt: recency,
    checkpoint: { block: checkpoint, lastEvent: store.lastEvent(agentId) },
    popValidClients: [...new Set(winners.map((r) => r.clientAddress))],
    responseCount: store.responseCount(agentId),
  };
}

/**
 * Every live review of a seller with its verdict, for display. Same Rule C as the score, so a
 * review marked `counted` here is exactly one that `sellerReputation` averages.
 */
export function sellerReviews(
  store: IndexStore,
  agentId: string,
  scale: SellerReputation['scale'],
): SellerReviews {
  const checkpoint = requireCheckpoint(store);
  const live = store.reviewsFor(agentId).filter((r) => !r.revoked);
  const counted = new Set(countedReviews(live));

  const reviews = live.map((r): SellerReview => {
    const status = counted.has(r) ? 'counted' : r.status === 'pending' ? 'pending' : 'not_counted';
    // A verified review left out of the score lost its purchase to an earlier one.
    const reason =
      status === 'not_counted' && r.status === 'valid' ? 'purchase_already_reviewed' : r.reason;
    return {
      feedbackIndex: r.feedbackIndex,
      clientAddress: r.clientAddress,
      value: scaled(r),
      status,
      reason: status === 'counted' ? null : reason,
      comment: r.comment,
      reviewedAt: r.blockTime ? new Date(r.blockTime * 1000).toISOString() : null,
      anchorTx: r.transactionHash,
      anchorBlock: r.blockNumber,
      purchaseTx: r.purchaseTx,
      itemId: r.itemId,
      feedbackURI: r.feedbackURI,
      feedbackHash: r.feedbackHash,
    };
  });

  return { agentId, scale, checkpoint: { block: checkpoint }, reviews: reviews.reverse() };
}

function agentIdParam(req: Request): string {
  const { agentId } = req.params;
  if (!/^(0|[1-9][0-9]*)$/.test(agentId)) {
    throw new ServiceError('bad_request', 'agentId must be a non-negative integer');
  }
  return agentId;
}

/** GET /v1/sellers/:agentId/reputation — a cache answer; buyers verify against the chain. */
export function reputationHandler(
  store: IndexStore,
  scale: SellerReputation['scale'],
): RequestHandler {
  return (req: Request, res: Response) => {
    try {
      res.json(sellerReputation(store, agentIdParam(req), scale));
    } catch (err) {
      sendError(res, err);
    }
  };
}

/** GET /v1/sellers/:agentId/reviews — the reviews behind the score, also a cache answer. */
export function reviewsHandler(
  store: IndexStore,
  scale: SellerReputation['scale'],
): RequestHandler {
  return (req: Request, res: Response) => {
    try {
      res.json(sellerReviews(store, agentIdParam(req), scale));
    } catch (err) {
      sendError(res, err);
    }
  };
}

/** Where a review is anchored: enough to find and check the entry on any explorer or RPC. */
export interface ReviewAnchor {
  chainId: string;
  reputationRegistry: string;
}

/** GET /v1/sellers/:agentId/reviews/:clientAddress/:feedbackIndex/proof */
export interface ReviewProof {
  review: Pick<SellerReview, 'feedbackIndex' | 'clientAddress' | 'value' | 'status' | 'reason'> & {
    agentId: string;
  };
  /** The giveFeedback entry: it commits to the review file by `feedbackHash`. */
  anchor: ReviewAnchor & {
    txHash: string;
    block: number;
    feedbackURI: string;
    feedbackHash: string;
  };
  /** As the review file states it (null until the indexer has fetched and hash-checked it). */
  proofOfPayment: ProofOfPayment | null;
}

/**
 * One review's evidence for display: its on-chain anchor next to the Proof-of-Purchase from the
 * review file the indexer fetched and matched against `feedbackHash`. A cache answer like the rest;
 * the verdict is the indexer's, and anyone can re-check both halves on-chain.
 */
export function reviewProof(
  store: IndexStore,
  agentId: string,
  clientAddress: string,
  feedbackIndex: string,
  scale: SellerReputation['scale'],
  anchor: ReviewAnchor,
): ReviewProof {
  const client = clientAddress.toLowerCase();
  const listed = sellerReviews(store, agentId, scale).reviews.find(
    (r) => r.clientAddress === client && r.feedbackIndex === feedbackIndex,
  );
  const stored = store
    .reviewsFor(agentId)
    .find((r) => r.clientAddress === client && r.feedbackIndex === feedbackIndex);
  if (!listed || !stored) {
    throw new ServiceError('review_not_found', 'No live review of this seller under that key');
  }
  return {
    review: {
      agentId,
      feedbackIndex,
      clientAddress: client,
      value: listed.value,
      status: listed.status,
      reason: listed.reason,
    },
    anchor: {
      ...anchor,
      txHash: listed.anchorTx,
      block: listed.anchorBlock,
      feedbackURI: listed.feedbackURI,
      feedbackHash: listed.feedbackHash,
    },
    proofOfPayment: stored.proofOfPayment,
  };
}

/** GET /v1/sellers/:agentId/reviews/:clientAddress/:feedbackIndex/proof */
export function reviewProofHandler(
  store: IndexStore,
  scale: SellerReputation['scale'],
  anchor: ReviewAnchor,
): RequestHandler {
  return (req: Request, res: Response) => {
    try {
      const { clientAddress, feedbackIndex } = req.params;
      if (!/^0x[0-9a-fA-F]{40}$/.test(clientAddress) || !/^[1-9][0-9]*$/.test(feedbackIndex)) {
        throw new ServiceError(
          'bad_request',
          'clientAddress must be a 0x address and feedbackIndex a positive integer',
        );
      }
      res.json(reviewProof(store, agentIdParam(req), clientAddress, feedbackIndex, scale, anchor));
    } catch (err) {
      sendError(res, err);
    }
  };
}
