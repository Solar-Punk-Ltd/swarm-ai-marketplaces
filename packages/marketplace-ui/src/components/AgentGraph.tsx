/**
 * The network canvas.
 *
 * Two things about `react-force-graph-2d` shape this file more than taste does:
 *
 * 1. It propagates props by reference identity, so an inline accessor is re-applied on every
 *    render — and this page re-renders every 5s because the marketplace context does. Every
 *    accessor here is therefore module-level or `useCallback`, and the component is memoised so
 *    the balance tick never reaches it at all.
 * 2. It sizes itself to `window.innerWidth`/`innerHeight`, captured when the module loads. Inside
 *    a 1100px column that overflows and never responds to a resize, so the width is measured and
 *    passed explicitly.
 *
 * Colours come from `theme.ts` directly rather than `var(--mp-*)`: a 2D canvas context cannot
 * read CSS custom properties. That is the sanctioned form of "never inline a hex", not an escape
 * from it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { theme } from '../theme';
import type { GraphLink, GraphNode, NodeRole } from '../lib/graph';
import { roleSpriteFor } from './roleSprites';
import styles from './styles.module.css';

const HEIGHT = 520;
/** Overlap-free frames before the separation loop stands down; ~4s, matching the cooldown. */
const SETTLE_FRAMES = 240;
/** Radius of a node with no activity. Everything else grows from here. */
const BASE_RADIUS = 4;
/**
 * Floor on the radius of a node that has an avatar: a face needs more room than a dot does, and
 * 4px of one is unreadable.
 *
 * Keyed on `avatarUrl` rather than on the decoded sprite, so the layout does not shift when an
 * image lands seconds after its node was placed. The cost is real and deliberate — it flattens
 * the area-proportional size encoding below ~5 purchases, where every agent with a face reads as
 * the same size.
 */
const AVATAR_MIN_RADIUS = 9;
/**
 * Floor on the treasury's radius, so the hub is drawn as one.
 *
 * Size is area-proportional to `txCount`, and `txCount` is purchases-only by design — a payout's
 * treasury half is recorded on the node but never counted as a transaction (`graph.ts`). A
 * treasury that only collects tax therefore sits at `BASE_RADIUS` forever, rendering the one node
 * every payout edge converges on as the smallest dot on the canvas. It is exempt from the size
 * encoding rather than folded into it: it is not an agent, so "how active is it" is not the
 * question its dot answers.
 */
const TREASURY_MIN_RADIUS = 20;
/** Side of the pre-scaled sprite, in device pixels. */
const AVATAR_SPRITE_PX = 96;
/**
 * Smallest hit target, in *screen* pixels rather than graph units.
 *
 * The drawn radius is in graph units, so it shrinks with the zoom — and `zoomToFit` frames the
 * whole network, which on a spread-out layout leaves a one-purchase buyer a ~3px dot. Dividing by
 * `globalScale` converts a screen-pixel floor back into the graph units the pointer canvas is
 * painted in, so the target stays the same physical size however far out the view is framed.
 */
const MIN_HIT_RADIUS_PX = 10;

/** On-screen radius, in px, below which a node is drawn as a plain dot rather than its icon. */
const ICON_MIN_SCREEN_RADIUS = 7;

/**
 * On-screen radius, in px, that sellers and the treasury never drop below. They are the few
 * participants the map is about, and `zoomToFit` over a crowd of buyers otherwise shrinks them
 * to dots too small for their icon. Floored in screen pixels like the hit targets, so it holds at
 * every zoom; the layout still spaces nodes by `radiusOf`.
 */
const MAJOR_MIN_SCREEN_RADIUS = 13;

/** The radius a node is drawn (and hit-tested) at, at this zoom. */
function drawnRadius(node: GraphNode, globalScale: number): number {
  const radius = radiusOf(node);
  // Agents and the treasury, not every splitter: an unclaimed test clone is not who the map is
  // about, and flooring a crowd of them only piles their discs on top of each other.
  const major = node.agentId !== undefined || node.roles.has('treasury');
  return major ? Math.max(radius, MAJOR_MIN_SCREEN_RADIUS / globalScale) : radius;
}

/** Zoom level above which plain buyer wallets get their address label drawn. */
const BUYER_LABEL_MIN_SCALE = 2.5;

