import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import JsonView from './JsonView';
import styles from './styles.module.css';

/**
 * A JSON(-LD) document — a seller's catalog, an agent's registration file (Agent Card) — read in a
 * floating panel over the dashboard rather than as raw JSON in a new tab.
 *
 * A native `<dialog>` opened with `showModal()`: it brings the backdrop, focus containment and
 * Escape-to-close, and nothing here has to re-implement them. A click on the backdrop closes it
 * too. "raw JSON" still links to the document itself.
 *
 * The document is fetched again here rather than shared with the fetch that found it (the catalog
 * availability probe, the Agent Card read): those run per row on every load, while this runs once
 * per click. Cached per URL for the page's life only when `immutable` — a `/bzz/<ref>/` path is
 * content-addressed and never changes, while an Agent Card can live on a feed that does.
 */

const MAX_BYTES = 256 * 1024;
/**
 * Generous on purpose: an Agent Card is usually a feed, and a feed lookup on a public gateway can
 * take well over ten seconds. Waiting is shown as waiting (`Loading`), so a long limit costs
 * nothing; a short one turned slow-but-working into an error.
 */
const TIMEOUT_MS = 45_000;
const cache = new Map<string, unknown>();

type State =
  | { status: 'loading' }
  | { status: 'ready'; doc: unknown }
  | { status: 'error'; message: string };

/** Animated dots plus words, so a slow gateway reads as "still working", never as stuck. */
function Loading() {
  return (
    <p className={styles.catalogNote} role="status">
      <span className={styles.loadingDots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      Loading from Swarm…
    </p>
  );
}

async function loadDocument(
  url: string,
  immutable: boolean,
  signal: AbortSignal,
): Promise<unknown> {
  if (immutable && cache.has(url)) return cache.get(url);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The gateway answered ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('The document is too large to show here.');
  const doc: unknown = JSON.parse(text);
  if (immutable) cache.set(url, doc);
  return doc;
}

/**
 * True for an unmodified primary click. A link that opens this dialog intercepts only that one,
 * so a modified or middle click and "copy link address" still behave as a link — the same contract
 * as the router's `linkTo`.
 */
export function isPlainClick(event: MouseEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export default function JsonDocumentDialog({
  url,
  kicker,
  fallbackTitle,
  immutable = false,
  initial,
  onClose,
}: {
  url: string;
  /** Small label above the title: what kind of document this is. */
  kicker: string;
  /** Shown in the header until the document's own `name` is known. */
  fallbackTitle: string;
  /** Content-addressed, so safe to cache for the page's life. */
  immutable?: boolean;
  /**
   * A copy the page already holds (the Agent Card read for the badge). Shown at once, and replaced
   * by the fresh fetch when that lands; if the fetch fails, this copy simply stays.
   */
  initial?: unknown;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<State>(() =>
    initial !== undefined ? { status: 'ready', doc: initial } : { status: 'loading' },
  );
  const [attempt, setAttempt] = useState(0);
  const hasInitial = initial !== undefined;

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Set only by our own timer, so an abort from the cleanup below — a closed dialog, or React's
    // development double-run of effects — is never reported as the gateway being slow.
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    loadDocument(url, immutable, controller.signal)
      .then((doc) => {
        if (!cancelled) setState({ status: 'ready', doc });
      })
      .catch((error: unknown) => {
        // A copy is already on screen: a failed refresh leaves it there, silently.
        if (cancelled || hasInitial) return;
        setState({
          status: 'error',
          message: timedOut
            ? 'Swarm is taking unusually long to answer.'
            : error instanceof SyntaxError
              ? 'The document is not valid JSON.'
              : error instanceof Error
                ? error.message
                : 'The document could not be loaded.',
        });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, immutable, hasInitial, attempt]);

  const docName =
    state.status === 'ready' &&
    typeof state.doc === 'object' &&
    state.doc !== null &&
    typeof (state.doc as { name?: unknown }).name === 'string'
      ? (state.doc as { name: string }).name
      : undefined;

  return (
    <dialog
      ref={dialog}
      className={styles.catalogDialog}
      aria-labelledby="catalog-title"
      onClose={onClose}
      // A click that lands on the dialog element itself is on the backdrop, not the panel.
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className={styles.catalogPanel}>
        <div className={styles.catalogHead}>
          <div>
            <div className={styles.catalogKicker}>{kicker}</div>
            <h2 id="catalog-title" className={styles.catalogTitle}>
              {docName ?? fallbackTitle}
            </h2>
          </div>
          <button
            type="button"
            className={styles.catalogClose}
            onClick={() => dialog.current?.close()}
            aria-label="Close"
            title="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className={styles.catalogBody}>
          {state.status === 'loading' && <Loading />}
          {state.status === 'error' && (
            <div className={styles.catalogError}>
              <p className={styles.catalogNote}>{state.message}</p>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  setState({ status: 'loading' });
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </div>
          )}
          {state.status === 'ready' && <JsonView value={state.doc} />}
        </div>

        <div className={styles.catalogFoot}>
          <a href={url} target="_blank" rel="noopener noreferrer" className={styles.catalogRaw}>
            raw JSON ↗
          </a>
        </div>
      </div>
    </dialog>
  );
}
