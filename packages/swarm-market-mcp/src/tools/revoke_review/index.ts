/**
 * MCP Tool: revoke_review
 *
 * Revokes the buyer's own review on-chain (ERC-8004 revokeFeedback, signed by BUYER_WALLET_PK).
 * The purchase is then free to be reviewed again. Logic: ./run.ts.
 */
import { buyerStore, loadTerms, resolveMarketplace, reviewChain, toolError } from '../../reviews';
import { getResponseWithStructuredContent, ToolResponse } from '../../utils';
import type { RevokeReviewArgs } from './models';
import { runRevokeReview } from './run';

export async function revokeReview(args: RevokeReviewArgs): Promise<ToolResponse> {
  try {
    const terms = await loadTerms(resolveMarketplace(args.marketplaceServiceUrl));
    const chain = reviewChain(terms);
    const reputation = chain.erc8004.reputation;

    const result = await runRevokeReview(args, {
      store: buyerStore(),
      buyer: chain.wallet.address,
      getFeedback: (agentId, client, index) => reputation.getFeedback(agentId, client, index),
      revokeFeedback: (agentId, index) => reputation.revokeFeedback(agentId, index),
    });

    return getResponseWithStructuredContent({
      ...result,
      message: `Revoked feedback #${result.feedbackIndex} for agent ${result.agentId}.`,
    });
  } catch (err) {
    return toolError(err);
  }
}
