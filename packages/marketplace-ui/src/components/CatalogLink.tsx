import { useState } from 'react';
import type { Address } from 'viem';
import { useMarketplace } from '../context/MarketplaceContext';
import JsonDocumentDialog, { isPlainClick } from './JsonDocumentDialog';
import styles from './styles.module.css';

/**
 * Link out to this seller's Swarm catalog: `<gateway>/bzz/<manifest root>/catalog.jsonld`.
 *
 * The feed owner comes from the Agent Card's `swarm-ai-catalog` service entry, so this depends on
 * the same best-effort card fetch as the agent name — no card, no link. The manifest root then
 * costs a second gateway read, because the feed holds the root rather than being the catalog. Both
 * are read by the context (`refreshSwarmData`), never here, so the link appears a beat after the
 * row, the way the agent name does.
 *
 * It renders nothing when no catalog root resolves: a seller can legitimately hold a splitter and
 * publish no catalog, and neither an unfetchable card nor an unpublished feed is distinguishable
 * from that here. When the feed does name a root but the document behind it 404s — the usual
 * signature of an expired postage stamp — it says "Catalog unavailable" instead of linking.
 *
 * A plain click opens the document in `JsonDocumentDialog`, highlighted, over the dashboard. The
 * pill stays a real link to the raw file (see `isPlainClick`).
 */

function CatalogIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 5a2 2 0 0 1 2-2h4v18H6a2 2 0 0 1-2-2z" />
      <path d="M10 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-8" />
      <path d="M14 8h3M14 12h3" />
    </svg>
  );
}

export default function CatalogLink({ splitter }: { splitter: Address }) {
  const { agentLinks } = useMarketplace();

  const agent = agentLinks.bySplitter.get(splitter.toLowerCase());
  const card = agent?.card;
  const owner = card?.catalogFeedOwner;
  const link = agent?.catalog;
  const [open, setOpen] = useState(false);

  if (!owner || !link) return null;
  const href = link.url;

  // The feed names a catalog the gateway cannot serve. Said in words rather than hidden: the
  // seller did publish one, so a missing link would read as "never had a catalog".
  if (!link.available) {
    return (
      <span
        className={`${styles.pill} ${styles.pillMuted}`}
        title={`This seller published a catalog, but it can no longer be retrieved from Swarm — usually because the postage stamp that kept it stored has expired. (${href})`}
      >
        <CatalogIcon />
        Catalog unavailable
      </span>
    );
  }

  return (
    <>
      <a
        className={`${styles.pill} ${styles.pillAccent} ${styles.pillLink}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`View this seller's catalog (feed owner ${owner})`}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <CatalogIcon />
        Catalog
      </a>
      {open && (
        <JsonDocumentDialog
          url={href}
          kicker="Catalog · JSON-LD on Swarm"
          fallbackTitle={card?.name ?? 'Seller catalog'}
          immutable
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
