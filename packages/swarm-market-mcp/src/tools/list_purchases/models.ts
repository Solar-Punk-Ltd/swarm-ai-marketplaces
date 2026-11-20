export interface ListPurchasesArgs {
  // Only purchases without a live review (none / uploaded-but-not-anchored / revoked).
  unreviewedOnly?: boolean;
}

export interface ListedPurchase {
  txHash: string;
  itemId: string;
  chainId: string;
  payTo: string;
  asset: string;
  amount: string;
  settledAt: string;
  reviewable: boolean; // the signed PurchaseIntent was recorded
  reviewState: 'none' | 'uploaded' | 'anchored' | 'revoked';
  agentId: string | null;
  feedbackIndex: string | null;
  feedbackURI: string | null;
}
