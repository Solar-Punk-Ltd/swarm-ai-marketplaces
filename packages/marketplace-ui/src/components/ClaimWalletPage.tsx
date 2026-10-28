import { useCallback, useEffect, useMemo, useState } from 'react';
import { gnosis } from 'viem/chains';
import useClaim from '../hooks/useClaim';
import { useNavLock } from '../hooks/useNavLock';
import { linkTo } from '../hooks/useRoute';
import { parseVoucher, type Claim, type ClaimItem, type ClaimState } from '../lib/devcon';
import AddressLink from './AddressLink';
import BuyerAgentAnim, { type AnimScene, type AnimStep } from './BuyerAgentAnim';
import QrCode from './QrCode';
import ShareQr, { ShareQrToggle } from './ShareQr';
import styles from './styles.module.css';

/**
 * The Devcon8 page — the nav's Devcon8 tab, and the target of its own share QR code.
 *
 * When the visitor presses Start it asks `agent-orchestration-api` to deploy a buyer agent, narrates
 * what that agent does, and shows what it bought. The agent is handed back when this page closes,
 * or after the server's TTL, whichever comes first.
 */

type StepKey = 'created' | 'funded' | 'started' | 'seller' | 'purchase' | 'settled' | 'download';

interface Step {
  key: StepKey;
  /** States that belong to this step. The first is the one that activates it. */
  states: ClaimState[];
  label: string;
  /** Shown while this step is the current one. */
  detail: string;
}

const STEPS: Step[] = [
  {
    key: 'created',
    states: ['provisioning'],
    label: 'Buyer agent created',
    detail: 'Generating its wallet',
  },
  {
    key: 'funded',
    states: ['funding'],
    label: 'Wallet funded',
    detail: 'Sending it USDC to spend',
  },
  { key: 'started', states: ['starting'], label: 'Agent started', detail: 'Booting the agent' },
  {
    key: 'seller',
    states: ['discovering', 'seller_found'],
    label: 'Seller agent discovered',
    detail: 'Looking up the seller on-chain',
  },
  {
    key: 'purchase',
    states: ['purchasing'],
    label: 'Purchase initiated',
    detail: 'Paying over x402',
  },
  {
    key: 'settled',
    states: ['settled'],
    label: 'Purchase finalized',
    detail: 'Settling on Base Sepolia',
  },
  {
    key: 'download',
    states: ['downloading'],
    label: 'Downloading purchased item',
    detail: 'Decrypting from Swarm',
  },
];

const STEP_OF: Record<string, number> = Object.fromEntries(
  STEPS.flatMap((step, index) => step.states.map((state) => [state, index])),
);

/**
 * Ticks locally rather than rendering `claim.secondsRemaining`, which only moves when a poll lands
 * — a clock that jumps in whole seconds at a time looks broken.
 */
