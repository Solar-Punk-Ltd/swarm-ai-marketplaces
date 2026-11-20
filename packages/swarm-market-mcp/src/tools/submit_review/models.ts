export interface SubmitReviewArgs {
  // Settlement tx of the purchase being reviewed (from purchase_catalog_item / list_purchases).
  txHash: string;
  // The seller's ERC-8004 agent id.
  agentId: string;
  // Score on the marketplace's scale (GET /v1/reviews/config → score), e.g. 87 or 4.5.
  value: number;
  // Review text — stored in the review file on Swarm, never on-chain.
  comment?: string;
  tag1?: string;
  tag2?: string;
  // Self-fund storage with this batch instead of requesting envelopes from the marketplace.
  postageBatchId?: string;
  // Falls back to MARKETPLACE_SERVICE_URL.
  marketplaceServiceUrl?: string;
}

export interface SubmitReviewResult {
  agentId: string;
  txHash: string;
  itemId: string;
  feedbackIndex: string;
  feedbackURI: string;
  feedbackHash: string;
  reviewReference: string;
  feedIndex: string;
  giveFeedbackTxHash: string;
  storage: 'marketplace-envelopes' | 'self-funded' | 'resumed';
}
