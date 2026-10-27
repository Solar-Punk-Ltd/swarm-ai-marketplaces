import type { ReactNode } from 'react';
import styles from './styles.module.css';

/**
 * Names the participant an icon stands for — "Buyer agent", "Seller agent", "Marketplace
 * treasury" — on hover, keyboard focus or a tap.
 *
 * A `title` tooltip would cover the mouse only: a phone never shows one. This is focusable, so a
 * tap focuses it and the label appears; the empty click handler is what makes iOS Safari treat a
 * tap on a non-link element as an interaction at all.
 */
export default function RoleTip({
  label,
  children,
  interactive = true,
}: {
  label: string;
  children: ReactNode;
  /**
   * False inside something already clickable (the map table's row buttons): a focusable element
   * nested in a button is invalid, and those rows state the role in words anyway. Hover only.
   */
  interactive?: boolean;
}) {
  return (
    <span
      className={styles.roleTip}
      data-tip={label}
      role="img"
      aria-label={label}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => {} : undefined}
    >
      {children}
    </span>
  );
}
