/**
 * Read-side checks: does an on-chain feedback entry resolve to an authentic, consistent review, and
 * has a purchase already been used for one (PoP rule 4)?
 */
import type { Bee } from '@ethersphere/bee-js';
import type { ReputationModule } from '../reputation';
import type { LogQueryOptions, NewFeedbackEvent } from '../../types';
import { parseReview, reviewHash } from './document';
import { referenceFromFeedPayload } from './feed';
import {
  feedIdentifier,
  parseCaip10,
  parseFeedbackURI,
  reviewFeedTopic,
  sameAddress,
  toCaip10,
} from './identifiers';
import type { ReviewDocument, ReviewMarketplaceConfig, ReviewVerification } from './types';

/**
 * Resolves `entry.feedbackURI` and checks it against the on-chain entry:
 * the feed update is signed by `clientAddress` on the seller's topic, its payload points at a file
 * whose keccak256 is `feedbackHash`, and the file's fields match the chain and the marketplace.
 * Does not check PoP — run `verifyPoP` on the returned review for that.
 */
export async function verifyReview(
  entry: Pick<
    NewFeedbackEvent,
    'agentId' | 'clientAddress' | 'value' | 'valueDecimals' | 'feedbackURI' | 'feedbackHash'
  >,
  deps: { bee: Bee; config: Pick<ReviewMarketplaceConfig, 'chainId' | 'identityRegistry'> },
): Promise<ReviewVerification> {
  const coords = parseFeedbackURI(entry.feedbackURI);
  if (!coords) return { valid: false, reason: 'uri_malformed' };
  if (!sameAddress(coords.owner, entry.clientAddress)) {
    return { valid: false, reason: 'uri_owner_mismatch' };
  }
  if (coords.topic !== reviewFeedTopic(entry.agentId).toLowerCase()) {
    return { valid: false, reason: 'topic_mismatch' };
  }

  // makeSOCReader verifies the signature: it recomputes the address from the recovered signer.
  let payload: Uint8Array;
  try {
    const soc = await deps.bee
      .makeSOCReader(coords.owner)
      .download(feedIdentifier(coords.topic, coords.index).slice(2));
    payload = soc.payload.toUint8Array();
  } catch (err) {
    return { valid: false, reason: 'soc_unavailable', detail: (err as Error).message };
  }

  const reference = referenceFromFeedPayload(payload);
  if (!reference) return { valid: false, reason: 'payload_malformed' };

  let bytes: Uint8Array;
  try {
    bytes = (await deps.bee.downloadData(reference)).toUint8Array();
  } catch (err) {
    return { valid: false, reason: 'content_unavailable', detail: (err as Error).message };
  }
  if (reviewHash(bytes) !== entry.feedbackHash.toLowerCase()) {
    return { valid: false, reason: 'hash_mismatch' };
  }

  let review: ReviewDocument;
  try {
    review = parseReview(bytes);
  } catch (err) {
    return { valid: false, reason: 'json_malformed', detail: (err as Error).message };
  }

  const mismatch = findFieldMismatch(review, entry, deps.config);
  if (mismatch) return { valid: false, reason: 'field_mismatch', detail: mismatch };

  return { valid: true, review, reference };
}

/** The JSON must say what the chain says. Scores always use the on-chain value. */
function findFieldMismatch(
  review: ReviewDocument,
  entry: Pick<NewFeedbackEvent, 'agentId' | 'clientAddress' | 'value' | 'valueDecimals'>,
  config: Pick<ReviewMarketplaceConfig, 'chainId' | 'identityRegistry'>,
): string | null {
  if (BigInt(review.agentId) !== entry.agentId) return 'agentId';
  if (BigInt(review.value) !== entry.value) return 'value';
  if (review.valueDecimals !== entry.valueDecimals) return 'valueDecimals';

  const client = parseCaip10(review.clientAddress);
  if (
    !client ||
    client.chainId !== config.chainId ||
    !sameAddress(client.address, entry.clientAddress)
  ) {
    return 'clientAddress';
  }
  if (
    review.agentRegistry.toLowerCase() !==
    toCaip10(config.chainId, config.identityRegistry).toLowerCase()
  ) {
    return 'agentRegistry';
  }
  if (review.proofOfPayment.chainId !== config.chainId.toString()) return 'proofOfPayment.chainId';
  return null;
}

export interface AnchoredReview {
  event: NewFeedbackEvent;
  review: ReviewDocument;
}

/**
 * The buyer's non-revoked review that already claims `txHash`, or null (PoP rule 4).
 *
 * Only the payer's own entries can claim a purchase, so the scan is filtered by `clientAddress`.
 * `feedbackURI` exists only in the event, so this must scan logs: start at the settlement block
 * (nothing can cite a purchase before it happened) and page with `chunkSize`.
 */
export async function findAnchoredPurchase(
  deps: {
    reputation: ReputationModule;
    bee: Bee;
    config: Pick<ReviewMarketplaceConfig, 'chainId' | 'identityRegistry'>;
  },
  params: { agentId: bigint; clientAddress: string; txHash: string } & LogQueryOptions,
): Promise<AnchoredReview | null> {
  const [events, revocations] = await Promise.all([
    deps.reputation.getNewFeedbackEvents(params.agentId, params),
    deps.reputation.getFeedbackRevokedEvents(params.agentId, params),
  ]);
  const revoked = new Set(revocations.map((r) => r.feedbackIndex));

  const ordered = [...events].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
  for (const event of ordered) {
    if (revoked.has(event.feedbackIndex)) continue;
    const result = await verifyReview(event, deps);
    // An entry whose content can't be fetched or doesn't match cites nothing.
    if (!result.valid) continue;
    if (result.review.proofOfPayment.txHash.toLowerCase() === params.txHash.toLowerCase()) {
      return { event, review: result.review };
    }
  }
  return null;
}
