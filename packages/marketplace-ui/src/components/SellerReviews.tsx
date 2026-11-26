import { useEffect, useState } from 'react';
import { config } from '../config/env';
import { txUrl } from '../config/chain';
import {
  fetchSellerReviews,
  formatScore,
  type SellerReputation,
  type SellerReview,
} from '../lib/reputation';
import AddressLink from './AddressLink';
import JsonDocumentDialog, { isPlainClick } from './JsonDocumentDialog';
import styles from './styles.module.css';

type Load =
  | { state: 'loading' }
  | { state: 'ok'; reviews: SellerReview[] }
  | { state: 'failed'; message: string };

const STATUS_LABEL: Record<SellerReview['status'], string> = {
  counted: 'counted',
  pending: 'verifying',
  not_counted: 'not counted',
};

/** Why a review is left out of the score, in words. Unknown reasons are shown as they come. */
function reasonText(reason: string | null): string | undefined {
  if (!reason) return undefined;
  if (reason === 'purchase_already_reviewed')
    return 'An earlier review already covers this purchase.';
  if (reason.startsWith('pop:')) return `Proof-of-Purchase failed: ${reason.slice(4)}.`;
  if (reason.startsWith('rpc:')) return 'Not verified yet: the chain could not be read.';
  return `Review rejected: ${reason}.`;
}

/**
 * The reviews behind a seller's score, folded under the details ledger. Fetched when opened and
 * again when the indexer reports a new review — never on the context's tick. Each review links to
 * the `giveFeedback` transaction that anchors it on-chain, and to the purchase it was written for.
 */
export default function SellerReviews({
  agentId,
  reputation,
}: {
  agentId: string;
  reputation: SellerReputation;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const baseUrl = config.marketplaceServiceUrl;
  // Changes exactly when a review is anchored, revoked or verified.
  const version = `${reputation.checkpoint.lastEvent?.txHash}:${reputation.count}:${reputation.pendingCount}`;

  useEffect(() => {
    if (!open || !baseUrl) return;
    const controller = new AbortController();
    fetchSellerReviews(baseUrl, agentId, controller.signal)
      .then((reviews) => setLoad({ state: 'ok', reviews }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          state: 'failed',
          message: err instanceof Error ? err.message : 'Could not load the reviews.',
        });
      });
    return () => controller.abort();
  }, [open, baseUrl, agentId, version, attempt]);

  if (!baseUrl || reputation.count === 0) return null;

  return (
    <div>
      <button
        type="button"
        className={styles.historyToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} reviews
        <span className={styles.historyCount}>{reputation.count}</span>
      </button>

      {open && (
        <div className={styles.reviewList}>
          {load.state === 'loading' && <div className={styles.reviewNote}>Loading reviews…</div>}
          {load.state === 'failed' && (
            <div className={styles.reviewNote}>
              {load.message}{' '}
              <button
                type="button"
                className={styles.historyToggle}
                onClick={() => {
                  setLoad({ state: 'loading' });
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </div>
          )}
          {load.state === 'ok' &&
            load.reviews.map((review) => (
              <ReviewItem
                key={`${review.clientAddress}:${review.feedbackIndex}`}
                proofDocUrl={`${baseUrl}/v1/sellers/${agentId}/reviews/${review.clientAddress}/${review.feedbackIndex}/proof`}
                review={review}
                scale={reputation.scale}
              />
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * One review. "on-chain proof" opens the review's evidence in `JsonDocumentDialog`: its
 * `giveFeedback` anchor next to the Proof-of-Purchase from the hash-checked review file. The link
 * itself stays the explorer's page for that transaction, for modified clicks (see `isPlainClick`).
 */
function ReviewItem({
  review,
  scale,
  proofDocUrl,
}: {
  review: SellerReview;
  scale: SellerReputation['scale'];
  proofDocUrl: string;
}) {
  const [proofOpen, setProofOpen] = useState(false);
  const proofUrl = txUrl(config.chain, review.anchorTx) ?? proofDocUrl;
  const purchaseUrl = review.purchaseTx ? txUrl(config.chain, review.purchaseTx) : undefined;
  const counted = review.status === 'counted';

  return (
    <article className={`${styles.review} ${counted ? '' : styles.reviewDimmed}`}>
      <div className={styles.reviewHead}>
        <span className={styles.reputationScore}>
          ★ {formatScore(review.value, scale)}
          <span className={styles.reputationMuted}>/{scale.max}</span>
        </span>
        <span
          className={`${styles.reviewStatus} ${counted ? styles.reviewStatusCounted : ''}`}
          title={reasonText(review.reason)}
        >
          {STATUS_LABEL[review.status]}
        </span>
        <AddressLink address={review.clientAddress} label="Buyer" />
        {review.reviewedAt && (
          <span className={styles.reviewMuted}>{new Date(review.reviewedAt).toLocaleString()}</span>
        )}
      </div>

      {review.comment ? (
        <p className={styles.reviewComment}>{review.comment}</p>
      ) : (
        <p className={styles.reviewMuted}>
          {review.status === 'pending' ? 'Comment appears once verified.' : 'No comment.'}
        </p>
      )}

      <div className={styles.reviewLinks}>
        <a
          className={styles.historyTx}
          href={proofUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Show the giveFeedback transaction that anchors this review and the Proof-of-Purchase it cites."
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            setProofOpen(true);
          }}
        >
          on-chain proof ↗
        </a>
        {purchaseUrl && (
          <a
            className={styles.historyTx}
            href={purchaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="The purchase this review's Proof-of-Purchase cites."
          >
            purchase ↗
          </a>
        )}
      </div>

      {proofOpen && (
        <JsonDocumentDialog
          url={proofDocUrl}
          kicker={`Review proof · ERC-8004 feedback #${review.feedbackIndex}`}
          fallbackTitle={`★ ${formatScore(review.value, scale)}/${scale.max} · ${STATUS_LABEL[review.status]}`}
          source="marketplace service"
          onClose={() => setProofOpen(false)}
        />
      )}
    </article>
  );
}