function useCountdown(expiresAt: string | null | undefined, active: boolean): number | undefined {
  const [remaining, setRemaining] = useState<number>();

  useEffect(() => {
    if (!expiresAt || !active) {
      setRemaining(undefined);
      return;
    }
    const target = new Date(expiresAt).getTime();
    if (Number.isNaN(target)) return;
    const tick = () => setRemaining(Math.max(0, Math.round((target - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, active]);

  return remaining;
}

function clock(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * The purchase step's caption while the buyer is between payment attempts. Say so, with a live
 * countdown, rather than leaving "Paying over x402" up for a minute — at a stand that reads as
 * broken, when it is the shared facilitator losing a nonce race and the same payment going through
 * on the next try. The reason is an error code, so it is shown as a tooltip, not as prose.
 *
 * `nextInSeconds` is fixed when the buyer emits it, not recomputed per poll, so the countdown runs
 * to `at + nextInSeconds` — the same server-clock target `useCountdown` already ticks towards for
 * the claim's expiry. A retry with no `at` is anchored to when this page first saw it.
 */
function RetryCaption({ retry }: { retry: NonNullable<Claim['retry']> }) {
  const next = retry.nextInSeconds;
  const target = useMemo(() => {
    if (typeof next !== 'number' || next <= 0) return undefined;
    const emitted = retry.at ? new Date(retry.at).getTime() : NaN;
    const from = Number.isNaN(emitted) ? Date.now() : emitted;
    return new Date(from + next * 1000).toISOString();
    // `attempt` is a dependency so a fresh retry without `at` re-anchors to now.
  }, [next, retry.at, retry.attempt]);
  const remaining = useCountdown(target, target !== undefined);

  const when =
    remaining !== undefined && remaining > 0
      ? ` in ${remaining >= 60 ? clock(remaining) : `${remaining}s`}`
      : '';
  const attempt = typeof retry.attempt === 'number' ? ` · attempt ${retry.attempt}` : '';
  return (
    <span
      className={`${styles.claimStepDetail} ${styles.claimStepRetry}`}
      title={retry.reason ?? undefined}
    >
      Payment network busy, retrying{when}
      {attempt}
    </span>
  );
}

/**
 * Per-step detail, once it is known. Both the funding and the settlement step carry a live
 * explorer link — the funding amount and its transaction are what make "your agent has money"
 * checkable rather than a claim.
 */
function StepDetail({
  step,
  claim,
  active,
  fallback,
}: {
  step: StepKey;
  claim: Claim;
  active: boolean;
  fallback: string;
}) {
  if (step === 'funded' && claim.funding.amount) {
    return (
      <span className={styles.claimStepDetail}>
        {claim.funding.amount} USDC
        {claim.funding.txHash && (
          <>
            {' · '}
            <AddressLink address={claim.funding.txHash} kind="tx" />
          </>
        )}
      </span>
    );
  }
  if (step === 'seller' && (claim.seller.name || claim.seller.agentId)) {
    return (
      <span className={styles.claimStepDetail}>
        {claim.seller.name ?? `agent ${claim.seller.agentId}`}
        {typeof claim.seller.itemCount === 'number' && ` · ${claim.seller.itemCount} item(s)`}
      </span>
    );
  }
  if (step === 'purchase' && active && claim.retry) {
    return <RetryCaption retry={claim.retry} />;
  }
  if (step === 'purchase' && claim.itemId) {
    return (
      <span className={styles.claimStepDetail} title={claim.itemId}>
        item {claim.itemId.slice(0, 10)}…
      </span>
    );
  }
  if (step === 'settled' && claim.txHash) {
    return (
      <span className={styles.claimStepDetail}>
        <AddressLink address={claim.txHash} kind="tx" />
      </span>
    );
  }

  if (active) {
    return <span className={styles.claimStepDetail}>{fallback}</span>;
  }

  return null;
}

/**
 * Where the claim is in `STEPS`. `reached` comes from the claim's history rather than from its
 * state alone, because a step whose whole duration fell between two polls still happened. Both the
 * checklist and the animation read this, so the two can never disagree about the current step.
 */
function progress(claim: Claim): { furthest: number; current: number; terminal: boolean } {
  const mapped = STEP_OF[claim.state];
  const terminal =
    claim.state === 'delivered' || claim.state === 'expired' || claim.state === 'failed';

  const reached = new Set<number>();

  if (mapped !== undefined) {
    reached.add(mapped);
  }

  for (const [state] of claim.history) {
    const index = STEP_OF[state];

    if (index !== undefined) {
      reached.add(index);
    }
  }
  // `delivered` implies every step, whatever the history says. The server can reach it without
  // recording each one — its fallback path reads the agent's bought file rather than its progress
  // file — and a finished claim showing "Purchase finalized" and "Downloading purchased item" as
  // never reached reads as the demo having broken at the last moment.
  const furthest =
    claim.state === 'delivered' ? STEPS.length - 1 : reached.size > 0 ? Math.max(...reached) : 0;
  const current = mapped ?? furthest;

  return { furthest, current, terminal };
}

const ANIM_STEP: Record<StepKey, AnimStep> = {
  created: 'created',
  funded: 'funded',
  started: 'started',
  seller: 'discover',
  purchase: 'purchase',
  settled: 'finalize',
  download: 'download',
};

/**
 * The animation's step for this claim. The animation never walks backwards and plays any scene it
 * is asked to skip, so this only has to say where the claim is now. A purchase retry needs no case
 * of its own: the payment scene already loops for as long as the step lasts.
 */
function animStep(claim: Claim): AnimStep {
  if (claim.state === 'delivered') return 'done';
  if (claim.state === 'failed' || claim.state === 'expired' || claim.released) return 'error';

  const key = STEPS[progress(claim).current].key;
  // "Seller agent discovered" spans two states; the seller only appears once it is actually found.
  if (key === 'seller') {
    const found =
      claim.state === 'seller_found' || claim.history.some(([state]) => state === 'seller_found');
    return found ? 'discovered' : 'discover';
  }
  return ANIM_STEP[key];
}

/**
 * One line under the animation saying what is going on in the big picture — the checklist says
 * what happened, this says why it matters. Four lines for four phases, keyed by the scene on
 * screen so the words change when the picture does. The first three steps go by in seconds, so
 * they share one line, and it is there from the first frame rather than fading in.
 */
type CaptionPhase = 'setup' | 'discover' | 'purchase' | 'done';

const CAPTIONS: Record<CaptionPhase, string> = {
  setup: 'An AI agent is created just for you, with its own wallet and test USDC to spend.',
  discover:
    'It finds a seller agent in the on-chain ERC-8004 registry, selling data stored on Swarm.',
  purchase: 'It pays the seller directly over x402 and fetches what it bought from Swarm.',
  done: 'Two agents just traded, with no one in between holding the money or the data.',
};

const PHASE_OF: Record<AnimScene, CaptionPhase> = {
  boot: 'setup',
  search: 'discover',
  found: 'discover',
  pay: 'purchase',
  deliver: 'purchase',
  download: 'purchase',
  done: 'done',
};

function captionFor(scene: AnimScene | undefined, claim: Claim): string | undefined {
  if (claim.released && claim.state !== 'delivered') return undefined;
  if (claim.state === 'expired' || claim.state === 'failed') return undefined;
  // Before the animation reports its first scene (a quarter second): the opening line, so it is
  // on screen from the start — or the closing one, for a run restored already delivered.
  if (!scene) return CAPTIONS[claim.state === 'delivered' ? 'done' : 'setup'];
  return CAPTIONS[PHASE_OF[scene]];
}

/**
 * Matches `.claimCaption`'s transition: the old line fades out before the new one fades in. The
 * line the caption mounts with is shown at once — only changes fade.
 */
const FADE_MS = 400;

function FadeCaption({ text }: { text: string | undefined }) {
  const [shown, setShown] = useState(text);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (text === shown) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = setTimeout(() => {
      setShown(text);
      setVisible(true);
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [text, shown]);

  return (
    <p
      className={`${styles.claimCaption} ${visible && shown ? styles.claimCaptionOn : ''}`}
      aria-live="polite"
    >
      {shown}
    </p>
  );
}

/** The cumulative checklist. Reached steps stay visible with a tick; the current one is highlighted. */
function Steps({ claim }: { claim: Claim }) {
  const { furthest, current, terminal } = progress(claim);

  return (
    <ol className={styles.claimSteps}>
      {STEPS.map((step, index) => {
        const done = index < furthest || (index === furthest && terminal);
        const active = index === current && !terminal;
        const pending = index > furthest;
        const className = [
          styles.claimStep,
          done ? styles.claimStepDone : '',
          active ? styles.claimStepOn : '',
          pending ? styles.claimStepPending : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <li key={step.key} className={className}>
            <span className={styles.claimStepDot} aria-hidden="true" />
            <span className={styles.claimStepText}>
              <span className={styles.claimStepLabel}>{step.label}</span>
              <StepDetail step={step.key} claim={claim} active={active} fallback={step.detail} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Copy-to-clipboard button with the shared copied-flash behaviour. */
function CopyButton({
  value,
  label,
  onCopied,
}: {
  value: string;
  label: string;
  /** Called only once the clipboard write has succeeded. */
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      onCopied?.();
    });
  }, [value, onCopied]);
  return (
    <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={copy}>
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * The devcon8 payoff: the purchased voucher IS a wallet. Address and private key are shown the
 * way the Dashboard shows every address — abbreviated, with a copy button — the address with a
 * Gnosis explorer link (the wallet is on Gnosis, not the dashboard's chain), the key without one,
 * and kept out of a hover tooltip. The key is also a QR code (the existing dark-on-light QrCode —
 * inverted codes fail on plenty of scanners), with a save-it-now warning: the key is stored nowhere
 * server-side, so this browser is the only copy. It is kept in localStorage until the visitor
 * copies it — see `deliveredStore`.
 *
 * A copy is the copy button's successful clipboard write. The key is never on screen in full, so
 * there is no selection to catch. Scanning the QR code cannot be detected, so that path relies on
 * the two-week expiry.
 */
function VoucherItem({
  voucher,
  copied,
  onCopied,
}: {
  voucher: NonNullable<ReturnType<typeof parseVoucher>>;
  copied: boolean;
  onCopied: () => void;
}) {
  // The key's QR code on the left, everything about the wallet beside it — stacked on a phone.
  return (
    <>
      <div className={`${styles.claimItem} ${styles.claimWallet}`}>
        {voucher.privateKey && (
          <div className={styles.claimWalletQr}>
            <QrCode value={voucher.privateKey} size={152} />
          </div>
        )}

        <div className={styles.claimWalletInfo}>
          <div className={styles.claimItemHead}>
            <span className={styles.claimFactLabel}>Your wallet</span>
            <span className={styles.claimItemName}>
              {voucher.funded ? 'Funded with xBZZ + xDAI on Gnosis' : 'Created — funding pending'}
            </span>
          </div>

          <div className={styles.claimWalletRows}>
            <div className={styles.claimFact}>
              <span className={styles.claimFactLabel}>Address</span>
              <AddressLink address={voucher.address} chain={gnosis} />
            </div>
            {voucher.privateKey && (
              <div className={styles.claimFact}>
                <span className={styles.claimFactLabel}>Private key</span>
                <AddressLink
                  address={voucher.privateKey}
                  secret
                  noun="private key"
                  onCopied={onCopied}
                />
              </div>
            )}
          </div>

          {voucher.privateKey ? (
            <p className={styles.claimHint}>
              {copied
                ? 'Copied, and removed from this browser. Paste it somewhere safe — it disappears when you close this page.'
                : 'Save this key — nobody else has a copy. It stays in this browser until you copy it.'}
            </p>
          ) : (
            <p className={styles.claimHint}>
              {voucher.note ?? 'The private key was already delivered and is not stored anywhere.'}
            </p>
          )}

          {!voucher.funded && (
            <p className={styles.claimHint}>
              {voucher.error ??
                'Funding did not complete. Keep the key — the wallet address can still be topped up.'}
            </p>
          )}
        </div>
      </div>
      {voucher.privateKey && <UseOnSwarm />}
    </>
  );
}

/** The Swarm website's page for getting a node: Swarm Desktop, Nook and the rest. */
const SWARM_ACCESS_URL = 'https://www.ethswarm.org/access/';

/**
 * What the wallet is for. The point of the demo is that visitors try Swarm, and the shortest way
 * there is to redeem the key as a gift code in a node app: Swarm Desktop and Nook both take a gift
 * wallet's private key and move its xBZZ and xDAI onto the node's own wallet, ready for postage
 * stamps and uploads. Without this the key is a string with no next step.
 */
function UseOnSwarm() {
  return (
    <div className={styles.claimNext}>
      <p className={styles.claimNextTitle}>Try Swarm with it</p>
      <p className={styles.claimHint}>
        Your private key works as a <strong>gift code</strong>: redeem it in a Swarm node app, and
        its xBZZ and xDAI move to your node — enough to buy storage and upload your first files.
      </p>
      <ol className={styles.claimNextSteps}>
        <li>
          Get{' '}
          <a href={SWARM_ACCESS_URL} target="_blank" rel="noopener noreferrer">
            Swarm Desktop or Nook
          </a>{' '}
          and start your node.
        </li>
        {/* The two apps put it in different places: a sidebar link in Swarm Desktop (also under
            Account → Top up wallet), a card on the Account page in Nook. */}
        <li>
          Find <strong>Redeem gift code</strong>: in the sidebar in Swarm Desktop, or on the Account
          page in Nook.
        </li>
        <li>Paste your private key (copy it above) and confirm.</li>
      </ol>
    </div>
  );
}

function DeliveredItem({
  item,
  keyCopied,
  onKeyCopied,
}: {
  item: ClaimItem;
  keyCopied: boolean;
  onKeyCopied: () => void;
}) {
  const content = item.content;
  const voucher = parseVoucher(content);

  if (voucher) {
    return <VoucherItem voucher={voucher} copied={keyCopied} onCopied={onKeyCopied} />;
  }

  return (
    <div className={styles.claimItem}>
      <div className={styles.claimItemHead}>
        <span className={styles.claimFactLabel}>Your item</span>
        {item.name && <span className={styles.claimItemName}>{item.name}</span>}
      </div>

      {content ? (
        <>
          <pre className={styles.claimItemBody}>{content}</pre>
          <CopyButton value={content} label="Copy" />
          {item.truncated && (
            <p className={styles.claimHint}>
              Showing the first part only — the item is {item.size} bytes.
            </p>
          )}
        </>
      ) : (
        <p className={styles.claimHint}>
          {item.contentWithheld
            ? 'Open this page in the browser that claimed the agent to see your item.'
            : `This item is not text (${item.size} bytes), so it cannot be shown here.`}
        </p>
      )}
    </div>
  );
}

/** The title row, with the share toggle and, when open, the share QR code under it. */
function Head({ share, onToggleShare }: { share: boolean; onToggleShare: () => void }) {
  return (
    <>
      <div className={`${styles.sectionHead} ${styles.claimHead}`}>
        <h2 className={styles.sectionTitle}>Devcon8 · claim a wallet</h2>
        <ShareQrToggle open={share} onToggle={onToggleShare} />
      </div>
      {share && <ShareQr />}
    </>
  );
}

export default function ClaimWalletPage() {
  const {
    claim,
    error,
    errorCode,
    loading,
    configured,
    started,
    start,
    keyCopied,
    markKeyCopied,
    retry,
  } = useClaim();

  // Held here rather than in `Head`, which each state below renders afresh: pressing Start must not
  // close a code someone is in the middle of scanning.
  const [share, setShare] = useState(false);
  const toggleShare = useCallback(() => setShare((open) => !open), []);
  const head = <Head share={share} onToggleShare={toggleShare} />;

  const [scene, setScene] = useState<AnimScene>();

  // The nav goes away only while an agent is running — see `useNavLock`.
  const finished =
    !!claim &&
    (claim.state === 'delivered' ||
      claim.state === 'expired' ||
      claim.state === 'failed' ||
      claim.released);
  useNavLock(configured && started && !finished && !(error && !claim));

  const counting = Boolean(claim && !claim.released && claim.state !== 'delivered');
  const remaining = useCountdown(claim?.expiresAt, counting);

  // The animation narrates a run the visitor is watching. A claim that was already delivered when
  // this page first saw it — restored from `deliveredStore`, or reattached after a reload — opens
  // on its final frame instead: replaying the story from boot above a key already on screen reads
  // as a second purchase, and leaving the animation out reads as the page having lost something.
  // Decided once, so a live run that reaches `delivered` keeps its played-out ending.
  const [settled, setSettled] = useState<boolean>();
  if (claim && settled === undefined) {
    setSettled(claim.state === 'delivered');
  }

  if (!configured) {
    return (
      <section className={styles.section}>
        {head}
        <div className={styles.empty}>
          No agent orchestration API configured. Set <code>VITE_DEVCON_API_URL</code> to the address
          of <code>agent-orchestration-api</code> and reload.
        </div>
      </section>
    );
  }

  // Nothing is deployed until the visitor asks — see `useClaim`.
  if (!started) {
    return (
      <section className={styles.section}>
        {head}
        <div className={styles.claimCard}>
          <p className={styles.claimIntro}>Get your own AI agent.</p>
          <p className={styles.claimIntroBody}>
            Press Start and an agent is created just for you, with a little test USDC to spend. It
            finds a seller agent, pays it over x402 and buys you a funded Swarm wallet — live,
            on-chain, in about a minute.
          </p>
          {/* Two chains appear in the steps that follow; said once here so neither reads as a
              mistake. */}
          <p className={styles.claimHint}>
            The agent pays on Base Sepolia, a test network. The wallet you receive is on Gnosis
            Chain, where Swarm storage is paid for. Keep this page open — the agent is shut down
            when you close it.
          </p>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            style={{ marginTop: '20px' }}
            onClick={start}
          >
            Start
          </button>
        </div>
      </section>
    );
  }

  // A hard failure with no agent yet: nothing to narrate, so say what happened and offer a retry.
  if (error && !claim) {
    const capacity = errorCode === 'at_capacity';
    return (
      <section className={styles.section}>
        {head}
        <div className={`${styles.banner} ${capacity ? styles.bannerWarn : styles.bannerDanger}`}>
          {error}
        </div>
        <div className={styles.claimCard}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={retry}
          >
            {capacity ? 'Try again' : 'Retry'}
          </button>
        </div>
      </section>
    );
  }

  if (loading || !claim) {
    return (
      <section className={styles.section}>
        {head}
        <div className={styles.claimCard}>
          <p className={styles.claimLead}>Creating a buyer agent for you…</p>
        </div>
      </section>
    );
  }

  const delivered = claim.state === 'delivered';
  const gone = claim.released || claim.state === 'expired';
  const broke = claim.state === 'failed';

  return (
    <section className={styles.section}>
      {head}

      {/* A failed poll while the agent is still running: worth showing, not worth erasing the page. */}
      {error && !broke && <div className={`${styles.banner} ${styles.bannerWarn}`}>{error}</div>}

      <div className={styles.claimCard}>
        {broke ? (
          <>
            <p className={styles.claimLead}>Your agent could not be deployed.</p>
            <p className={styles.claimHint}>{claim.error ?? 'No reason was reported.'}</p>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={retry}
            >
              Try again
            </button>
          </>
        ) : (
          <>
            {/* Steps on the left, the animation in the free space beside them; on a phone the
                animation moves above (see .claimTop). */}
            <div className={styles.claimTop}>
              <div className={styles.claimTopMain}>
                {/* Once delivered, the captions have told the story: the "bought this for you"
                    line moves down to introduce the item itself. */}
                {!delivered && <p className={styles.claimLead}>Your buyer agent is working.</p>}

                <Steps claim={claim} />
              </div>

              {/* The animation sits high in its column so the caption has room under it. */}
              <div className={styles.claimStage}>
                <BuyerAgentAnim
                  step={animStep(claim)}
                  settled={settled}
                  className={styles.claimAnim}
                  onScene={setScene}
                />
                <FadeCaption text={captionFor(scene, claim)} />
              </div>
            </div>

            {claim.item && delivered && (
              <p className={`${styles.claimLead} ${styles.claimItemLead}`}>
                Your agent bought this for you.
              </p>
            )}
            {claim.item && (
              <DeliveredItem item={claim.item} keyCopied={keyCopied} onKeyCopied={markKeyCopied} />
            )}

            {claim.buyerAddress && (
              <div className={styles.claimFacts}>
                <div className={styles.claimFact}>
                  <span className={styles.claimFactLabel}>Your agent</span>
                  <AddressLink address={claim.buyerAddress} />
                </div>
              </div>
            )}

            {gone ? (
              <p className={styles.claimHint}>
                {delivered
                  ? 'Your agent has finished and been shut down. The item above is yours to keep.'
                  : 'Your agent has been returned. Reload the page to get another one.'}
              </p>
            ) : (
              <p className={styles.claimHint}>
                {remaining !== undefined && (
                  <span className={styles.claimCountdown}>{clock(remaining)}</span>
                )}
                Your agent is yours while this page is open, and is shut down when you close it.
              </p>
            )}

            {/* The nav is back once the purchase is done, but this says where to look: the
                purchase just made shows up on the projected map. */}
            {delivered && (
              <p className={styles.claimHint}>
                <a className={styles.claimLink} {...linkTo('map')}>
                  See your purchase on the live Map of Agents →
                </a>
              </p>
            )}

            {gone && !delivered && (
              <button
                type="button"
                className={`${styles.button} ${styles.buttonPrimary}`}
                style={{ marginTop: '20px' }}
                onClick={retry}
              >
                Claim another
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
