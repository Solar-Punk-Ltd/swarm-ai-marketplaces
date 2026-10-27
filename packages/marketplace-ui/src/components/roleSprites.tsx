import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';
import { theme } from '../theme';
import { BuyerIcon, SellerIcon, TreasuryIcon } from './icons';
import type { GraphNode } from '../lib/graph';

/**
 * The participant icons from `icons.tsx`, as images the Map of Agents canvas can draw.
 *
 * One source for both surfaces: each icon is rendered once, off-screen, to SVG markup, its
 * `var(--mp-*)` colours are resolved to the values in `theme.ts` (a canvas cannot read a custom
 * property — the same reason `AgentGraph` reads `theme` directly), and the result is decoded as a
 * data-URL image, once per role and stall colour for the life of the page.
 *
 * A same-origin data URL never taints the canvas, but these are still drawn on the visible canvas
 * only — the pointer-area canvas paints plain circles, as for avatars.
 */

const sprites = new Map<string, HTMLImageElement | null>();

const kebabToCamel = (name: string): string =>
  name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** `var(--mp-text-muted)` → `theme.textMuted`. */
function resolveTokens(svg: string): string {
  return svg.replace(/var\(--mp-([a-z-]+)\)/g, (match, name: string) => {
    const value = (theme as Record<string, string>)[kebabToCamel(name)];
    return value ?? match;
  });
}

function markupOf(element: ReactElement): string {
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(element));
  const svg = host.innerHTML;
  root.unmount();
  return svg.includes('xmlns')
    ? svg
    : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

/** Large source size: the canvas scales it down, and a sharp downscale beats a blurry upscale. */
const SIZE = 96;

/** Every icon the map can draw, by key. */
function allIcons(): [string, ReactElement][] {
  return [
    ['treasury', <TreasuryIcon size={SIZE} />],
    ['buyer', <BuyerIcon size={SIZE} gradientId="buyer-head" />],
    ['seller', <SellerIcon size={SIZE} />],
    ['seller-muted', <SellerIcon size={SIZE} muted />],
  ];
}

function keyFor(node: GraphNode): string {
  if (node.roles.has('treasury')) return 'treasury';
  if (node.roles.has('seller')) {
    return node.agentId === undefined ? 'seller-muted' : 'seller';
  }
  return 'buyer';
}

/** Repaint nudges waiting on a sprite that has not decoded yet. */
const waiting = new Set<() => void>();

/**
 * Built once, eagerly, when this module loads — never from inside a paint. The canvas can paint
 * during a React commit, and `flushSync` cannot flush there: it returns with nothing rendered, the
 * markup is empty, and the image never decodes. A failed decode is final (null), like an avatar's.
 */
function buildAll(): void {
  if (typeof document === 'undefined') return;
  for (const [key, element] of allIcons()) {
    sprites.set(key, null);
    const image = new Image();
    image.onload = () => {
      sprites.set(key, image);
      for (const nudge of waiting) nudge();
      waiting.clear();
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(resolveTokens(markupOf(element)))}`;
  }
}

buildAll();

/**
 * The node's role icon, or null while it is still decoding. `onLoad` is the canvas's repaint
 * nudge, as for avatars: a settled canvas has stopped painting and would not show it otherwise.
 */
export function roleSpriteFor(node: GraphNode, onLoad: () => void): HTMLImageElement | null {
  const sprite = sprites.get(keyFor(node)) ?? null;
  if (!sprite) waiting.add(onLoad);
  return sprite;
}
