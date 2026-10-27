import type { ReactNode } from 'react';
import styles from './styles.module.css';

/**
 * Configuration advice folded under a user-facing banner.
 *
 * A banner on the public deploy is read by visitors who cannot set an environment variable; the
 * variable names are for whoever runs the dashboard. The plain-language message stays visible,
 * the fix moves one click away.
 */
export default function OperatorDetails({ children }: { children: ReactNode }) {
  return (
    <details className={styles.bannerDetails}>
      <summary>Details for operators</summary>
      {children}
    </details>
  );
}
