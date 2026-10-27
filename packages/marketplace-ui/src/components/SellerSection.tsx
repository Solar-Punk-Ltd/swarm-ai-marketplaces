import { useMemo, useState } from 'react';
import { config } from '../config/env';
import { useMarketplace } from '../context/MarketplaceContext';
import SellerRow from './SellerRow';
import OperatorDetails from './OperatorDetails';
import styles from './styles.module.css';

/** Skeleton cards on first load, so a real zero never looks like an unloaded value. */
function LoadingRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className={styles.sellerCard}>
          <div className={styles.sellerTop}>
            <span className={styles.skeleton} style={{ minWidth: 160 }} />
            <span className={styles.skeleton} style={{ minWidth: 120 }} />
          </div>
          <div className={styles.splitterRow}>
            <span className={styles.skeleton} style={{ minWidth: 180 }} />
            <span className={styles.skeleton} style={{ minWidth: 90 }} />
          </div>
        </div>
      ))}
    </>
  );
}

/** Verified agents first, then any other linked agent, then the rest. */
const STATUS_RANK: Record<string, number> = {
  verified: 0,
  unchecked: 1,
  unverified: 1,
  disputed: 2,
};

export default function SellerSection() {
  const { registry, loading, fundedSplitters, agentLinks, history } = useMarketplace();
  const [showOthers, setShowOthers] = useState(false);

  const sellers = registry?.sellers ?? [];

  /**
   * Agents first, so the rows a newcomer can make sense of are the ones they meet first: a named
   * agent with sales says far more about the marketplace than a bare splitter nobody has claimed.
   * Within a rank, most active first, with registry order as the stable tiebreak.
   *
   * Splitters with no agent and nothing to distribute are folded behind a toggle — they are real
   * registry entries, so never dropped, but on a demo factory they are mostly test clones. Not
   * when the agent sweep was cut short: then "no agent" proves nothing, so nothing is folded.
   */
  const { primary, others } = useMemo(() => {
    const funded = new Set(fundedSplitters.map((s) => s.toLowerCase()));
    const activity = new Map<string, number>();
    for (const entry of history.entries) {
      const key = entry.splitter.toLowerCase();
      activity.set(key, (activity.get(key) ?? 0) + 1);
    }
    const rank = (splitter: string) => {
      const link = agentLinks.bySplitter.get(splitter);
      return link ? (STATUS_RANK[link.status] ?? 2) : 3;
    };

    const ordered = sellers
      .map((record, index) => ({ record, index, key: record.splitter.toLowerCase() }))
      .sort(
        (a, b) =>
          rank(a.key) - rank(b.key) ||
          (activity.get(b.key) ?? 0) - (activity.get(a.key) ?? 0) ||
          a.index - b.index,
      );

    if (agentLinks.partial || !config.identityRegistry) {
      return { primary: ordered.map((o) => o.record), others: [] };
    }
    const isPrimary = (o: (typeof ordered)[number]) =>
      agentLinks.bySplitter.has(o.key) || funded.has(o.key);
    const primary = ordered.filter(isPrimary).map((o) => o.record);
    const others = ordered.filter((o) => !isPrimary(o)).map((o) => o.record);
    // Never fold everything away: with no agents at all, the splitters are all there is to show.
    return primary.length === 0 ? { primary: others, others: [] } : { primary, others };
  }, [sellers, fundedSplitters, history.entries, agentLinks]);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Sellers</h2>
        {registry && (
          <span className={styles.sectionMeta}>
            {sellers.length} registered · {fundedSplitters.length} funded
          </span>
        )}
      </div>

      {agentLinks.partial && (
        <div className={styles.banner}>
          Some agent names could not be loaded, so a seller without one may still be an agent.
          <OperatorDetails>
            The agent log sweep was cut short. Lower VITE_LOG_CHUNK_BLOCKS or use an RPC that allows
            wider ranges.
          </OperatorDetails>
        </div>
      )}

      {loading && !registry ? (
        <LoadingRows />
      ) : sellers.length === 0 ? (
        // splitterCount === 0 is the normal state on a fresh factory, not an error.
        <div className={styles.empty}>
          No sellers have deployed a splitter yet. A seller creates their own clone before listing,
          so this fills in as agents onboard.
        </div>
      ) : (
        <>
          {primary.map((record) => (
            <SellerRow key={record.splitter} record={record} />
          ))}
          {others.length > 0 && (
            <>
              <button
                type="button"
                className={styles.foldToggle}
                onClick={() => setShowOthers((v) => !v)}
                aria-expanded={showOthers}
              >
                {showOthers
                  ? 'Hide splitters with no agent'
                  : `Show ${others.length} more splitter${others.length === 1 ? '' : 's'} with no agent linked and nothing to distribute`}
              </button>
              {showOthers &&
                others.map((record) => <SellerRow key={record.splitter} record={record} />)}
            </>
          )}
        </>
      )}
    </section>
  );
}
