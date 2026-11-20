/**
 * MCP Tool: submit_review
 *
 * Writes a review of a purchase to the buyer's own Swarm feed and anchors it on-chain with
 * ERC-8004 giveFeedback, all signed by BUYER_WALLET_PK (the key that paid). Storage is paid by
 * the marketplace (envelopes from marketplace-service) or, with postageBatchId, by the buyer.
 * Runs locally — the marketplace never holds a reviewer's key. Logic: ./run.ts.
 */
import type { Bee } from '@ethersphere/bee-js';
import {
  findAnchoredPurchase,
  nextFeedIndex,
  uploadReviewChunks,
  verifyPoP,
} from '@solarpunk/erc8004-adapter';
import config from '../../config';
import { buyerStore, loadTerms, resolveMarketplace, reviewChain, toolError } from '../../reviews';
import { getResponseWithStructuredContent, ToolResponse } from '../../utils';
import type { SubmitReviewArgs } from './models';
import { runSubmitReview } from './run';

export async function submitReview(args: SubmitReviewArgs, bee: Bee): Promise<ToolResponse> {
  try {
    const marketplace = resolveMarketplace(args.marketplaceServiceUrl);
    const terms = await loadTerms(marketplace);
    const chain = reviewChain(terms);

    const result = await runSubmitReview(args, {
      store: buyerStore(),
      bee,
      wallet: chain.wallet,
      marketplace,
      terms,
      verifyPoP: (input) => verifyPoP(input, chain.reader, terms.review),
      findAnchoredPurchase: (params) =>
        findAnchoredPurchase(
          { reputation: chain.erc8004.reputation, bee, config: terms.review },
          { ...params, chunkSize: config.review.logRangeMax },
        ),
      nextFeedIndex: (owner, topic) => nextFeedIndex(bee, owner, topic),
      uploadChunks: (prepared, stampFor) => uploadReviewChunks(bee, prepared, stampFor),
      postFeedback: (params) => chain.erc8004.reputation.postFeedback(params),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      nowSeconds: () => Math.floor(Date.now() / 1000),
    });

    return getResponseWithStructuredContent({
      ...result,
      message: `Review of purchase ${result.txHash} anchored as feedback #${result.feedbackIndex} for agent ${result.agentId}.`,
    });
  } catch (err) {
    return toolError(err);
  }
}
