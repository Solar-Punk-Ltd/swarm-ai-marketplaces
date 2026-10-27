/**
 * The single fetch owner.
 *
 * Every balance on screen comes from here. Rows must never poll independently — that is how
 * `3N` requests per tick becomes `3N` uncoordinated timers against a rate-limited node.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPublicClient, http } from 'viem';
import type { Address, PublicClient } from 'viem';
import { config } from '../config/env';
import { HISTORY_LIMIT, MAX_LOG_CHUNKS } from '../config/registry';
import { usePolling } from '../hooks/usePolling';
import { isFunded, loadRegistry, readBalances } from '../lib/reads';
import { errorMessage } from '../lib/rpcError';
import { EMPTY_LINK_INDEX, attachSwarmData, loadAgentLinks, refreshSwarmData } from '../lib/agents';
import type { AgentLinkIndex } from '../lib/agents';
import {
  EMPTY_HISTORY,
  applyCachedTimestamps,
  attachTimestamps,
  loadHistory,
  mergeHistory,
  readHistorySince,
} from '../lib/history';
import type { History } from '../lib/history';
import type { BalanceSnapshot, Registry } from '../lib/reads';

/**
 * Three cadences, by how fast each thing changes and how much a reader cares:
 *
 * - **Every tick (5s): balances and Activity.** A purchase should show as a row, and as revenue
 *   to distribute, within one tick. Activity can afford it because only the blocks since the last
 *   tick are read — the window is swept once (and again when the seller set changes).
 * - **Every 12th tick: the registry** (three calls), so a new seller turns up within a minute.
 * - **Every five minutes: who the sellers are.** The agent-link log sweep runs then, or as soon as
 *   the registry gains a clone; Agent Cards and catalogs follow `swarmCache.ts` — kept five
 *   minutes, a miss retried every 10s, three times. A link sweep a node error cut short (a 429,
 *   usually) is retried the same way: every 10s, three times, then every minute.
 *
 * **On load, one sweep at a time.** The agent-link sweep runs first — it is small, and it labels
 * the sellers at the top of the page — and the Activity sweep starts once it has finished. Both
 * at once, plus the block-time reads after the Activity sweep, is the burst a public RPC answers
 * with 429s.
 */
const REGISTRY_RELOAD_EVERY = 12;
const AGENT_LINKS_RELOAD_MS = 5 * 60_000;
const AGENT_LINKS_RETRY_MS = 10_000;
const AGENT_LINKS_MAX_RETRIES = 3;
const AGENT_LINKS_BACKOFF_MS = 60_000;

/** An interrupted full history sweep is repeated after this long; increments carry on meanwhile. */
const HISTORY_RESWEEP_MS = 60_000;

/** One string per set of clones, so a sweep can tell it is still reading the same marketplace. */
const splitterSetKey = (registry: Registry) =>
  registry.sellers
    .map((seller) => seller.splitter.toLowerCase())
    .sort()
    .join(',');

interface HistoryCursor {
  splitters: string;
  throughBlock: bigint;
  /** False when the last full sweep was cut short by a node error. */
  complete: boolean;
  sweptAt: number;
}

export interface MarketplaceState {
  client: PublicClient;
  registry?: Registry;
  balances?: BalanceSnapshot;
  /** True until the first successful load. Drives skeletons, so a real 0 never looks like "no data". */
  loading: boolean;
  /** Last tick failed: values on screen are the last known good ones. */
  stale: boolean;
  error?: string;
  lastUpdated?: number;
  /** Clones currently holding a non-zero ERC-20 balance — the batch sweep's input set. */
  fundedSplitters: Address[];
  /** splitter -> ERC-8004 agent, from registry metadata. Empty when no registry is configured. */
  agentLinks: AgentLinkIndex;
  /** Purchases and payouts across every clone, newest first. */
  history: History;
  /** Force an immediate refresh, e.g. right after a transaction confirms. */
  refresh: () => Promise<void>;
}

const MarketplaceContext = createContext<MarketplaceState | undefined>(undefined);

