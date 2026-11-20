import { useMarketplace } from '../context/MarketplaceContext';
import type { AgentLink } from '../lib/agents';
import { formatScore } from '../lib/reputation';
import styles from './styles.module.css';

/**
 * The seller's score, in one mono line: `★ 87/100 · 3 reviews`. Only reviews that are anchored
 * on-chain and backed by a valid Proof-of-Purchase count — the tooltip says so, and what is still
 * being verified. Renders nothing without a marketplace service, a verified agent, or an answer.
 */
export default function ReputationBadge({ link }: { link: AgentLink | undefined }) {
  const { reputations } = useMarketplace();
  if (!link || link.status !== 'verified') return null;
  const entry = reputations.get(link.agentId.toString());
  if (!entry || entry.state === 'unavailable') return null;

  if (entry.state === 'syncing') {
    return (
      <span className={styles.reputation} title="The reputation indexer is still catching up.">
        <span className={styles.reputationMuted}>reviews syncing…</span>
      </span>
    );
  }

  const { score, scale, popValidCount, pendingCount, count } = entry.reputation;
  const reviews = `${popValidCount} review${popValidCount === 1 ? '' : 's'}`;
  const notCounted = count - popValidCount - pendingCount;
  const tooltip = [
    'Counts only reviews anchored on-chain and backed by a valid Proof-of-Purchase, one per purchase.',
    notCounted > 0 ? `${notCounted} anchored review(s) did not qualify.` : '',
    pendingCount > 0 ? `${pendingCount} still being verified.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={styles.reputation} title={tooltip}>
      {score === null ? (
        <span className={styles.reputationMuted}>no reviews</span>
      ) : (
        <>
          <span className={styles.reputationScore}>★ {formatScore(score, scale)}</span>
          <span className={styles.reputationMuted}>/{scale.max}</span>
          <span className={styles.reputationMuted}> · {reviews}</span>
        </>
      )}
    </span>
  );
}
