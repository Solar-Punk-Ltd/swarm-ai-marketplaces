/**
 * Resolving which ERC-8004 agent owns each splitter clone.
 *
 * The binding lives in the Identity Registry as metadata under `agent_splitter`, written by
 * `link_split_contract`. `MetadataSet` indexes the key, so the whole splitter -> agent reverse
 * index is one log query rather than a crawl over every Agent Card.
 *
 * A claim is not proof. Any agent owner can write any address under that key, so every link here
 * is verified against two independent facts before the UI calls it confirmed:
 *   1. the claimed splitter is actually in the factory registry, and
 *   2. that clone's frozen `seller` is the agent's registered wallet or its NFT owner.
 *
 * The ABI below is a four-entry subset of the registry's, written for viem. The dashboard is
 * viem-only and deliberately does not depend on `@solarpunk/erc8004-adapter`, which is ethers and
 * pulls in bee-js.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  isAddress,
  getAddress,
  keccak256,
  parseAbiItem,
  toBytes,
} from 'viem';
import type { Address, PublicClient } from 'viem';
import {
  chunkRangesNewestFirst,
  DEFAULT_LOG_CHUNK_BLOCKS,
  LOG_SWEEP_CONCURRENCY,
  MAX_LOG_CHUNKS,
  sweepStart,
} from '../config/registry';
import { SwarmCache } from './swarmCache';

/** Must match AGENT_SPLITTER in erc8004-adapter/src/constants.ts. */
export const AGENT_SPLITTER_KEY = 'agent_splitter';

/** Agent Card services entry carrying the catalog feed owner (spec §4.1). */
const CATALOG_SERVICE_NAME = 'swarm-ai-catalog';

/**
 * Fixed protocol constant — `keccak256("swarm-ai-catalog.v1")`. Mirrors CATALOG_FEED_TOPIC in
 * swarm-catalog/src/feeds.ts. No chain, registry, or agent identity is encoded in it, so the
 * owner address alone locates a catalog.
 */
export const CATALOG_FEED_TOPIC = keccak256(toBytes('swarm-ai-catalog.v1'));

const METADATA_SET_EVENT = parseAbiItem(
  'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
);

const OWNER_OF = parseAbiItem('function ownerOf(uint256 tokenId) view returns (address)');
const AGENT_WALLET = parseAbiItem(
  'function getAgentWallet(uint256 agentId) view returns (address)',
);
const TOKEN_URI = parseAbiItem('function tokenURI(uint256 tokenId) view returns (string)');

export type LinkStatus =
  /** Clone's seller matches the agent's registered wallet or NFT owner. */
  | 'verified'
  /** Link points at a real clone, but its seller is neither the agent wallet nor the owner. */
  | 'unverified'
  /** More than one agent claims this clone — we refuse to pick a winner. */
  | 'disputed'
  /**
   * The registry could not be read for this agent — the node rate-limited or failed the call — so
   * whether the link holds is not known yet. Never shown as `unverified`: that is a finding about
   * the agent, and a 429 is not one. Retried within seconds.
   */
  | 'unchecked';

/** The subset of the ERC-8004 Agent Card this dashboard displays. */
export interface AgentCardInfo {
  name?: string;
  description?: string;
  /** Resolved http(s) URL the card was fetched from, for the "open card" affordance. */
  url: string;
  /**
   * Resolved http(s) URL of the card's `image`. `createAgentCard` defaults it
   * (`DEFAULT_AGENT_IMAGE` in erc8004-adapter), so most registered agents carry one. Undefined
   * when the card omits it or names a scheme we will not follow.
   */
  image?: string;
  /**
   * Catalog feed owner from the card's `swarm-ai-catalog` service entry. Undefined when the
   * agent publishes no catalog — a seller can hold a splitter without listing anything.
   */
  catalogFeedOwner?: Address;
  /**
   * The whole card as fetched, for the card viewer to show at once instead of waiting on the
   * gateway again. Third-party data: displayed as text, never trusted or interpreted.
   */
  document: unknown;
}

export interface AgentLink {
  agentId: bigint;
  splitter: Address;
  owner?: Address;
  /** The registry's EIP-712-verified wallet for this agent, when one is set. */
  agentWallet?: Address;
  /** On-chain tokenURI. May be an https gateway URL or a bzz:// reference. */
  agentURI?: string;
  /**
   * Populated by a second, best-effort pass. Undefined means the card has not been
   * fetched or could not be — never that the agent has no name.
   */
  card?: AgentCardInfo;
  /**
   * The catalog named by the card's `swarm-ai-catalog` entry, filled in by the same pass as
   * `card`. Undefined when there is no card, no catalog feed, or it has not resolved yet.
   */
  catalog?: CatalogLinkInfo;
  status: LinkStatus;
}