function radiusOf(node: GraphNode): number {
  // Area-proportional to activity, so a busy agent reads as busier without dwarfing the rest.
  // Floored so an agent that has never traded is still a visible, clickable dot.
  const base = BASE_RADIUS * Math.sqrt(1 + node.txCount);
  const floor = Math.max(
    node.avatarUrl ? AVATAR_MIN_RADIUS : 0,
    node.roles.has('treasury') ? TREASURY_MIN_RADIUS : 0,
  );
  return Math.max(base, floor);
}

/** Shared with the legend, so the two can never drift apart. */
/**
 * Keep-apart radius: the drawn circle plus room for the label under it.
 *
 * Labels are the reason this is not just the node radius. A buyer's label is ~5px per character
 * and drawn centred beneath the dot, so without the allowance two adjacent nodes stay legally
 * apart while their captions sit on top of each other.
 */
function keepApartRadius(node: GraphNode): number {
  return radiusOf(node) + 10 + node.label.length * 2.6;
}

/**
 * Push overlapping nodes apart, once per simulation tick.
 *
 * Charge alone cannot fix this graph: buyers each pay several sellers, so they share a
 * barycentre and pile up there no matter how hard the sellers are pushed outwards — turning the
 * charge up only flings the sellers further away and makes the pile look smaller.
 *
 * Driven from an animation frame this component owns, rather than through force-graph. Two of
 * its extension points were tried first and both fail silently: a force installed via
 * `d3Force('collide', …)` registers and initialises with the right nodes but is never invoked,
 * and `onEngineTick` is applied once and never replaced, so under StrictMode's double mount the
 * surviving callback is the one from the discarded first instance — permanently frozen on the
 * node array as it was before any buyer existed. Owning the loop depends on neither.
 *
 * Returns how many corrections it made, so the loop can stop once the layout has settled.
 *
 * O(n^2) with no quadtree, which is free at the tens of nodes a marketplace has and would need
 * revisiting in the thousands.
 */
function separateOverlaps(nodes: GraphNode[]): number {
  let corrections = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      // A node the simulation has not placed yet has no position to correct. Treating it as
      // sitting at the origin is what collapses the whole layout onto one diagonal: every
      // unplaced pair separates along the same arbitrary axis, and the placed nodes get dragged
      // into line with them. Leave it to d3 and pick it up on a later tick.
      if (a.x === undefined || a.y === undefined || b.x === undefined || b.y === undefined) {
        continue;
      }

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minimum = keepApartRadius(a) + keepApartRadius(b);
      if (distance >= minimum || distance === 0) continue;

      // A fraction of the correction per tick, split evenly. Closing the whole gap at once
      // overpowers the alpha-damped forces around it and produces a rigid, unnatural lattice.
      const shift = ((minimum - distance) / distance) * 0.25;
      a.x -= dx * shift;
      a.y -= dy * shift;
      b.x += dx * shift;
      b.y += dy * shift;
      corrections += 1;
    }
  }
  return corrections;
}

export function colorForRoles(roles: Set<NodeRole>): string {
  if (roles.has('treasury')) return theme.text;
  const sells = roles.has('seller');
  const buys = roles.has('buyer');
  if (sells && buys) return theme.warning;
  if (sells) return theme.seller;
  return theme.success;
}

function colorOf(node: GraphNode): string {
  return colorForRoles(node.roles);
}

/**
 * Avatar sprites, keyed by resolved card image URL.
 *
 * Module-level, so a remount — StrictMode's double mount, or leaving the map and coming back —
 * does not re-fetch and re-decode what is already here. A present key with a null value means
 * "asked for, nothing to draw", covering both still-loading and permanently-failed; the canvas
 * treats them identically and draws the plain dot.
 *
 * **A sprite must never be painted on the pointer-area canvas.** force-graph hit-tests by painting
 * every node in a unique colour to a second, shadow canvas and reading the pixel under the cursor
 * back with `getImageData` (`force-graph.mjs:1405`). Drawing a cross-origin image taints whatever
 * canvas it reaches, and `getImageData` on a tainted canvas throws `SecurityError` — which would
 * kill every click and hover on the map at once. Card images come from a Swarm gateway that is not
 * ours, so this is the ordinary case and not the exception. `paintPointerArea` therefore paints
 * plain circles, and the taint stays on the visible canvas, which nothing ever reads back.
 *
 * For the same reason `crossOrigin` is deliberately left unset on the loader: asking for CORS from
 * a gateway that does not send the header fails the load outright, trading every avatar away for a
 * property we have no use for.
 */
