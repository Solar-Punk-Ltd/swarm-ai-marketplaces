import { config } from '../config/env';
import AddressLink from './AddressLink';
import styles from './styles.module.css';

/**
 * The developer on-ramp: where the code lives and the two contracts everything on this page is
 * read from. A developer who wants to plug an agent in needs exactly these, and before this they
 * had to dig them out of the bundle.
 */

const REPO_URL = 'https://github.com/Solar-Punk-Ltd/swarm-ai-data-exchange';

export default function DashboardFooter() {
  return (
    <footer className={styles.footer}>
      <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
        Build an agent that buys or sells →
      </a>
      <AddressLink address={config.factory} label="Splitter factory" />
      {config.identityRegistry && (
        <AddressLink address={config.identityRegistry.address} label="ERC-8004 registry" />
      )}
    </footer>
  );
}