export interface AgentLinkIndex {
  /** Keyed by lowercased clone address. */
  bySplitter: Map<string, AgentLink>;
  /** True when the log sweep was cut short, so absence of a link proves nothing. */
  partial: boolean;
  /**
   * True when a node error (not a revert) cut a read short — a rate limit, typically. What could
   * not be read was carried over from the previous index or marked `unchecked`; the caller should
   * sweep again soon rather than at the usual cadence.
   */
  incomplete: boolean;
}

export const EMPTY_LINK_INDEX: AgentLinkIndex = {
  bySplitter: new Map(),
  partial: false,
  incomplete: false,
};

/**
 * The short name to show for an agent wherever only one label fits (activity rows, map nodes).
 *
 * Card names are free text and nothing makes them unique — two agents both called
 * `devcon8-seller-1` are the ordinary result of redeploying a demo. When a name is shared by more
 * than one agent id in the index, the id is appended so the two can be told apart.
 */
export function agentDisplayName(link: AgentLink, index: AgentLinkIndex): string {
  const name = link.card?.name;
  if (!name) return `Agent #${link.agentId}`;
  for (const other of index.bySplitter.values()) {
    if (other.agentId !== link.agentId && other.card?.name === name) {
      return `${name} #${link.agentId}`;
    }
  }
  return name;
}

/** 20-byte metadata value -> address. Null for anything else; one bad claim must not break a sweep. */
function decodeAddress(value: `0x${string}`): Address | null {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : null;
}

/**
 * Read every `agent_splitter` claim, newest wins per agent.
 *
 * Chunked because public nodes reject wide `eth_getLogs` ranges. A chunk that fails ends the
 * sweep and marks the result partial rather than throwing — a missing agent label is a much
 * smaller problem than a dashboard that will not load.
 */
async function readClaims(
  client: PublicClient,
  registry: Address,
  fromBlock: bigint,
  chunkBlocks: bigint,
): Promise<{ claims: Map<bigint, Address>; partial: boolean; failed: boolean }> {
  const head = await client.getBlockNumber();
  const claims = new Map<bigint, Address>();

  // Newest blocks get the chunk budget, and the sweep runs **backward from head** — same reasons
  // as `loadHistory`: pruned nodes and range limits fail at the old end, and a forward sweep hits
  // that wall before reading anything. A link written outside the window is missed, which is why
  // `partial` must keep suppressing "No agent linked": absence proves nothing here.
  //
  // Backward means logs arrive newest-first, inverting the old "later writes overwrite" rule.
  // `settled` records every agent whose most recent claim has been seen, so an older write can
  // never clobber a newer one — including the delete case, where the newest claim being garbage
  // must leave the agent unlinked rather than fall back to a previous address.
  const { start, truncated } = sweepStart(head, fromBlock, chunkBlocks, MAX_LOG_CHUNKS);
  const settled = new Set<bigint>();
  let partial = truncated;
  let failed = false;

  const { ranges, exhausted } = chunkRangesNewestFirst(head, start, chunkBlocks, MAX_LOG_CHUNKS);
  if (exhausted) partial = true;

  for (let g = 0; g < ranges.length; g += LOG_SWEEP_CONCURRENCY) {
    const group = ranges.slice(g, g + LOG_SWEEP_CONCURRENCY);
    const results = await Promise.all(
      group.map(([from, to]) =>
        client
          .getLogs({
            address: registry,
            event: METADATA_SET_EVENT,
            // viem hashes an indexed string arg to keccak256 for the topic filter.
            args: { indexedMetadataKey: AGENT_SPLITTER_KEY },
            fromBlock: from,
            toBlock: to,
          })
          .then(
            (logs) => ({ ok: true as const, logs }),
            (err: unknown) => ({ ok: false as const, err, from, to }),
          ),
      ),
    );

    let stop = false;
    // `results` is newest-chunk-first, matching `ranges`, so processing it in order keeps the
    // whole sweep strictly newest-first.
    for (const result of results) {
      if (!result.ok) {
        // Surface the node's own message: an over-wide chunk names its ceiling, a pruned node
        // names its earliest retained block.
        console.warn(
          `[agents] claim sweep stopped at blocks ${result.from}-${result.to}: ` +
            (result.err instanceof Error ? result.err.message : String(result.err)),
        );
        partial = true;
        failed = true;
        stop = true;
        continue;
      }
      // Within a chunk, logs are ascending — walk it in reverse.
      for (let i = result.logs.length - 1; i >= 0; i--) {
        const log = result.logs[i];
        const agentId = log.args.agentId;
        const value = log.args.metadataValue;
        if (agentId === undefined || value === undefined) continue;
        if (settled.has(agentId)) continue;
        settled.add(agentId);
        // An agent can clear its link by writing garbage; leave it unlinked rather than keep a
        // stale one.
        const address = decodeAddress(value);
        if (address) claims.set(agentId, address);
      }
    }
    if (stop) break;
  }

  return { claims, partial, failed };
}