export function MarketplaceProvider({ children }: { children: ReactNode }) {
  const client = useMemo(
    () =>
      createPublicClient({
        chain: config.chain,
        // JSON-RPC batching collapses a whole tick into one HTTP round trip, and unlike
        // Multicall3 aggregation it covers eth_getBalance too.
        // A rate-limited call (429) is retried after 1s, 2s, 4s rather than viem's default 150ms
        // steps, which land inside the same rate window and fail again.
        transport: http(config.rpcUrl, { batch: true, retryDelay: 1000 }),
      }) as PublicClient,
    [],
  );

  const [registry, setRegistry] = useState<Registry>();
  const [agentLinks, setAgentLinks] = useState<AgentLinkIndex>(EMPTY_LINK_INDEX);
  const [balances, setBalances] = useState<BalanceSnapshot>();
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<number>();

  const registryRef = useRef<Registry>();
  const tickRef = useRef(0);
  const historyInFlight = useRef(false);
  const historyRef = useRef<History>(EMPTY_HISTORY);
  const historyCursor = useRef<HistoryCursor>();
  const agentLinksRef = useRef<AgentLinkIndex>(EMPTY_LINK_INDEX);
  const agentLinksSweep = useRef<{ splitters: string; nextAt: number; retries: number }>();
  const agentLinksInFlight = useRef(false);
  const inFlight = useRef(false);

  const showHistory = useCallback((next: History) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const showAgentLinks = useCallback((next: AgentLinkIndex) => {
    agentLinksRef.current = next;
    setAgentLinks(next);
  }, []);

  /** Read whatever Agent Cards and catalogs are due; re-render only when one changed. */
  const refreshSwarm = useCallback(async () => {
    const changed = await refreshSwarmData(agentLinksRef.current, config.swarmGateway);
    if (!changed) return;
    const next = attachSwarmData(agentLinksRef.current, config.swarmGateway);
    if (next !== agentLinksRef.current) showAgentLinks(next);
  }, [showAgentLinks]);

  const refreshAgentLinks = useCallback(
    async (current: Registry) => {
      const registryConfig = config.identityRegistry;
      if (!registryConfig) return;

      // The link sweep crawls the identity registry's logs, and who owns which clone changes about
      // as often as an agent re-registers — so only when the set of clones moved, or it is due.
      const splitters = splitterSetKey(current);
      const last = agentLinksSweep.current;
      if (agentLinksInFlight.current) return;
      if (last && last.splitters === splitters && Date.now() < last.nextAt) return;
      agentLinksInFlight.current = true;

      // A sweep a node error cut short is retried soon, a few times, then backed off — a 429
      // storm must not turn into a sweep every 10s for as long as the page is open.
      const retries = last && last.splitters === splitters ? last.retries : 0;
      const schedule = (incomplete: boolean) => {
        const nextRetries = incomplete ? retries + 1 : 0;
        agentLinksSweep.current = {
          splitters,
          retries: nextRetries,
          nextAt:
            Date.now() +
            (!incomplete
              ? AGENT_LINKS_RELOAD_MS
              : nextRetries <= AGENT_LINKS_MAX_RETRIES
                ? AGENT_LINKS_RETRY_MS
                : AGENT_LINKS_BACKOFF_MS),
        };
      };

      const sellerBySplitter = new Map(
        current.sellers.map((seller) => [seller.splitter.toLowerCase(), seller.seller]),
      );

      try {
        const links = await loadAgentLinks(
          client,
          {
            registry: registryConfig.address,
            fromBlock: registryConfig.fromBlock,
            chunkBlocks: registryConfig.chunkBlocks,
            knownSplitters: current.sellers.map((seller) => seller.splitter),
            previous: agentLinksRef.current,
          },
          (splitter) => sellerBySplitter.get(splitter.toLowerCase()),
        );
        // Render the on-chain half immediately, with whatever cards are already cached — the
        // card fetch hits a gateway we do not control, and the badge must not wait on it.
        showAgentLinks(attachSwarmData(links, config.swarmGateway));
        schedule(links.incomplete);
        void refreshSwarm();
      } catch {
        // Keep whatever labels we already had, and try again soon.
        schedule(true);
      } finally {
        agentLinksInFlight.current = false;
      }
    },
    [client, refreshSwarm, showAgentLinks],
  );

  const refreshHistory = useCallback(
    async (current: Registry) => {
      const registryConfig = config.identityRegistry;
      // Reuses the identity registry's window/chunking: same public-node constraints, and it
      // is already the "how far back do we look" knob operators tune.
      if (!registryConfig || historyInFlight.current) return;
      historyInFlight.current = true;

      const splitters = current.sellers.map((seller) => seller.splitter);
      const key = splitterSetKey(current);

      try {
        const cursor = historyCursor.current;
        // Read only what is new, unless this is a different marketplace than the one swept (a
        // clone was added, so its earlier logs were never asked for) or the sweep needs repeating.
        const incremental =
          cursor &&
          cursor.splitters === key &&
          (cursor.complete || Date.now() - cursor.sweptAt < HISTORY_RESWEEP_MS)
            ? await readHistorySince(client, cursor.throughBlock, {
                splitters,
                currencies: config.currencies,
                chunkBlocks: registryConfig.chunkBlocks,
              })
            : undefined;

        let next: History;
        if (cursor && incremental) {
          historyCursor.current = { ...cursor, throughBlock: incremental.head };
          next = mergeHistory(historyRef.current, incremental.entries, HISTORY_LIMIT);
          if (next === historyRef.current) return;
        } else {
          const sweep = await loadHistory(client, {
            splitters,
            currencies: config.currencies,
            fromBlock: registryConfig.fromBlock,
            chunkBlocks: registryConfig.chunkBlocks,
            maxChunks: MAX_LOG_CHUNKS,
            limit: HISTORY_LIMIT,
          });
          historyCursor.current = {
            splitters: key,
            throughBlock: sweep.head,
            complete: !sweep.interrupted,
            sweptAt: Date.now(),
          };
          next = sweep.history;
        }

        // Show rows as soon as they are known; block times are a second round trip and must
        // not hold up the table. Cached timestamps are applied up front so consumers that filter
        // by time do not see every row as timeless for the duration of that round trip.
        showHistory({ ...next, entries: applyCachedTimestamps(next.entries) });
        const withTimes = await attachTimestamps(client, next.entries);
        if (withTimes.some((e, i) => e.timestamp !== historyRef.current.entries[i]?.timestamp)) {
          showHistory({ ...next, entries: withTimes });
        }
      } catch {
        // Keep the previous history; a failed sweep is not worth a visible error.
      } finally {
        historyInFlight.current = false;
      }
    },
    [client, showHistory],
  );

  const tick = useCallback(
    async (forceRegistry: boolean) => {
      // Skip rather than queue: a slow node must not build a backlog of ticks.
      if (inFlight.current) return;
      inFlight.current = true;

      try {
        const needsRegistry = forceRegistry || !registryRef.current;
        if (needsRegistry || tickRef.current % REGISTRY_RELOAD_EVERY === 0) {
          const next = await loadRegistry(client, config.factory);
          registryRef.current = next;
          setRegistry(next);
        }

        if (registryRef.current) {
          // Agent labels are supplementary: a registry that is unset, unreachable, or slow must
          // never stop balances from rendering, so this is not awaited, and swallows its errors.
          // Every tick, because it decides for itself whether a sweep or a retry is due.
          void refreshAgentLinks(registryRef.current);
          // Not alongside the first link sweep: see "On load, one sweep at a time" above.
          if (agentLinksSweep.current || !config.identityRegistry) {
            void refreshHistory(registryRef.current);
          }
        }
        // Cheap when nothing is due: the caches make no request until a read is.
        void refreshSwarm();

        const current = registryRef.current;
        if (current) {
          const snapshot = await readBalances(client, {
            treasury: config.treasury,
            sellers: current.sellers,
            currencies: config.currencies,
          });
          setBalances(snapshot);
        }

        setStale(false);
        setError(undefined);
        setLastUpdated(Date.now());
        setLoading(false);
      } catch (err) {
        // Keep the last good values on screen and mark them stale; blanking the table mid-demo
        // is worse than showing slightly old numbers.
        setError(errorMessage(err));
        setStale(true);
        setLoading(false);
      } finally {
        tickRef.current += 1;
        inFlight.current = false;
      }
    },
    [client, refreshAgentLinks, refreshHistory, refreshSwarm],
  );

  usePolling(() => tick(false), config.refreshIntervalMs);

  const refresh = useCallback(() => tick(true), [tick]);

  const fundedSplitters = useMemo(() => {
    if (!registry || !balances) return [];
    return registry.sellers
      .map((s) => s.splitter)
      .filter((splitter) => isFunded(balances.splitters[splitter]));
  }, [registry, balances]);

  const value = useMemo<MarketplaceState>(
    () => ({
      client,
      registry,
      balances,
      loading,
      stale,
      error,
      lastUpdated,
      fundedSplitters,
      agentLinks,
      history,
      refresh,
    }),
    [
      client,
      registry,
      balances,
      loading,
      stale,
      error,
      lastUpdated,
      history,
      fundedSplitters,
      agentLinks,
      refresh,
    ],
  );

  return <MarketplaceContext.Provider value={value}>{children}</MarketplaceContext.Provider>;
}

export function useMarketplace(): MarketplaceState {
  const ctx = useContext(MarketplaceContext);
  if (!ctx) throw new Error('useMarketplace must be used inside <MarketplaceProvider>');
  return ctx;
}
