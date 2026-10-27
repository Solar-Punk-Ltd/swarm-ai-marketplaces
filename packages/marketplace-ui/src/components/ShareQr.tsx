import { config } from '../config/env';
import { href } from '../hooks/useRoute';
import QrCode from './QrCode';
import styles from './styles.module.css';

/**
 * A QR code for this page, so a visitor can hand the demo on: the projected screen shows it to a
 * room, a phone shows it to the person standing next to it. Hidden until asked for — on a page
 * that may later show a private key as a QR code, an unprompted second code is one too many.
 *
 * `VITE_DEMO_FLOW_BASE_URL` overrides the origin so the code can point at a tunnel when the demo
 * machine is not on the audience's network. The URL is printed under the code on purpose — a scan
 * that fails on stage is recoverable if the address is readable, and it makes a code pointing at
 * localhost obvious before anyone tries it.
 */

/** `https://bzz.limo/bzz/ff5fe9…3e70/claim-wallet` — any 64-hex reference in the path is elided. */
function shortUrl(url: string): string {
  return url.replace(/\b([0-9a-f]{6})[0-9a-f]{54}([0-9a-f]{4})\b/i, '$1…$2');
}

export function ShareQrToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={styles.button}
      aria-expanded={open}
      aria-controls="share-qr"
      onClick={onToggle}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
        <path d="M14 14h2v2h-2zM18 14h2M14 18v2M18 18h2v2" />
      </svg>
      {open ? 'Hide QR code' : 'Share'}
    </button>
  );
}

export default function ShareQr() {
  const base = config.demoFlowBaseUrl ?? window.location.origin;
  const url = `${base}${href('claim-wallet')}`;

  return (
    <div id="share-qr" className={`${styles.card} ${styles.qrCard}`}>
      <div className={styles.qrCopy}>
        <p className={styles.qrLead}>Scan with a phone camera</p>
        <p className={styles.qrOutcome}>Get your own AI agent, on your own phone.</p>
        {/* Shortened: the full /bzz/<64-hex>/ path is unreadable from the back of a room. Full
            value in `title`. */}
        <a className={styles.qrUrl} href={url} title={url}>
          {shortUrl(url)}
        </a>
      </div>
      <div className={styles.qrFrame}>
        <QrCode value={url} size={200} />
      </div>
    </div>
  );
}
