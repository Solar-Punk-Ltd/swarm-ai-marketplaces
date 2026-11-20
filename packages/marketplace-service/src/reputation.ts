import type { Request, RequestHandler, Response } from 'express';
import type { IndexStore } from './index-store.js';
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

/**
 * Rule C at read time: a review counts if it is anchored, not revoked, and verified; one per
 * purchase — the earliest such review from the payer (verifyPoP already pinned client = payer).
 * Computing it here, not at ingest, lets a revocation free its purchase for a later review.
 */
export function sellerReputation(
  store: IndexStore,
  agentId: string,
  scale: SellerReputation['scale'],
): SellerReputation {
  const checkpoint = store.getCheckpoint();
  if (checkpoint === null) {
    throw new ServiceError('indexer_unavailable', 'The indexer has not completed its first pass');
  }

  const live = store.reviewsFor(agentId).filter((r) => !r.revoked);
  const claimed = new Set<string>();
  const winners = live.filter((r) => {
    if (r.status !== 'valid' || !r.purchaseTx || claimed.has(r.purchaseTx)) return false;
    claimed.add(r.purchaseTx);
    return true;
  });

  const values = winners.map((r) => Number(r.value) / 10 ** r.valueDecimals);
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

/** GET /v1/sellers/:agentId/reputation — a cache answer; buyers verify against the chain. */
export function reputationHandler(
  store: IndexStore,
  scale: SellerReputation['scale'],
): RequestHandler {
  return (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      if (!/^(0|[1-9][0-9]*)$/.test(agentId)) {
        throw new ServiceError('bad_request', 'agentId must be a non-negative integer');
      }
      res.json(sellerReputation(store, agentId, scale));
    } catch (err) {
      sendError(res, err);
    }
  };
}
