/**
 * revoke_review core. The on-chain revokeFeedback is authoritative; a Swarm tombstone is out of
 * prototype scope. Revoking frees the purchase: submit_review may then publish a replacement.
 */
import type { FeedbackResult } from '@solarpunk/erc8004-adapter';
import type { BuyerStore } from '../../buyer-store';
import { ReviewToolError, isInsufficientFunds } from '../../reviews';
import { getErrorMessage } from '../../utils';
import type { RevokeReviewArgs, RevokeReviewResult } from './models';

export interface RevokeReviewDeps {
  store: BuyerStore;
  buyer: string;
  getFeedback(agentId: bigint, client: string, feedbackIndex: bigint): Promise<FeedbackResult>;
  revokeFeedback(agentId: bigint, feedbackIndex: bigint): Promise<string>;
}

export async function runRevokeReview(
  args: RevokeReviewArgs,
  deps: RevokeReviewDeps,
): Promise<RevokeReviewResult> {
  const { agentId, feedbackIndex, txHash } = resolveTarget(args, deps.store);

  // Read as the buyer: entries are keyed by client, so another wallet's review is simply absent.
  let feedback: FeedbackResult;
  try {
    feedback = await deps.getFeedback(agentId, deps.buyer, feedbackIndex);
  } catch {
    throw new ReviewToolError(
      'review_not_found',
      `No feedback #${feedbackIndex} from ${deps.buyer} for agent ${agentId}.`,
    );
  }
  if (feedback.isRevoked) {
    if (txHash) deps.store.markRevoked(txHash);
    throw new ReviewToolError('already_revoked', `Feedback #${feedbackIndex} is already revoked.`);
  }

  let revokeTxHash: string;
  try {
    revokeTxHash = await deps.revokeFeedback(agentId, feedbackIndex);
  } catch (err) {
    if (isInsufficientFunds(err)) {
      throw new ReviewToolError(
        'insufficient_gas',
        `The buyer wallet ${deps.buyer} needs ETH for revokeFeedback.`,
      );
    }
    throw new ReviewToolError('revoke_failed', `revokeFeedback failed: ${getErrorMessage(err)}`);
  }
  if (txHash) deps.store.markRevoked(txHash);

  return {
    agentId: agentId.toString(),
    feedbackIndex: feedbackIndex.toString(),
    revokeTxHash,
    ...(txHash ? { txHash } : {}),
  };
}

function resolveTarget(args: RevokeReviewArgs, store: BuyerStore) {
  if (args.txHash) {
    const purchase = store.getPurchase(args.txHash);
    if (!purchase?.agentId || !purchase.feedbackIndex) {
      throw new ReviewToolError(
        'review_not_found',
        `No anchored review recorded for purchase ${args.txHash}. Pass agentId + feedbackIndex instead.`,
      );
    }
    return {
      agentId: BigInt(purchase.agentId),
      feedbackIndex: BigInt(purchase.feedbackIndex),
      txHash: purchase.txHash,
    };
  }
  if (!args.agentId || !args.feedbackIndex) {
    throw new ReviewToolError('bad_request', 'Pass txHash, or agentId + feedbackIndex.');
  }
  if (!/^[0-9]+$/.test(args.agentId) || !/^[0-9]+$/.test(args.feedbackIndex)) {
    throw new ReviewToolError('bad_request', 'agentId and feedbackIndex must be integers.');
  }
  const known = store.findByFeedback(args.agentId, args.feedbackIndex);
  return {
    agentId: BigInt(args.agentId),
    feedbackIndex: BigInt(args.feedbackIndex),
    txHash: known?.txHash,
  };
}
