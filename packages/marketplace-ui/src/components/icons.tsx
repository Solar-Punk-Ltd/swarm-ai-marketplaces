import { useId } from 'react';
import type { CSSProperties } from 'react';

/**
 * Participant and step icons, drawn after the characters of the Solar Punk film "AI Data
 * Marketplaces" and the claim page's buyer-agent animation: a round, visored robot for a buyer, a
 * robot behind a striped-awning market stall for a seller, and a vault for the marketplace
 * treasury. Inline SVG, coloured only through `--mp-*` tokens (presentation attributes cannot read
 * a custom property, so colours go through `style`), so they follow the theme like everything else.
 *
 * Decorative by default (`aria-hidden`): every place that shows one also says the role in words.
 */

interface IconProps {
  size?: number;
  className?: string;
  /** Dimmed, for a participant the row cannot vouch for (e.g. a splitter with no agent). */
  muted?: boolean;
}

const v = (token: string): string => `var(--mp-${token})`;
const fill = (token: string): CSSProperties => ({ fill: v(token) });
const stroke = (token: string): CSSProperties => ({ stroke: v(token) });

/** A buyer agent: round glossy head, dark visor, two lit eyes, an antenna. */
export function BuyerIcon({
  size = 32,
  className,
  muted,
  gradientId,
}: IconProps & {
  /** Fixed gradient id, for markup rendered outside a page (the map's canvas sprites). */
  gradientId?: string;
}) {
  const autoId = useId();
  const id = gradientId ?? autoId;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ opacity: muted ? 0.45 : 1, flex: 'none' }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`${id}h`} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" style={{ stopColor: v('text-muted') }} />
          <stop offset="0.55" style={{ stopColor: v('border-strong') }} />
          <stop offset="1" style={{ stopColor: v('bg') }} />
        </radialGradient>
        <radialGradient id={`${id}g`}>
          <stop offset="0" style={{ stopColor: v('text'), stopOpacity: 0.55 }} />
          <stop offset="1" style={{ stopColor: v('text'), stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}t`} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" style={{ stopColor: v('text') }} />
          <stop offset="1" style={{ stopColor: v('text-muted') }} />
        </radialGradient>
      </defs>
      <line x1="16" y1="3.5" x2="16" y2="7.5" strokeWidth="1.4" style={stroke('text-muted')} />
      {/* A pale, softly lit antenna bulb, as on the claim page's buyer agent. */}
      <circle cx="16" cy="3.2" r="3.2" fill={`url(#${id}g)`} />
      <circle cx="16" cy="3.2" r="1.7" fill={`url(#${id}t)`} />
      <circle cx="5.6" cy="18" r="1.9" style={fill('border-strong')} />
      <circle cx="26.4" cy="18" r="1.9" style={fill('border-strong')} />
      <circle
        cx="16"
        cy="18"
        r="10.2"
        fill={`url(#${id}h)`}
        strokeWidth="0.8"
        style={stroke('border-strong')}
      />
      <rect x="9" y="14" width="14" height="8" rx="4" style={fill('bg')} />
      <rect x="11.9" y="15.6" width="2.6" height="4.6" rx="1.3" style={fill('text')} />
      <rect x="17.5" y="15.6" width="2.6" height="4.6" rx="1.3" style={fill('text')} />
    </svg>
  );
}

/**
 * A seller agent: a robot behind its market stall, under a striped awning.
 *
 * Every seller's stall is the same amber (`seller`) and yellow — the seller colour on the map's legend — so
 * the colour always means "seller" and never needs explaining. Which seller is which is told by its
 * name, and by its own avatar where its registration file has one (`AgentFace`).
 */
export function SellerIcon({ size = 32, className, muted }: IconProps) {
  const stripes = [0, 1, 2, 3, 4, 5];
  const main = 'seller';
  const alt = 'warning';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ opacity: muted ? 0.45 : 1, flex: 'none' }}
      aria-hidden="true"
    >
      {/* posts */}
      <line x1="6" y1="11" x2="6" y2="24" strokeWidth="1.2" style={stroke('border-strong')} />
      <line x1="26" y1="11" x2="26" y2="24" strokeWidth="1.2" style={stroke('border-strong')} />
      {/* robot behind the counter */}
      <line x1="16" y1="12" x2="16" y2="14.2" strokeWidth="1.2" style={stroke(main)} />
      <rect
        x="10.5"
        y="14"
        width="11"
        height="8.5"
        rx="2.6"
        strokeWidth="1"
        style={{ ...fill('surface-raised'), ...stroke(main) }}
      />
      <rect x="12.2" y="16" width="7.6" height="4.2" rx="2" style={fill('bg')} />
      <rect x="13.6" y="16.8" width="1.5" height="2.6" rx="0.75" style={fill('text')} />
      <rect x="16.9" y="16.8" width="1.5" height="2.6" rx="0.75" style={fill('text')} />
      {/* awning: alternating stripes with a scalloped edge */}
      {stripes.map((i) => (
        <g key={i} style={fill(i % 2 === 0 ? main : alt)}>
          <rect x={4 + i * 4} y="5" width="4" height="5.5" />
          <circle cx={6 + i * 4} cy="10.5" r="2" />
        </g>
      ))}
      {/* counter */}
      <rect
        x="4"
        y="22.5"
        width="24"
        height="6"
        rx="1"
        strokeWidth="0.8"
        style={{ ...fill('surface-raised'), ...stroke('border-strong') }}
      />
      <rect x="11" y="24.6" width="10" height="1.8" rx="0.9" style={fill(main)} />
    </svg>
  );
}

