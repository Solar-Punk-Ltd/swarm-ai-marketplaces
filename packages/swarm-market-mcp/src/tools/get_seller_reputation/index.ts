/**
 * MCP Tool: get_seller_reputation
 *
 * A seller's Sybil-resistant reputation: only reviews anchored on-chain AND backed by a valid
 * Proof-of-Purchase count. Uses the marketplace indexer when it exists; otherwise (and with
 * `verify`) checks the chain itself. Read-only — no gas. Logic: ./run.ts.
 */
import type { Bee } from '@ethersphere/bee-js';
import { RECENT_BLOCK_COUNT, verifyPoP, verifyReview } from '@solarpunk/erc8004-adapter';
import config from '../../config';
import { loadTerms, readChain, resolveMarketplace, toolError } from '../../reviews';
import { getResponseWithStructuredContent, ToolResponse } from '../../utils';
import type { GetSellerReputationArgs } from './models';
import { runGetSellerReputation } from './run';

export async function getSellerReputation(
  args: GetSellerReputationArgs,
  bee: Bee,
): Promise<ToolResponse> {
  try {
    const marketplace = resolveMarketplace(args.marketplaceServiceUrl);
    const terms = await loadTerms(marketplace);
    const chain = readChain(terms);
    const reputation = chain.erc8004.reputation;
    const chunkSize = config.review.logRangeMax;

    const result = await runGetSellerReputation(args, {
      terms,
      indexerReputation: (agentId) => marketplace.getSellerReputation(agentId),
      latestBlock: () => chain.provider.getBlockNumber(),
      defaultFromBlock: (latest) => latest - RECENT_BLOCK_COUNT,
      getClients: (agentId, blockTag) => reputation.getClients(agentId, blockTag),
      readAllFeedback: (agentId, clients, blockTag) =>
        reputation.readAllFeedback(agentId, clients, { blockTag }),
      getNewFeedbackEvents: (agentId, options) =>
        reputation.getNewFeedbackEvents(agentId, { ...options, chunkSize }),
      getFeedbackRevokedEvents: (agentId, options) =>
        reputation.getFeedbackRevokedEvents(agentId, { ...options, chunkSize }),
      verifyReview: (entry) => verifyReview(entry, { bee, config: terms.review }),
      verifyPoP: (input) => verifyPoP(input, chain.reader, terms.review),
      blockTimestamp: async (block) => (await chain.provider.getBlock(block))?.timestamp ?? 0,
    });

    return getResponseWithStructuredContent(result);
  } catch (err) {
    return toolError(err);
  }
}
