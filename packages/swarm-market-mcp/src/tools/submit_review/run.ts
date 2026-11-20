/**
 * submit_review core (CLAUDE.md "Review tools spec"). Dependencies are injected so the flow is
 * testable without Bee, an RPC or the marketplace.
 *
 * Steps: terms → score → stored purchase → PoP pre-flight → chain says no live review yet →
 * build review + chunks → stamps (marketplace envelopes, or own batch) → upload → giveFeedback.
 * `review_state` is persisted after the upload so a re-run resumes at giveFeedback instead of
 * publishing a second copy.
 */
import type { Bee, BatchId, EnvelopeWithBatchId } from '@ethersphere/bee-js';
import {
  buildContentChunks,
  buildReview,
  encodeFeedbackURI,
  envelopeFromWire,
  envelopeRequestDomain,
  parseReview,
  prepareReviewUpload,
  reviewFeedTopic,
  reviewHash,
  serializeReview,
  signEnvelopeRequest,
  type AnchoredReview,
  type PoPResult,
  type PostFeedbackParams,
  type PostFeedbackResult,
  type PreparedReviewUpload,
  type ProofOfPayment,
  type ReviewMarketplaceConfig,
} from '@solarpunk/erc8004-adapter';
import { toUtf8Bytes, toUtf8String, type Wallet } from 'ethers';
import type { BuyerStore, PurchaseRecord } from '../../buyer-store';
import { MAX_BATCH_WAIT_MS } from '../../constants';
import {
  ReviewToolError,
  isInsufficientFunds,
  toFixedPointScore,
  type MarketplaceApi,
  type MarketplaceTerms,
} from '../../reviews';
import { getErrorMessage } from '../../utils';
import type { SubmitReviewArgs, SubmitReviewResult } from './models';

export interface SubmitReviewDeps {
  store: BuyerStore;
  bee: Bee;
  wallet: Wallet;
  marketplace: MarketplaceApi;
  terms: MarketplaceTerms;
  verifyPoP(input: {
    agentId: bigint;
    clientAddress: string;
    proofOfPayment: ProofOfPayment;
  }): Promise<PoPResult>;
  findAnchoredPurchase(params: {
    agentId: bigint;
    clientAddress: string;
    txHash: string;
    fromBlock: number;
  }): Promise<AnchoredReview | null>;
  nextFeedIndex(owner: string, topic: string): Promise<bigint>;
  uploadChunks(
    prepared: PreparedReviewUpload,
    stampFor: (address: string) => EnvelopeWithBatchId | BatchId | string,
  ): Promise<void>;
  postFeedback(params: PostFeedbackParams): Promise<PostFeedbackResult>;
  sleep(ms: number): Promise<void>;
  nowSeconds(): number;
}