/** The marketplace treasury: a vault, its dial in Swarm orange. Body lighter than the card, so the
 * safe's silhouette reads against the dark backdrop. */
export function TreasuryIcon({ size = 32, className, muted }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ opacity: muted ? 0.45 : 1, flex: 'none' }}
      aria-hidden="true"
    >
      <rect
        x="4.5"
        y="5.5"
        width="23"
        height="20"
        rx="2.5"
        strokeWidth="1"
        style={{ ...fill('border-strong'), ...stroke('text-faint') }}
      />
      <rect
        x="7"
        y="8"
        width="18"
        height="15"
        rx="1.5"
        fill="none"
        strokeWidth="0.8"
        style={stroke('text-faint')}
      />
      <circle cx="16" cy="15.5" r="4.6" fill="none" strokeWidth="1.6" style={stroke('accent')} />
      <circle cx="16" cy="15.5" r="1.3" style={fill('accent')} />
      <line x1="16" y1="10.9" x2="16" y2="12.6" strokeWidth="1.2" style={stroke('accent')} />
      <line x1="20.6" y1="15.5" x2="18.9" y2="15.5" strokeWidth="1.2" style={stroke('accent')} />
      <line x1="16" y1="20.1" x2="16" y2="18.4" strokeWidth="1.2" style={stroke('accent')} />
      <rect x="22.6" y="13" width="1.6" height="5" rx="0.8" style={fill('text')} />
      <rect x="7" y="25.5" width="3.5" height="2" rx="0.5" style={fill('text-faint')} />
      <rect x="21.5" y="25.5" width="3.5" height="2" rx="0.5" style={fill('text-faint')} />
    </svg>
  );
}

export type StepIconKind = 'publish' | 'discover' | 'pay' | 'unlock' | 'split';

/**
 * One line icon per How-it-works step, stroked in `currentColor` so each takes its node's layer
 * colour.
 */
export function StepIcon({ kind, size = 18 }: { kind: StepIconKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style: { flex: 'none' } as CSSProperties,
  };
  switch (kind) {
    case 'publish':
      // A stall: awning, posts, counter.
      return (
        <svg {...common}>
          <path d="M3 9h18l-1.5-4h-15z" />
          <path d="M3 9a2.25 2.25 0 0 0 4.5 0a2.25 2.25 0 0 0 4.5 0a2.25 2.25 0 0 0 4.5 0a2.25 2.25 0 0 0 4.5 0" />
          <path d="M5 11v9h14v-9" />
          <path d="M9.5 20v-5h5v5" />
        </svg>
      );
    case 'discover':
      // An agent's head sending out a ping.
      return (
        <svg {...common}>
          <rect x="3" y="9" width="10" height="9" rx="3" />
          <path d="M6 13h.01M10 13h.01" />
          <path d="M8 9V6.5" />
          <path d="M16 9.5a4 4 0 0 1 0 7" />
          <path d="M18.8 7a7.5 7.5 0 0 1 0 12" />
        </svg>
      );
    case 'pay':
      // The film's x402 coin.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="6" strokeDasharray="1.5 2" />
          <path d="M14 9.6c-.5-.7-1.3-1-2.2-1-1.3 0-2.2.7-2.2 1.7s1 1.4 2.3 1.7c1.3.3 2.3.8 2.3 1.8s-1 1.8-2.3 1.8c-1 0-1.9-.4-2.4-1.1M12 7.3v1.3M12 15.6v1.2" />
        </svg>
      );
    case 'unlock':
      // An open padlock.
      return (
        <svg {...common}>
          <rect x="4.5" y="11" width="15" height="10" rx="2" />
          <path d="M8 11V7.5a4 4 0 0 1 7.6-1.8" />
          <path d="M12 15v2" />
        </svg>
      );
    case 'split':
      // One payment in, two out: seller and treasury.
      return (
        <svg {...common}>
          <path d="M3 12h7" />
          <path d="M10 12c3 0 4-5 8-5" />
          <path d="M10 12c3 0 4 5 8 5" />
          <path d="M16 4.5 18.5 7 16 9.5" />
          <path d="M16 14.5 18.5 17 16 19.5" />
        </svg>
      );
  }
}
