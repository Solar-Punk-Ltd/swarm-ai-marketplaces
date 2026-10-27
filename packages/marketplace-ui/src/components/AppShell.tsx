import { useState } from 'react';
import type { ReactNode } from 'react';
import { config } from '../config/env';
import { NavLockContext } from '../hooks/useNavLock';
import { linkTo } from '../hooks/useRoute';
import type { Route } from '../hooks/useRoute';
import ConnectButton from './ConnectButton';
import styles from './styles.module.css';

/**
 * `demo` entries are dropped unless VITE_SHOW_DEMO_FLOW is on. Filtered rather than conditionally
 * built so the array stays a declaration of every page there is.
 *
 * Devcon8 is the claim page itself: a visitor who scans its share QR lands on the same page.
 */
const NAV: { route: Route; label: string; demo?: boolean }[] = [
  { route: 'dashboard', label: 'Dashboard' },
  { route: 'map', label: 'Map of Agents' },
  { route: 'claim-wallet', label: 'Devcon8', demo: true },
];

export interface AppShellProps {
  route: Route;
  /** Describes the current view. */
  subtitle: string;
  /**
   * Whether to show the wallet button: only on the chain routes (`CHAIN_ROUTES` in `App.tsx`),
   * where it can sign a distribution.
   */
  showWallet: boolean;
  children: ReactNode;
}

export default function AppShell({ route, subtitle, showWallet, children }: AppShellProps) {
  const [navLocked, setNavLocked] = useState(false);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          {/* The decks' eyebrow, carrying where this runs. The testnet marker is stated plainly so
              nobody reads the balances as real money. */}
          <div className={styles.eyebrow}>
            <span>{config.chain.name}</span>
            {config.chain.testnet && (
              <span
                className={`${styles.pill} ${styles.pillWarn}`}
                title="A test network: every balance and payment here uses test tokens with no real value"
              >
                testnet
              </span>
            )}
          </div>
          <h1 className={styles.title}>
            <span className={styles.titleAccent}>Swarm AI</span> <span>Marketplaces</span>
          </h1>
          <div className={styles.subtitle}>{subtitle}</div>
        </div>
        {/* The wallet only signs distributions, which exist on the chain routes alone. On the demo
            pages it was a "No wallet detected" pill at the top of a visitor's phone — read as an
            error on a page that needs no wallet at all. */}
        <div className={styles.headerRight}>
          {/* Top right on every page, the demo pages included: they are the ones visitors open on
              their phones. */}
          <p className={styles.credit}>
            Powered by{' '}
            <a href="https://www.ethswarm.org/" target="_blank" rel="noopener noreferrer">
              Swarm
            </a>{' '}
            built by{' '}
            <a href="https://solarpunkbuzz.eth.limo/" target="_blank" rel="noopener noreferrer">
              Solar Punk
            </a>
          </p>
          {showWallet && <ConnectButton />}
        </div>
      </header>

      {/* Hidden while the claim page's agent is running: it is shut down when the visitor leaves,
          so a tap on "Dashboard" mid-run would cost them the purchase they are watching. */}
      {!navLocked && (
        <nav className={styles.nav}>
          {NAV.filter((item) => !item.demo || config.showDemoFlow).map((item) => (
            <a
              key={item.route}
              className={`${styles.navItem} ${route === item.route ? styles.navItemOn : ''}`}
              {...linkTo(item.route)}
              aria-current={route === item.route ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      )}

      <NavLockContext.Provider value={setNavLocked}>{children}</NavLockContext.Provider>
    </main>
  );
}