export async function runSubmitReview(
  args: SubmitReviewArgs,
  deps: SubmitReviewDeps,
): Promise<SubmitReviewResult> {
  const { store, wallet, terms } = deps;
  const agentId = parseAgentId(args.agentId);
  const value = toFixedPointScore(args.value, terms.score);
  const valueDecimals = terms.score.decimals;

  const purchase = store.getPurchase(args.txHash);
  if (!purchase) {
    throw new ReviewToolError(
      'purchase_not_found',
      `No recorded purchase for ${args.txHash}. Only purchases made through purchase_catalog_item can be reviewed.`,
    );
  }
  if (!purchase.purchaseIntent) {
    throw new ReviewToolError(
      'purchase_intent_missing',
      'The signed PurchaseIntent for this purchase was not recorded; it cannot be reviewed.',
    );
  }

  const proofOfPayment: ProofOfPayment = {
    fromAddress: wallet.address,
    toAddress: purchase.payTo,
    chainId: purchase.chainId,
    txHash: purchase.txHash,
    purchaseIntent: purchase.purchaseIntent,
  };

  // Pre-flight with the same rules the marketplace applies — fail before spending gas.
  const pop = await deps.verifyPoP({ agentId, clientAddress: wallet.address, proofOfPayment });
  if (!pop.valid) {
    throw new ReviewToolError('pop_invalid', `Proof-of-Purchase rejected: ${pop.reason}`, {
      reason: pop.reason,
    });
  }

  // The chain decides, not the local state (it may be stale, e.g. revoked from elsewhere).
  const anchored = await deps.findAnchoredPurchase({
    agentId,
    clientAddress: wallet.address,
    txHash: purchase.txHash,
    fromBlock: pop.settlementBlock,
  });
  if (anchored) {
    store.markAnchored(purchase.txHash, {
      agentId: agentId.toString(),
      feedbackIndex: anchored.event.feedbackIndex.toString(),
      feedbackUri: anchored.event.feedbackURI,
      feedbackHash: anchored.event.feedbackHash,
    });
    throw new ReviewToolError(
      'already_reviewed',
      'This purchase already has a live review. Revoke it first to replace it.',
      { feedbackIndex: anchored.event.feedbackIndex.toString() },
    );
  }

  const resumable = await resumableUpload(purchase, args, agentId, value, valueDecimals);
  let upload: { feedbackURI: string; feedbackHash: string; reference: string; feedIndex: bigint };
  let storage: SubmitReviewResult['storage'];
  if (resumable) {
    upload = resumable;
    storage = 'resumed';
  } else {
    if (purchase.reviewState !== 'none') store.resetReview(purchase.txHash);
    const published = await publishReview(args, deps, {
      agentId,
      value,
      valueDecimals,
      proofOfPayment,
      review: terms.review,
    });
    upload = published;
    storage = published.storage;
    store.markUploaded(purchase.txHash, {
      agentId: agentId.toString(),
      reviewJson: published.reviewJson,
      feedbackUri: published.feedbackURI,
      feedbackHash: published.feedbackHash,
    });
  }

  let anchoredResult: PostFeedbackResult;
  try {
    anchoredResult = await deps.postFeedback({
      agentId,
      value,
      valueDecimals,
      tag1: args.tag1,
      tag2: args.tag2,
      feedbackURI: upload.feedbackURI,
      feedbackHash: upload.feedbackHash,
    });
  } catch (err) {
    if (isInsufficientFunds(err)) {
      throw new ReviewToolError(
        'insufficient_gas',
        `The buyer wallet ${wallet.address} needs ETH on chain ${terms.review.chainId} for giveFeedback. ` +
          'The review is already on Swarm; re-run submit_review to anchor it.',
      );
    }
    throw new ReviewToolError(
      'give_feedback_failed',
      `giveFeedback failed: ${getErrorMessage(err)}. The review is already on Swarm; re-run submit_review to anchor it.`,
    );
  }

  store.markAnchored(purchase.txHash, {
    agentId: agentId.toString(),
    feedbackIndex: anchoredResult.feedbackIndex.toString(),
    feedbackTx: anchoredResult.txHash,
  });

  return {
    agentId: agentId.toString(),
    txHash: purchase.txHash,
    itemId: pop.itemId,
    feedbackIndex: anchoredResult.feedbackIndex.toString(),
    feedbackURI: upload.feedbackURI,
    feedbackHash: upload.feedbackHash,
    reviewReference: upload.reference,
    feedIndex: upload.feedIndex.toString(),
    giveFeedbackTxHash: anchoredResult.txHash,
    storage,
  };
}

async function publishReview(
  args: SubmitReviewArgs,
  deps: SubmitReviewDeps,
  ctx: {
    agentId: bigint;
    value: bigint;
    valueDecimals: number;
    proofOfPayment: ProofOfPayment;
    review: ReviewMarketplaceConfig;
  },
) {
  const { wallet } = deps;
  const review = buildReview({
    chainId: ctx.review.chainId,
    identityRegistry: ctx.review.identityRegistry,
    agentId: ctx.agentId,
    clientAddress: wallet.address,
    value: ctx.value,
    valueDecimals: ctx.valueDecimals,
    tag1: args.tag1,
    tag2: args.tag2,
    comment: args.comment,
    proofOfPayment: ctx.proofOfPayment,
  });
  const bytes = serializeReview(review);
  const topic = reviewFeedTopic(ctx.agentId);
  const feedIndex = await deps.nextFeedIndex(wallet.address, topic);
  const prepared = await prepareReviewUpload({
    bee: deps.bee,
    reviewBytes: bytes,
    signerPrivateKey: wallet.privateKey,
    topic,
    index: feedIndex,
  });

  let stampFor: (address: string) => EnvelopeWithBatchId | string;
  let storage: 'marketplace-envelopes' | 'self-funded';
  if (args.postageBatchId) {
    const batchId = args.postageBatchId;
    stampFor = () => batchId;
    storage = 'self-funded';
  } else {
    const envelopes = await requestEnvelopes(deps, ctx, prepared.chunkAddresses);
    stampFor = (address) => {
      const envelope = envelopes.get(address);
      if (!envelope) throw new Error(`No envelope issued for chunk ${address}`);
      return envelope;
    };
    storage = 'marketplace-envelopes';
  }

  try {
    await deps.uploadChunks(prepared, stampFor);
  } catch (err) {
    throw new ReviewToolError(
      'upload_failed',
      `Uploading the review failed: ${getErrorMessage(err)}. Safe to retry.`,
    );
  }

  return {
    reviewJson: toUtf8String(bytes),
    reference: prepared.reference,
    feedIndex,
    feedbackURI: encodeFeedbackURI({ owner: wallet.address, topic, index: feedIndex }),
    feedbackHash: reviewHash(bytes),
    storage,
  };
}

