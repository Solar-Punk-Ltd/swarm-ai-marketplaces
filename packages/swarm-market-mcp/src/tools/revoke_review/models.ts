export interface RevokeReviewArgs {
  // The reviewed purchase; its agentId + feedbackIndex come from the buyer store.
  txHash?: string;
  // Or name the feedback entry directly.
  agentId?: string;
  feedbackIndex?: string;
  // Only used to learn the registry addresses; falls back to MARKETPLACE_SERVICE_URL.
  marketplaceServiceUrl?: string;
}

export interface RevokeReviewResult {
  agentId: string;
  feedbackIndex: string;
  revokeTxHash: string;
  txHash?: string; // the purchase, when known — it can now be reviewed again
}
