/**
 * MCP Tool: list_purchases
 *
 * Lists purchases recorded by purchase_catalog_item in the local buyer store, so an agent can find
 * the txHash to pass to submit_review. Local read only. `reviewState` is the local view; the chain
 * stays authoritative (submit_review re-checks it).
 */
import { buyerStore, toolError } from '../../reviews';
import { getResponseWithStructuredContent, ToolResponse } from '../../utils';
import type { ListedPurchase, ListPurchasesArgs } from './models';

export async function listPurchases(args: ListPurchasesArgs): Promise<ToolResponse> {
  try {
    const purchases: ListedPurchase[] = buyerStore()
      .listPurchases(args.unreviewedOnly ?? false)
      .map((p) => ({
        txHash: p.txHash,
        itemId: p.itemId,
        chainId: p.chainId,
        payTo: p.payTo,
        asset: p.asset,
        amount: p.amount,
        settledAt: p.settledAt,
        reviewable: p.purchaseIntent !== null,
        reviewState: p.reviewState,
        agentId: p.agentId,
        feedbackIndex: p.feedbackIndex,
        feedbackURI: p.feedbackUri,
      }));
    return getResponseWithStructuredContent({ count: purchases.length, purchases });
  } catch (err) {
    return toolError(err);
  }
}
