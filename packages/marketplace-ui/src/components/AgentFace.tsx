import { useEffect, useState } from 'react';
import type { AgentLink } from '../lib/agents';
import { SellerIcon } from './icons';
import styles from './styles.module.css';

/**
 * A seller's face: its own avatar from its Agent Card once that image has loaded, the seller stall
 * until then and whenever it does not.
 *
 * Verified links only, as on the map (CLAUDE.md → "Verified only"): a picture reads as identity far
 * more strongly than a name, and an unverified or disputed claim must not borrow that. The image
 * is a third-party URL its own subject controls, so it is only ever an `<img>` — never markup.
 *
 * Loaded and failed URLs are remembered for the page's life. The stall is what shows while an
 * image is in flight — an empty ring would read as a broken picture — and a dead image (the shared
 * default every card is created with currently is one) is never asked for twice.
 */
const loaded = new Set<string>();
const failed = new Set<string>();

export default function AgentFace({
  link,
  size,
  muted,
}: {
  link: AgentLink | undefined;
  size: number;
  /** Dim the stall, for a splitter no agent has claimed. */
  muted?: boolean;
}) {
  const url = link?.status === 'verified' ? link.card?.image : undefined;
  const [ready, setReady] = useState(() => (url ? loaded.has(url) : false));

  useEffect(() => {
    if (!url || loaded.has(url) || failed.has(url)) {
      setReady(url ? loaded.has(url) : false);
      return;
    }
    let live = true;
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';
    probe.onload = () => {
      loaded.add(url);
      if (live) setReady(true);
    };
    probe.onerror = () => {
      failed.add(url);
    };
    probe.src = url;
    return () => {
      live = false;
    };
  }, [url]);

  if (!url || !ready) return <SellerIcon size={size} muted={muted} />;

  return (
    <img
      className={styles.agentAvatar}
      src={url}
      width={size}
      height={size}
      alt=""
      referrerPolicy="no-referrer"
    />
  );
}