/**
 * `ownerOf` / `getAgentWallet` both revert for some agents; absence is normal, not an error. Only
 * a revert means absence, though. Anything else — a 429, a timeout — says nothing about the agent,
 * so it comes back as `failed` rather than as a missing value that would read as "unverified".
 */
async function tryRead<T>(
  client: PublicClient,
  registry: Address,
  abi: typeof OWNER_OF | typeof AGENT_WALLET | typeof TOKEN_URI,
  agentId: bigint,
): Promise<{ value?: T; failed: boolean }> {
  try {
    const value = (await client.readContract({
      address: registry,
      abi: [abi],
      functionName: abi.name,
      args: [agentId],
    })) as T;
    return { value, failed: false };
  } catch (err) {
    const reverted =
      err instanceof BaseError &&
      err.walk((e) => e instanceof ContractFunctionRevertedError) instanceof
        ContractFunctionRevertedError;
    return { failed: !reverted };
  }
}

export interface LoadAgentLinksParams {
  registry: Address;
  fromBlock: bigint;
  chunkBlocks?: bigint;
  /** Clone addresses the factory actually knows about. Claims outside this set are discarded. */
  knownSplitters: Address[];
  /** The index on screen. Whatever a node error stops this sweep reading is carried over from it. */
  previous?: AgentLinkIndex;
}

/**
 * Build the splitter -> agent index, verified against the factory registry.
 *
 * `sellerOf` supplies each clone's frozen seller, which the caller already read via
 * `splitterTerms` — re-reading it here would be a wasted round trip.
 */
export async function loadAgentLinks(
  client: PublicClient,
  params: LoadAgentLinksParams,
  sellerOf: (splitter: Address) => Address | undefined,
): Promise<AgentLinkIndex> {
  const { registry, fromBlock, chunkBlocks = BigInt(DEFAULT_LOG_CHUNK_BLOCKS) } = params;

  const known = new Set(params.knownSplitters.map((s) => s.toLowerCase()));
  const { claims, partial, failed } = await readClaims(client, registry, fromBlock, chunkBlocks);
  const previous = params.previous?.bySplitter;
  let incomplete = failed;

  // Discard claims on clones this factory never created — an agent naming an arbitrary address
  // should not put a label on anything, and must not shadow a real link.
  const relevant = [...claims.entries()].filter(([, splitter]) =>
    known.has(splitter.toLowerCase()),
  );

  const resolved = await Promise.all(
    relevant.map(async ([agentId, splitter]) => {
      const [owner, agentWallet, agentURI] = await Promise.all([
        tryRead<Address>(client, registry, OWNER_OF, agentId),
        tryRead<Address>(client, registry, AGENT_WALLET, agentId),
        tryRead<string>(client, registry, TOKEN_URI, agentId),
      ]);
      return {
        agentId,
        splitter,
        owner: owner.value,
        agentWallet: agentWallet.value,
        agentURI: agentURI.value,
        failed: owner.failed || agentWallet.failed || agentURI.failed,
      };
    }),
  );

  const bySplitter = new Map<string, AgentLink>();

  for (const { failed: readFailed, ...entry } of resolved) {
    const key = entry.splitter.toLowerCase();
    const seller = sellerOf(entry.splitter)?.toLowerCase();

    const matches =
      seller !== undefined &&
      (entry.agentWallet?.toLowerCase() === seller || entry.owner?.toLowerCase() === seller);

    let link: AgentLink = { ...entry, status: matches ? 'verified' : 'unverified' };
    // A match is proof whichever read failed; a mismatch with a read missing is no finding at all.
    // Keep what the last sweep established for this agent, or say it is not known yet.
    if (readFailed && !matches) {
      incomplete = true;
      const before = previous?.get(key);
      link =
        before && before.agentId === entry.agentId && before.status !== 'unchecked'
          ? before
          : { ...entry, status: 'unchecked' };
    }

    const existing = bySplitter.get(key);
    if (existing && existing.agentId !== link.agentId) {
      // Two agents naming the same clone. Neither is trustworthy on its own, so say so rather
      // than silently showing whichever the log order happened to surface last.
      bySplitter.set(key, { ...link, status: 'disputed' });
      continue;
    }
    bySplitter.set(key, link);
  }

  // A claim sweep a node error cut short has not seen every link: keep those it missed.
  if (failed && previous) {
    for (const [key, link] of previous) {
      if (!bySplitter.has(key) && known.has(key)) bySplitter.set(key, link);
    }
  }

  return { bySplitter, partial, incomplete };
}