/** Signed envelope request; waits (bounded) while the seller's new batch becomes usable. */
async function requestEnvelopes(
  deps: SubmitReviewDeps,
  ctx: { agentId: bigint; proofOfPayment: ProofOfPayment; review: ReviewMarketplaceConfig },
  chunkAddresses: string[],
): Promise<Map<string, EnvelopeWithBatchId>> {
  const domain = envelopeRequestDomain(ctx.review.chainId, ctx.review.splitterFactory);
  let waitedMs = 0;
  for (;;) {
    const timestamp = deps.nowSeconds();
    const signature = await signEnvelopeRequest(deps.wallet, domain, {
      agentId: ctx.agentId,
      txHash: ctx.proofOfPayment.txHash,
      chunkAddresses,
      timestamp: BigInt(timestamp),
    });
    const res = await deps.marketplace.requestEnvelopes({
      agentId: ctx.agentId.toString(),
      proofOfPayment: ctx.proofOfPayment,
      chunkAddresses,
      timestamp,
      signature,
    });
    if (res.ok) {
      return new Map(res.envelopes.map((e) => [e.address, envelopeFromWire(e)]));
    }

    const retryAfter = Number(res.error.details?.retryAfter ?? 0);
    if (
      res.error.error === 'batch_unavailable' &&
      waitedMs + retryAfter * 1000 <= MAX_BATCH_WAIT_MS
    ) {
      await deps.sleep(retryAfter * 1000);
      waitedMs += retryAfter * 1000;
      continue;
    }

    const passthrough = [
      'pop_invalid',
      'pop_already_claimed',
      'envelope_quota_exceeded',
      'batch_unavailable',
    ];
    const code = passthrough.includes(res.error.error) ? res.error.error : 'envelope_denied';
    const hint =
      code === 'envelope_quota_exceeded' || code === 'envelope_denied'
        ? ' Retry with postageBatchId to pay for storage yourself.'
        : code === 'batch_unavailable'
          ? ' The seller’s review batch is still being bought; retry later.'
          : '';
    throw new ReviewToolError(code, `${res.error.message}.${hint}`, {
      status: res.status,
      ...res.error.details,
    });
  }
}

/**
 * The stored upload can be anchored as-is only if it is this same review (same seller, score and
 * text); otherwise a changed review is published fresh.
 */
async function resumableUpload(
  purchase: PurchaseRecord,
  args: SubmitReviewArgs,
  agentId: bigint,
  value: bigint,
  valueDecimals: number,
) {
  if (
    purchase.reviewState !== 'uploaded' ||
    purchase.agentId !== agentId.toString() ||
    !purchase.reviewJson ||
    !purchase.feedbackUri ||
    !purchase.feedbackHash
  ) {
    return null;
  }
  const bytes = toUtf8Bytes(purchase.reviewJson);
  if (reviewHash(bytes) !== purchase.feedbackHash) return null;
  const stored = parseReview(bytes);
  const same =
    BigInt(stored.value) === value &&
    stored.valueDecimals === valueDecimals &&
    (stored.comment ?? '') === (args.comment ?? '') &&
    (stored.tag1 ?? '') === (args.tag1 ?? '') &&
    (stored.tag2 ?? '') === (args.tag2 ?? '');
  if (!same) return null;

  const { reference } = await buildContentChunks(bytes);
  return {
    feedbackURI: purchase.feedbackUri,
    feedbackHash: purchase.feedbackHash,
    reference,
    feedIndex: BigInt(purchase.feedbackUri.slice(purchase.feedbackUri.lastIndexOf('/') + 1)),
  };
}

function parseAgentId(raw: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ReviewToolError(
      'bad_request',
      `agentId must be a non-negative integer, got "${raw}"`,
    );
  }
  return BigInt(raw);
}
