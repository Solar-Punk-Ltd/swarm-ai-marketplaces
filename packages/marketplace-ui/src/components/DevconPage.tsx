import { config } from '../config/env';
import { href } from '../hooks/useRoute';
import QrCode from './QrCode';
import styles from './styles.module.css';

/**
 * The demo hand-off page: a QR code that moves the audience from the projected dashboard onto
 * their own phone.
 *
 * `VITE_DEMO_FLOW_BASE_URL` overrides the origin so the code can point at a tunnel when the demo
 * machine is not on the audience's network. The resolved URL is printed under the code on purpose
 * — a scan that fails on stage is recoverable if the address is readable, and it makes a QR
 * pointing at localhost obvious before anyone tries it.
 */
/** `https://bzz.limo/bzz/ff5fe9…3e70/claim-wallet` — any 64-hex reference in the path is elided. */
function shortUrl(url: string): string {
  return url.replace(/\b([0-9a-f]{6})[0-9a-f]{54}([0-9a-f]{4})\b/i, '$1…$2');
}

export default function DevconPage() {
  const base = config.demoFlowBaseUrl ?? window.location.origin;
  const claimWalletUrl = `${base}${href('claim-wallet')}`;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Devcon demo</h2>
      </div>
      <div className={`${styles.card} ${styles.qrCard}`}>
        <div className={styles.qrCopy}>
          <p className={styles.qrLead}>Scan with your phone camera</p>
          <p className={styles.qrOutcome}>
            Get your own AI agent. It finds a seller agent, pays it over x402 and buys you a funded
            Swarm wallet — live, on-chain, in about a minute.
          </p>
          {/* Still printed so a failed scan is recoverable by typing, but shortened: the full
              /bzz/<64-hex>/ path is unreadable from the back of a room. Full value in `title`. */}
          <a className={styles.qrUrl} href={claimWalletUrl} title={claimWalletUrl}>
            {shortUrl(claimWalletUrl)}
          </a>
        </div>

        <div className={styles.qrFrame}>
          <QrCode value={claimWalletUrl} />
        </div>
      </div>
    </section>
  );
}
