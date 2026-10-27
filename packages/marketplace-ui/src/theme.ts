/**
 * Colour tokens. Single source of truth — never inline a hex value in a component or CSS module.
 *
 * The palette follows the Solar Punk film and decks and the claim page's buyer-agent animation
 * (see CLAUDE.md → Theme). The token names match erc8004-dashboard's so the two remain easy to
 * reconcile.
 */
export const theme = {
  // ── base ──────────────────────────────────────────────────────────────────
  // Neutral, slightly cool greys over the Solar Punk film's backdrop: near-black, with a warm
  // maroon glow low on the left and a slate-blue one on the right (see `index.css`). Hue is
  // reserved for the glows and for meaning — orange for Swarm and money waiting, the layer colours
  // below — so surfaces and text stay grey.
  bg: '#0c0b10',
  text: '#eeedf2',
  accent: '#f9822c',
  textMuted: '#a3a1ad',

  // ── marketplace-ui additions ──────────────────────────────────────────────
  /** The backdrop's warm glow, bottom-left. */
  bgGlowWarm: 'rgba(122, 38, 44, 0.42)',
  /** The backdrop's cool glow, right. */
  bgGlowCool: 'rgba(52, 60, 96, 0.38)',
  /** Translucent, so the glows read through cards the way they do through the film's frames. */
  surface: 'rgba(22, 21, 28, 0.78)',
  surfaceRaised: 'rgba(34, 33, 42, 0.82)',
  border: '#2b2a33',
  borderStrong: '#3c3a46',
  /** Captions, kickers and other text one step quieter than `textMuted`. */
  textFaint: '#6f6d7a',
  accentSoft: 'rgba(249, 130, 44, 0.12)',
  /**
   * Every seller representation: the stall's robot and stripes, the avatar ring, the map's seller
   * nodes, the claim animation's seller. Amber, halfway between Swarm orange (`accent`) and the
   * stall's yellow stripe (`warning`) — familiar from the stall, but never mistaken for Swarm.
   */
  seller: '#f59d33',
  success: '#3fd67e',
  successSoft: 'rgba(63, 214, 126, 0.13)',
  danger: '#ef7480',
  dangerSoft: 'rgba(239, 116, 128, 0.13)',
  warning: '#f0b73a',
  warningSoft: 'rgba(240, 183, 58, 0.13)',
  // The decks' layer colours: ERC-8004 is mint, x402 rails sky, agents lavender. The How-it-works
  // flow uses them so each step reads as the same layer it is on the roadmap stack.
  mint: '#3fd6a4',
  mintSoft: 'rgba(63, 214, 164, 0.12)',
  sky: '#58a8e8',
  skySoft: 'rgba(88, 168, 232, 0.12)',
  lav: '#b9a4f0',
  lavSoft: 'rgba(185, 164, 240, 0.12)',
  skeleton: '#24232c',

  // Map of Agents edges. Dimmed derivations of accent/success: on a dense canvas the edges are
  // background, and node labels have to stay readable over them.
  linkPurchase: 'rgba(249, 130, 44, 0.5)',
  linkPayout: 'rgba(63, 214, 126, 0.45)',
} as const;

export type ThemeToken = keyof typeof theme;

/** kebab-cases a token name: `surfaceRaised` → `--mp-surface-raised`. */
function cssVarName(token: string): string {
  return `--mp-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Stamp the tokens onto :root as custom properties, so CSS modules can use `var(--mp-bg)` while
 * the values stay defined once, in TypeScript.
 */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  for (const [token, value] of Object.entries(theme)) {
    root.style.setProperty(cssVarName(token), value);
  }
}