/**
 * Turn a `tokenURI` into something fetchable.
 *
 * Agent Cards are addressed either as an https gateway URL (`<gateway>/feeds/<owner>/<topic>`)
 * or as a bare `bzz://<reference>`. Anything else is left alone rather than guessed at.
 */
export function resolveCardUrl(agentURI: string, gateway: string): string | undefined {
  if (agentURI.startsWith('https://') || agentURI.startsWith('http://')) return agentURI;
  if (agentURI.startsWith('bzz://')) {
    return `${gateway.replace(/\/+$/, '')}/bzz/${agentURI.slice('bzz://'.length)}`;
  }
  return undefined;
}

/**
 * The catalog feed owner is the `endpoint` of the card's `swarm-ai-catalog` service entry — a
 * bare EOA address, not a URL. It is a separate key from the Agent Card's own feed signer by
 * design, so it cannot be derived from the card's location.
 */
function readCatalogFeedOwner(card: Record<string, unknown>): Address | undefined {
  const services = card.services;
  if (!Array.isArray(services)) return undefined;

  for (const service of services) {
    if (typeof service !== 'object' || service === null) continue;
    const entry = service as Record<string, unknown>;
    if (entry.name !== CATALOG_SERVICE_NAME) continue;
    const endpoint = typeof entry.endpoint === 'string' ? entry.endpoint.trim() : '';
    if (isAddress(endpoint)) return getAddress(endpoint);
  }
  return undefined;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Fetch one Agent Card. Resolves to undefined on any failure — the card lives on a Swarm
 * gateway this dashboard does not control, so a CORS rejection, a cold feed, or a slow
 * gateway are all expected outcomes, not errors. The badge falls back to the agent id.
 */
async function fetchCard(
  url: string,
  gateway: string,
  timeoutMs: number,
): Promise<AgentCardInfo | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    const card = (await response.json()) as Record<string, unknown>;
    const image = readString(card, 'image');
    return {
      name: readString(card, 'name'),
      description: readString(card, 'description'),
      url,
      // Through the same resolver as the card's own location, which follows http(s) and `bzz://`
      // and nothing else — a `data:` or `javascript:` image URL from a third-party card is
      // dropped rather than handed to a renderer.
      image: image ? resolveCardUrl(image, gateway) : undefined,
      catalogFeedOwner: readCatalogFeedOwner(card),
      document: card,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A Swarm reference as the catalog feed carries it — a bare 64-char hex string (§4.1). */
const SWARM_REFERENCE_RE = /^[0-9a-f]{64}$/i;

/** `catalog.jsonld`. Mirrors CATALOG_MANIFEST_PATH in swarm-catalog/src/paths.ts. */
const CATALOG_MANIFEST_PATH = 'catalog.jsonld';

/**
 * Read the catalog feed and return the Mantaray root it points at.
 *
 * Bee answers `GET /feeds/<owner>/<topic>` with the feed's latest payload as the body, and the
 * catalog feed payload is nothing but the root reference as utf-8 hex — not JSON, not an
 * envelope. Anything else is treated as no catalog: undefined, never a guess.
 */
async function readCatalogFeedRoot(
  gateway: string,
  catalogFeedOwner: Address,
  timeoutMs: number,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${gateway}/feeds/${catalogFeedOwner}/${CATALOG_FEED_TOPIC.slice(2)}`,
      { signal: controller.signal },
    );
    if (!response.ok) return undefined;
    const root = (await response.text()).trim();
    return SWARM_REFERENCE_RE.test(root) ? root.toLowerCase() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the catalog document behind a resolved feed can actually be retrieved.
 *
 * The feed outlives what it points at: a feed update is a single chunk, while the catalog is a
 * whole Mantaray, and once the postage batch that stamped the catalog expires the gateway answers
 * 404 for it while the feed still names the root. Any answer other than 2xx — or no answer — is
 * reported as unavailable, because the link would be just as dead to the person clicking it.
 */
async function catalogRetrievable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `available` — the link works. `unavailable` — the feed names a catalog, but the gateway cannot
 * serve it (most often an expired postage stamp).
 */
export interface CatalogLinkInfo {
  url: string;
  available: boolean;
}

/**
 * Where to send someone who wants to browse this agent's catalog, and whether that link works.
 *
 * Two hops, both on the gateway. The feed URL is not itself a destination: it resolves to the
 * Mantaray root, not to the catalog, so the root has to be read before a link exists. The
 * collection document then sits at `/catalog.jsonld` under that root, giving
 * `<gateway>/bzz/<root>/catalog.jsonld`. A third request checks that document is retrievable.
 *
 * Resolves to undefined when no catalog root resolves, like the card fetch above — the gateway is
 * not ours, and a seller can hold a splitter and have never published a catalog.
 */
async function resolveCatalog(
  catalogFeedOwner: Address,
  gateway: string,
  timeoutMs: number,
): Promise<CatalogLinkInfo | undefined> {
  const root = await readCatalogFeedRoot(gateway, catalogFeedOwner, timeoutMs);
  if (!root) return undefined;
  const url = `${gateway}/bzz/${root}/${CATALOG_MANIFEST_PATH}`;
  return { url, available: await catalogRetrievable(url, timeoutMs) };
}

/**
 * Agent Cards by resolved URL, and catalog links by gateway + feed owner — one read per distinct
 * card or catalog, not per row, since the same agent can hold several clones. Both keep what they
 * found for five minutes and retry a miss a few times first (see `swarmCache.ts`). A catalog that
 * resolves but cannot be retrieved is kept, so it can say "Catalog unavailable", and retried like
 * a miss — the usual cause, an expired stamp, can be fixed by re-stamping.
 */
const cardCache = new SwarmCache<AgentCardInfo>({
  same: (a, b) => a.url === b.url && JSON.stringify(a.document) === JSON.stringify(b.document),
});
const catalogCache = new SwarmCache<CatalogLinkInfo>({
  isHit: (catalog) => catalog.available,
  same: (a, b) => a.url === b.url && a.available === b.available,
});

const trimGateway = (gateway: string) => gateway.replace(/\/+$/, '');
const catalogKey = (owner: Address, gateway: string) =>
  `${trimGateway(gateway)}|${owner.toLowerCase()}`;

/**
 * Read every Agent Card and catalog behind `index` that is due (never read, past five minutes, or
 * a miss whose retry has come up). Resolves to whether anything changed, so the caller re-renders
 * only then — with `attachSwarmData`.
 *
 * Deliberately separate from `loadAgentLinks`: the on-chain half is fast and reliable, the
 * gateway half is neither, and the badge must not wait on it. Called on every tick; when nothing
 * is due it makes no request at all.
 */
export async function refreshSwarmData(
  index: AgentLinkIndex,
  gateway: string,
  timeoutMs = 8000,
): Promise<boolean> {
  const base = trimGateway(gateway);
  const urls = new Set<string>();
  for (const link of index.bySplitter.values()) {
    const url = link.agentURI ? resolveCardUrl(link.agentURI, base) : undefined;
    if (url) urls.add(url);
  }

  const changed = await Promise.all(
    [...urls].map(async (url) => {
      const cardChanged = await cardCache.refresh(url, () => fetchCard(url, base, timeoutMs));
      // The catalog's location is in the card, so it waits for the card.
      const owner = cardCache.peek(url)?.catalogFeedOwner;
      const catalogChanged = owner
        ? await catalogCache.refresh(catalogKey(owner, base), () =>
            resolveCatalog(owner, base, timeoutMs),
          )
        : false;
      return cardChanged || catalogChanged;
    }),
  );
  return changed.some(Boolean);
}

/**
 * Put what the caches hold onto each link, synchronously. Applied to a freshly swept index before
 * it is rendered, so a registry reload never drops names back to bare agent ids while the cards
 * are fetched again. Returns `index` itself when nothing differs.
 */
export function attachSwarmData(index: AgentLinkIndex, gateway: string): AgentLinkIndex {
  const base = trimGateway(gateway);
  let changed = false;
  const bySplitter = new Map<string, AgentLink>();
  for (const [key, link] of index.bySplitter) {
    const url = link.agentURI ? resolveCardUrl(link.agentURI, base) : undefined;
    const card = url ? cardCache.peek(url) : undefined;
    const owner = card?.catalogFeedOwner;
    const catalog = owner ? catalogCache.peek(catalogKey(owner, base)) : undefined;
    if (card === link.card && catalog === link.catalog) {
      bySplitter.set(key, link);
      continue;
    }
    changed = true;
    bySplitter.set(key, { ...link, card, catalog });
  }
  return changed ? { ...index, bySplitter } : index;
}