const sprites = new Map<string, HTMLCanvasElement | null>();

/**
 * Decode once into a small, already-circular canvas rather than clipping and downscaling the
 * full-size source on every frame of every node.
 *
 * Centre-cropped to a square: a card's `image` is arbitrary third-party content at an arbitrary
 * aspect ratio, and a cropped face reads better than a squashed one.
 */
function toSprite(image: HTMLImageElement): HTMLCanvasElement | null {
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  if (side === 0) return null;

  const sprite = document.createElement('canvas');
  sprite.width = AVATAR_SPRITE_PX;
  sprite.height = AVATAR_SPRITE_PX;
  const ctx = sprite.getContext('2d');
  if (!ctx) return null;

  const half = AVATAR_SPRITE_PX / 2;
  ctx.beginPath();
  ctx.arc(half, half, half, 0, 2 * Math.PI);
  ctx.clip();
  ctx.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SPRITE_PX,
    AVATAR_SPRITE_PX,
  );
  return sprite;
}

/**
 * URLs that will never produce a sprite. The node draws its role icon meanwhile either way; this
 * only stops a dead URL being requested again. There is no retry — a card's image is third-party
 * and may simply not be there.
 */
const failedSprites = new Set<string>();

/**
 * Cache hit, or start one load and report back when it lands. Safe to call from a paint loop:
 * everything after the first call for a URL is a map lookup.
 *
 * `onLoad` fires on failure as well as success. It is a repaint nudge, not a success callback,
 * and the fallback needs painting exactly as much as the sprite does — `autoPauseRedraw` means a
 * settled canvas would otherwise keep the dot until the next drag or zoom.
 */
function spriteFor(url: string, onLoad: () => void): HTMLCanvasElement | null {
  const cached = sprites.get(url);
  if (cached !== undefined) return cached;

  sprites.set(url, null);
  const image = new Image();
  image.onload = () => {
    const sprite = toSprite(image);
    // A decode that yields no drawable sprite — an SVG with no intrinsic size, a zero-byte
    // response — is a failure like any other, not a permanent "still loading".
    if (!sprite) failedSprites.add(url);
    else sprites.set(url, sprite);
    onLoad();
  };
  image.onerror = () => {
    failedSprites.add(url);
    onLoad();
  };
  image.src = url;
  return null;
}

/**
 * Agent Card names are third-party strings — anyone can register an agent called anything — and
 * the tooltip is injected as HTML, so they are escaped rather than trusted.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function roleSummary(node: GraphNode): string {
  const roles = [...node.roles];
  if (roles.length === 0) return 'no activity';
  return roles.join(' · ');
}

const nodeTooltip = (node: GraphNode): string => {
  const lines = [
    `<strong>${escapeHtml(node.label)}</strong>`,
    escapeHtml(roleSummary(node)),
    `${node.txCount} purchase${node.txCount === 1 ? '' : 's'} · ${node.counterparties.size} counterpart${
      node.counterparties.size === 1 ? 'y' : 'ies'
    }`,
  ];
  return lines.join('<br/>');
};

const linkColor = (link: GraphLink): string =>
  link.kind === 'payout' ? theme.linkPayout : theme.linkPurchase;

/**
 * Wheel zoom only with Ctrl/⌘ held. A bare wheel over a 520px canvas otherwise zooms the graph
 * instead of scrolling the page, and a reader scrolling down to the table gets stuck on it.
 * Trackpad pinch arrives as a wheel event with `ctrlKey` set, so pinch-to-zoom still works.
 * Module-level so the prop is stable (see "Every canvas prop must be stable").
 */
const zoomWithModifier = (event: MouseEvent): boolean => event.ctrlKey || event.metaKey;

const linkWidth = (link: GraphLink): number => Math.min(6, 1 + Math.log2(1 + link.count));

