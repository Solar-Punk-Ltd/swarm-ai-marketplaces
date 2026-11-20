export interface GetSellerReputationArgs {
  agentId: string;
  // Commitment phase: check the indexer's answer against the chain (census + per-review checks).
  // Ignored when there is no indexer — the chain path always verifies what it scores.
  verify?: boolean;
  // Verify at most this many reviews (most recent first). Default: all in the scanned window.
  sample?: number;
  // First block of the NewFeedback scan (feedbackURI exists only in events). Default: the last
  // RECENT_BLOCK_COUNT blocks. Reviews before it are counted but not verified (`unscanned`).
  fromBlock?: number;
  // Indexer + marketplace terms; falls back to MARKETPLACE_SERVICE_URL.
  marketplaceServiceUrl?: string;
}

export interface InvalidReview {
  feedbackIndex: string;
  clientAddress: string;
  reason: string;
}

export interface VerifiedReview {
  feedbackIndex: string;
  clientAddress: string;
  value: number;
  comment?: string;
  createdAt: string;
  itemId: string;
}

export interface SellerReputation {
  agentId: string;
  score: number | null; // average of PoP-valid reviews, on the marketplace's scale
  scale: { min: number; max: number; decimals: number };
  count: number; // anchored, non-revoked entries (census)
  popValidCount: number;
  lastReviewAt: string | null;
  checkpoint: { block: number; lastEvent: { block: number; txHash: string } | null };
  source: 'indexer' | 'chain';
  scannedFromBlock?: number;
  unscanned?: number; // live entries older than scannedFromBlock, not verified
  verification?: { censusComplete: boolean; checked: number; invalid: InvalidReview[] };
  reviews?: VerifiedReview[];
}
