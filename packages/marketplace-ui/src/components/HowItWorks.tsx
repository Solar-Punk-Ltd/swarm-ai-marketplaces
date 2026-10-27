import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { StepIcon } from './icons';
import type { StepIconKind } from './icons';
import styles from './styles.module.css';

/**
 * The story of a sale, for someone who arrives knowing neither Swarm nor this marketplace.
 * Everything else on the Dashboard is a reading of its last steps; without it, a newcomer meets
 * "Treasury", "Splitter" and "Distribute" with nothing to hang them on.
 *
 * Drawn the way the Solar Punk decks draw it: one lane, a node per step in its layer's colour, a
 * packet that travels along it, and a single caption — one sentence on screen at a time instead of
 * five paragraphs. It plays on its own; clicking a step holds it there for a while, then the story
 * carries on. No play/pause control: the story is short enough not to need one.
 *
 * Collapsible, and remembered per browser. Storage is a convenience only — it can throw or come
 * back empty (private mode, blocked site data), and then the strip simply shows again.
 */

const STORAGE_KEY = 'mp.howItWorks.collapsed';
const STEP_MS = 4500;
/** How long a step the reader clicked stays up before autoplay resumes. */
const HOLD_MS = 12000;

type Layer = 'swarm' | 'identity' | 'payment' | 'contract';

const STEPS: {
  title: string;
  icon: StepIconKind;
  tag: string;
  layer: Layer;
  caption: string;
}[] = [
  {
    title: 'Publish',
    icon: 'publish',
    tag: 'Swarm · ACT',
    layer: 'swarm',
    caption: 'A seller agent stores its data on Swarm, encrypted, and lists it in a catalog.',
  },
  {
    title: 'Discover',
    icon: 'discover',
    tag: 'ERC-8004',
    layer: 'identity',
    caption: 'A buyer agent finds the seller through its on-chain agent identity.',
  },
  {
    title: 'Pay',
    icon: 'pay',
    tag: 'x402 · USDC',
    layer: 'payment',
    caption: 'The buyer pays over HTTP 402. The money lands in the seller’s splitter contract.',
  },
  {
    title: 'Unlock',
    icon: 'unlock',
    tag: 'ACT grant',
    layer: 'swarm',
    caption: 'Payment adds the buyer to the data’s access list, so it can decrypt it from Swarm.',
  },
  {
    // Named for the action an operator takes on this page — the Distribute button — with the
    // contract that performs it underneath.
    title: 'Distribute',
    icon: 'split',
    tag: 'splitter contract',
    layer: 'contract',
    caption: 'A distribution pays the seller and sends the marketplace tax to the treasury.',
  },
];

const LAYER_CLASS: Record<Layer, string> = {
  swarm: styles.howNodeSwarm,
  identity: styles.howNodeIdentity,
  payment: styles.howNodePayment,
  contract: styles.howNodeContract,
};

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* not persisted; the default applies next visit */
  }
}

/** Autoplay is motion the reader did not ask for; with reduced motion it starts paused. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export default function HowItWorks() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  /** Bumped on every click, so a second click restarts the hold rather than racing the first. */
  const [held, setHeld] = useState(0);

  useEffect(() => {
    if (collapsed || !playing) return;
    const id = setInterval(() => setActive((i) => (i + 1) % STEPS.length), STEP_MS);
    return () => clearInterval(id);
  }, [collapsed, playing]);

  // A clicked step is held, then the story carries on — except under reduced motion, where it
  // never started on its own.
  useEffect(() => {
    if (held === 0 || prefersReducedMotion()) return;
    const id = setTimeout(() => setPlaying(true), HOLD_MS);
    return () => clearTimeout(id);
  }, [held]);

  const toggle = () => {
    setCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });
  };

  const title = (
    <h2 id="how-title" className={styles.howTitle}>
      Agents trade data. <em>Swarm</em> stores it. The chain settles it.
    </h2>
  );

  // In the corner, large enough to hit with a thumb; the arrow points the way the section moves.
  const toggleButton = (
    <button
      type="button"
      className={styles.howToggle}
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-controls="how-body"
      aria-label={collapsed ? 'Show how it works' : 'Hide how it works'}
      title={collapsed ? 'Show' : 'Hide'}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={collapsed ? undefined : styles.howToggleOpen}
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );

  if (collapsed) {
    return (
      <section className={`${styles.how} ${styles.howCollapsed}`} aria-labelledby="how-title">
        {title}
        {toggleButton}
      </section>
    );
  }

  const step = STEPS[active];
  // The packet sits on the centre of the active node; the lane behind it is lit up to there.
  const position = `${((active + 0.5) / STEPS.length) * 100}%`;

  return (
    <section className={styles.how} aria-labelledby="how-title">
      <div className={styles.howHead}>{title}</div>
      {toggleButton}

      <div
        id="how-body"
        className={styles.howLane}
        style={{ '--how-at': position } as CSSProperties}
      >
        <span className={styles.howTrack} aria-hidden="true" />
        <span className={styles.howPacket} aria-hidden="true" />
        <ol className={styles.howSteps}>
          {STEPS.map((s, index) => (
            <li key={s.title}>
              <button
                type="button"
                className={`${styles.howNode} ${LAYER_CLASS[s.layer]} ${
                  index === active ? styles.howNodeOn : ''
                }`}
                onClick={() => {
                  setActive(index);
                  setPlaying(false);
                  setHeld((n) => n + 1);
                }}
                aria-current={index === active ? 'step' : undefined}
              >
                <span className={styles.howNodeTop}>
                  <span className={styles.howNodeIcon}>
                    <StepIcon kind={s.icon} />
                  </span>
                  <span className={styles.howNodeNum}>{String(index + 1).padStart(2, '0')}</span>
                </span>
                <span className={styles.howNodeTitle}>{s.title}</span>
                <span className={styles.howNodeTag}>{s.tag}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      {/* Announced only when the reader picked the step; autoplay would talk over them. */}
      <p className={styles.howCaption} aria-live={playing ? 'off' : 'polite'}>
        {/* Phones only: the nodes there are too narrow for their names and show just the icon,
            so the active step is named here instead. */}
        <span className={styles.howCaptionStep}>{step.title}</span>
        {step.caption}
      </p>
    </section>
  );
}