const linkTooltip = (link: GraphLink): string =>
  `${escapeHtml(link.kind)} · ${link.count} transfer${link.count === 1 ? '' : 's'}`;

/** Measured rather than assumed — see the note at the top of the file. */
function useMeasuredWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(Math.round(next));
    });
    observer.observe(element);
    setWidth(Math.round(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

export interface AgentGraphProps {
  nodes: GraphNode[];
  links: GraphLink[];
  selectedId?: string;
  /** Must be stable, or the canvas re-applies it on every parent render. */
  onSelect: (node: GraphNode | undefined) => void;
}

function AgentGraph({ nodes, links, selectedId, onSelect }: AgentGraphProps) {
  const [ref, width] = useMeasuredWidth();
  const graph = useRef<ForceGraphMethods<GraphNode, GraphLink>>();
  const fitted = useRef(false);

  /**
   * Memoised because an object literal here is a new `graphData` on every render, and
   * re-applying `graphData` is the one prop change that restarts the layout — colour tracker
   * reset, d3 re-seeded, nodes thrown across the canvas.
   *
   * `memo` on this component stops the parent's 5s tick, but not a render this component causes
   * itself: `avatarEpoch` and `layoutEpoch` both set state here, and with a literal each bump
   * reset the layout, which then settled, which bumped again. Identity has to be stable against
   * renders from *either* direction.
   */
  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);

  /**
   * Re-frame when the set of participants changes size, not only on the first settle.
   *
   * The first layout usually runs on the registry alone — history and its buyers arrive a sweep
   * later — so a fit taken then frames a handful of sellers, and the network that grows out of
   * it spills off the canvas. A refresh that adds no node still leaves the view alone.
   */
  const fittedCount = useRef(0);
  /**
   * The engine-stop fit runs while `separateOverlaps` is still pushing buyers apart, so the
   * network it framed keeps growing past the edges. This asks the separation loop to fit once
   * more when it has finished, framing the layout that actually stays on screen.
   */
  const refitAfterSettle = useRef(false);
  useEffect(() => {
    if (nodes.length !== fittedCount.current) {
      fittedCount.current = nodes.length;
      fitted.current = false;
      refitAfterSettle.current = true;
    }
  }, [nodes]);

  /**
   * Whether force-graph has stopped its own painting since the last data change.
   *
   * A ref, not state: it gates a repaint nudge from inside an animation frame, and making it
   * state would re-render on every layout run for something nothing renders.
   */
  const enginePaused = useRef(false);

  /**
   * Layout tuning, which has to go through the instance because force-graph exposes no props for
   * it. The defaults (charge -30, link distance 30) are sized for small unlabelled dots; with
   * labelled nodes whose radius grows with activity they pack the whole network into a knot in
   * the middle of the canvas. Re-applied on resize because the useful spread depends on width.
   */
  useEffect(() => {
    const instance = graph.current;
    if (!instance || width === 0) return;
    instance.d3Force('charge')?.strength(-260).distanceMax(900);
    // Weakened as well as lengthened: d3's default link strength is inversely proportional to
    // node degree, which pulls a buyer that bought from four sellers hard onto the centroid of
    // those four. Keeping nodes apart is separateOverlaps' job, not the charge's.
    instance.d3Force('link')?.distance(150).strength(0.3);
    fitted.current = false;
    instance.d3ReheatSimulation();
  }, [width]);

  /**
   * Fit once per layout run rather than continuously: a view that re-frames itself on every
   * refresh is harder to read than one that stays where the reader left it.
   *
   * Also the point where force-graph stops painting, so the hit test needs one last resync: the
   * shadow canvas is refreshed on a throttle (`HOVER_CANVAS_THROTTLE_DELAY`, 800ms), and the last
   * refresh before the engine quiets down can be that far behind the final positions.
   */
  const handleEngineStop = useCallback(() => {
    enginePaused.current = true;
    setLayoutEpoch((epoch) => epoch + 1);
    if (fitted.current) return;
    fitted.current = true;
    graph.current?.zoomToFit(400, 60);
  }, []);

  /**
   * Bumped when a sprite finishes decoding, purely to re-identify `drawNode`.
   *
   * force-graph pauses its own redraw once the engine is idle (`autoPauseRedraw` defaults on, see
   * `force-graph.mjs:1626`), so a sprite that lands after the layout settled would not appear
   * until the next drag or zoom. Re-applying an accessor makes the inner graph report
   * `needsRedraw` and the frame gets painted. Unlike re-applying `graphData` it does not restart
   * the layout, which is why this is its own signal and not a reheat.
   */
  const [avatarEpoch, setAvatarEpoch] = useState(0);
  const onAvatarLoad = useCallback(() => setAvatarEpoch((epoch) => epoch + 1), []);

  /**
   * Bumped when the separation loop settles, to resync both canvases with the positions it
   * moved nodes to after force-graph stopped painting. See the loop below.
   */
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  const drawNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radius = drawnRadius(node, globalScale);
      // A verified agent's own avatar when it has one. Otherwise — no card image, still loading, or
      // failed (the shared default image is a dead Swarm reference, so currently always) — the
      // participant's role icon, as the film draws them: a stall for a seller, a robot for a
      // buyer, a vault for the treasury. Only once the node is big enough on screen to read; below
      // that it stays a plain dot, which is what a zoomed-out crowd of buyers needs.
      const avatar = node.avatarUrl ? spriteFor(node.avatarUrl, onAvatarLoad) : null;
      const icon =
        !avatar && radius * globalScale >= ICON_MIN_SCREEN_RADIUS
          ? roleSpriteFor(node, onAvatarLoad)
          : null;
      const sprite = avatar ?? icon;

      if (avatar) {
        // Pre-clipped to a circle, so this needs no save/clip/restore of its own.
        ctx.drawImage(avatar, x - radius, y - radius, radius * 2, radius * 2);
        // The role used to be the fill, which the avatar has now taken. It becomes the ring rather
        // than being dropped: seller / buyer / both is what the legend promises, and an avatar is
        // no substitute for it — an agent's picture says nothing about which side it trades on.
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.strokeStyle = colorOf(node);
        ctx.lineWidth = 2.5 / globalScale;
        ctx.stroke();
      } else if (icon) {
        // A disc in the canvas colour with the role ring the legend promises, the icon inside it.
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = theme.bg;
        ctx.fill();
        ctx.strokeStyle = colorOf(node);
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
        const side = radius * 1.45;
        ctx.drawImage(icon, x - side / 2, y - side / 2, side, side);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = colorOf(node);
        ctx.fill();
      }

      // Outside the avatar's role ring, or on the dot's own edge when there is no avatar, so that
      // two rings are never drawn on top of each other.
      const ringRadius = radius + (sprite ? 3 / globalScale : 0);
      if (node.id === selectedId) {
        ctx.beginPath();
        ctx.arc(x, y, ringRadius, 0, 2 * Math.PI);
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      } else if (node.roles.has('treasury')) {
        // The hub is the one node that is not an agent; a ring says so without a second colour.
        ctx.beginPath();
        ctx.arc(x, y, ringRadius, 0, 2 * Math.PI);
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      // A one-off buyer's label is a truncated address, and dozens of them around one seller pile
      // into an unreadable knot that hides the agent names. They are labelled only once zoomed in
      // far enough to separate them, or when selected; hover still names every node.
      const isBareBuyer =
        node.agentId === undefined && !node.roles.has('seller') && !node.roles.has('treasury');
      if (isBareBuyer && node.id !== selectedId && globalScale < BUYER_LABEL_MIN_SCALE) return;

      const fontSize = 11 / globalScale;
      ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      // A halo in the canvas colour, so a seller's label stays readable over its own fan of edges.
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3 / globalScale;
      ctx.strokeStyle = theme.surface;
      ctx.strokeText(node.label, x, y + radius + 2 / globalScale);
      ctx.fillStyle = node.id === selectedId ? theme.text : theme.textMuted;
      ctx.fillText(node.label, x, y + radius + 2 / globalScale);
    },
    [selectedId, onAvatarLoad, avatarEpoch, layoutEpoch],
  );

  /**
   * Hit area follows the drawn circle, generously, so small nodes stay clickable.
   *
   * Floored in screen pixels, not graph units: at the zoom `zoomToFit` picks, a buyer with one
   * purchase is a ~3px dot, and a 3px target is one nobody can reliably hit. See
   * `MIN_HIT_RADIUS_PX`.
   *
   * Plain circles only — never the avatar. This paints to force-graph's shadow canvas, whose
   * pixels are read back with `getImageData` to resolve the node under the cursor; a cross-origin
   * sprite would taint it and turn every hit test into a `SecurityError`. See the note on
   * `sprites` above.
   *
   * `layoutEpoch` is in the dependencies to force a resync, not because the painting depends on
   * it — see the separation loop below.
   */
  const paintPointerArea = useCallback(
    (node: GraphNode, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const radius = Math.max(drawnRadius(node, globalScale) + 3, MIN_HIT_RADIUS_PX / globalScale);
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [layoutEpoch],
  );

  const handleClick = useCallback(
    (node: GraphNode) => onSelect(node.id === selectedId ? undefined : node),
    [onSelect, selectedId],
  );

  const handleBackgroundClick = useCallback(() => onSelect(undefined), [onSelect]);

  /**
   * Keep nodes from overlapping, on our own animation frame.
   *
   * Restarts whenever the node set changes and stops once the layout has been overlap-free for
   * roughly as long as force-graph's own cooldown, so a settled page is not animating for
   * nothing.
   *
   * **Moving a node behind force-graph's back desynchronises the hit test, so every run has to
   * end in a resync.** Pointer hits are resolved off a second, hidden canvas, and that canvas is
   * only repainted on a frame that is already redrawing (`force-graph.mjs:1653`) — with
   * `autoPauseRedraw` on, both stop once the engine cools down. This loop outlives that: it runs
   * for up to `SETTLE_FRAMES` past the last d3 tick, so whatever it moves in that window moves on
   * neither canvas. The dot stays painted where it was, its hit area stays where it was, and the
   * node is now somewhere else — unclickable, with a dead zone left behind. Buyers get hit
   * hardest because they are what the loop exists to push apart, and they are still moving when
   * the engine quiets down.
   *
   * Bumping `layoutEpoch` on the first quiet frame after that re-identifies `drawNode` and
   * `paintPointerArea`; force-graph repaints on the former (`onChange: notifyRedraw`) and flushes
   * the shadow canvas on the latter.
   *
   * Only while the engine is paused, and only once per settle. While it is still running both
   * canvases are already being repainted, so a nudge would buy nothing and cost a React render —
   * and d3 pulling nodes back together as fast as this pushes them apart makes "corrections
   * stopped" a state the layout passes through many times a second.
   */
  useEffect(() => {
    let frame = 0;
    let settledFrames = 0;
    let moved = false;
    // New data means force-graph re-applies `graphData` and the engine runs again.
    enginePaused.current = false;
    const step = () => {
      if (separateOverlaps(nodes) > 0) {
        moved = true;
        settledFrames = 0;
      } else {
        if (moved && enginePaused.current) {
          moved = false;
          setLayoutEpoch((epoch) => epoch + 1);
        }
        settledFrames += 1;
      }
      if (settledFrames < SETTLE_FRAMES) {
        frame = requestAnimationFrame(step);
      } else if (refitAfterSettle.current) {
        refitAfterSettle.current = false;
        graph.current?.zoomToFit(400, 60);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [nodes]);

  return (
    <div className={styles.graphCanvas} ref={ref} style={{ height: HEIGHT }}>
      {width > 0 && (
        <ForceGraph2D<GraphNode, GraphLink>
          ref={graph}
          graphData={graphData}
          width={width}
          height={HEIGHT}
          backgroundColor={theme.surface}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={paintPointerArea}
          nodeLabel={nodeTooltip}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLabel={linkTooltip}
          linkDirectionalArrowLength={4}
          linkDirectionalArrowRelPos={1}
          linkCurvature={0.08}
          onNodeClick={handleClick}
          onBackgroundClick={handleBackgroundClick}
          onEngineStop={handleEngineStop}
          enableZoomInteraction={zoomWithModifier}
          cooldownTime={4000}
          d3VelocityDecay={0.3}
        />
      )}
    </div>
  );
}

/**
 * Memoised deliberately. `MapPage` re-renders on every 5s balance tick; without this boundary the
 * canvas would re-apply every prop each time, and re-applying `graphData` restarts the layout.
 */
export default memo(AgentGraph);
