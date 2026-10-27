/**
 * Marketplace transaction history, read entirely from chain logs.
 *
 * Two flows make up the money cycle this dashboard is about:
 *
 *   purchase — an ERC-20 Transfer INTO a splitter clone. Every x402 settlement is a
 *              `transferWithAuthorization` from the buyer to the seller's clone, which emits
 *              a plain Transfer, so the buyer is the log's `from`.
 *   payout   — `Distributed` on a clone, emitted when someone presses Distribute.
 *
 * Both filter on indexed args across ALL clones at once, so a sweep is two `getLogs` per
 * chunk regardless of how many sellers exist — never one request per seller.
 *
 * The window is swept once (`loadHistory`); after that only the blocks since are read
 * (`readHistorySince`), which is two `getLogs` and is what lets Activity update every tick.
 *
 * What is deliberately NOT here: which dataset was bought. The item id never reaches the
 * chain (it lives in each x402 server's local SQLite), so a purchase row can say who paid
 * whom and how much, and must not pretend to say more.
 */
import { erc20Abi, parseAbiItem } from 'viem';
import type { Address, PublicClient } from 'viem';
import { erc20Currencies, type Currency } from '../config/currencies';
import { chunkRangesNewestFirst, LOG_SWEEP_CONCURRENCY, sweepStart } from '../config/registry';

const DISTRIBUTED_EVENT = parseAbiItem(
  'event Distributed(address indexed token, uint256 sellerAmount, uint256 treasuryAmount)',
);

const TRANSFER_EVENT = erc20Abi.find((item) => item.type === 'event' && item.name === 'Transfer')!;

export type EntryKind = 'purchase' | 'payout';

export interface HistoryEntry {
  kind: EntryKind;
  /** Clone the money moved into (purchase) or out of (payout). Joins a row to its seller. */
  splitter: Address;
  /** Buyer address. Purchases only — a payout has no counterparty worth naming. */
  from?: Address;
  currency: Currency;
  /** Purchase: amount paid. Payout: seller + treasury combined. */
  amount: bigint;
  /** Payout only — how the total was split. */
  sellerAmount?: bigint;
  treasuryAmount?: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
  /** Position in the block. With `blockNumber`, identifies the row: a batch sweep is one tx. */
  logIndex: number;
  /** Unix ms. Undefined until the block timestamp is resolved (see attachTimestamps). */
  timestamp?: number;
}

export interface History {
  entries: HistoryEntry[];
  /** True when the scan hit its chunk ceiling or a node error: the list is incomplete. */
  partial: boolean;
}

export const EMPTY_HISTORY: History = { entries: [], partial: false };

/** Newest first. Block and log index are a total order, so rows never reshuffle between polls. */
function sortNewestFirst(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
    return b.logIndex - a.logIndex;
  });
}

const entryKey = (e: HistoryEntry) => `${e.blockNumber}:${e.logIndex}`;

/** What a sweep covered, so the next read can pick up where it stopped. */
export interface SweepResult {
  history: History;
  /** The block the sweep read through. */
  head: bigint;
  /** A node error cut the sweep short — worth repeating, unlike a window that is simply long. */
  interrupted: boolean;
}

interface RangeQuery {
  tokens: ReturnType<typeof erc20Currencies>;
  splitters: Address[];
  byAddress: Map<string, Currency>;
  cloneSet: Set<string>;
}

function rangeQuery(splitters: Address[], currencies: Currency[]): RangeQuery {
  const tokens = erc20Currencies(currencies);
  return {
    tokens,
    splitters,
    byAddress: new Map(tokens.map((c) => [c.address.toLowerCase(), c as Currency])),
    cloneSet: new Set(splitters.map((s) => s.toLowerCase())),
  };
}

/** Purchases and payouts in one block range: two `getLogs`, whatever the number of clones. */
async function readRange(
  client: PublicClient,
  query: RangeQuery,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<HistoryEntry[]> {
  const { tokens, splitters, byAddress, cloneSet } = query;
  const [transfers, distributions] = await Promise.all([
    // `to` is indexed, so one filter covers every clone.
    client.getLogs({
      address: tokens.map((c) => c.address),
      event: TRANSFER_EVENT,
      args: { to: splitters },
      fromBlock,
      toBlock,
    }),
    client.getLogs({ address: splitters, event: DISTRIBUTED_EVENT, fromBlock, toBlock }),
  ]);

  const entries: HistoryEntry[] = [];
  for (const log of transfers) {
    const currency = byAddress.get(log.address.toLowerCase());
    const to_ = log.args.to;
    const value = log.args.value;
    if (!currency || !to_ || value === undefined) continue;
    // A clone can also receive from a non-buyer; the row is still money in, so keep it.
    if (!cloneSet.has(to_.toLowerCase())) continue;
    entries.push({
      kind: 'purchase',
      splitter: to_,
      from: log.args.from,
      currency,
      amount: value,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    });
  }

  for (const log of distributions) {
    const token = log.args.token;
    const sellerAmount = log.args.sellerAmount;
    const treasuryAmount = log.args.treasuryAmount;
    const currency = token ? byAddress.get(token.toLowerCase()) : undefined;
    if (!currency || sellerAmount === undefined || treasuryAmount === undefined) continue;
    entries.push({
      kind: 'payout',
      splitter: log.address,
      currency,
      amount: sellerAmount + treasuryAmount,
      sellerAmount,
      treasuryAmount,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    });
  }
  return entries;
}

export interface LoadHistoryOptions {
  splitters: Address[];
  currencies: Currency[];
  fromBlock: bigint;
  chunkBlocks: bigint;
  maxChunks: number;
  /** Cap on rows kept, applied after sorting. Keeps a long-lived marketplace bounded. */
  limit: number;
}

/**
 * Sweep the configured window for purchases and payouts.
 *
 * Mirrors `readClaims` in agents.ts: chunked, ceiling-bounded, and degrading to `partial`
 * rather than throwing — an incomplete history is worth showing, a crashed dashboard is not.
 */
export async function loadHistory(
  client: PublicClient,
  options: LoadHistoryOptions,
): Promise<SweepResult> {
  const { splitters, currencies, fromBlock, chunkBlocks, maxChunks, limit } = options;
  const head = await client.getBlockNumber();
  if (splitters.length === 0) return { history: EMPTY_HISTORY, head, interrupted: false };

  const query = rangeQuery(splitters, currencies);
  const entries: HistoryEntry[] = [];
  // Spend the chunk budget on the newest blocks, not the oldest — see `sweepStart`.
  const { start, truncated } = sweepStart(head, fromBlock, chunkBlocks, maxChunks);
  let partial = truncated;
  let interrupted = false;

  // **Backward, from head**, in parallel groups. Not a style preference: the reasons a chunk
  // fails all live at the old end of the range. Public nodes prune logs (publicnode answers
  // `pruned history unavailable: … earliest available 46000000`), and a forward sweep meets that
  // wall on its FIRST request and aborts having read nothing — which is how this page rendered an
  // empty map and blamed the chunk size. Going backward, the newest data is already collected by
  // the time the wall is reached, and hitting it simply bounds how far back the view goes.
  const { ranges, exhausted } = chunkRangesNewestFirst(head, start, chunkBlocks, maxChunks);
  if (exhausted) partial = true;

  for (let i = 0; i < ranges.length; i += LOG_SWEEP_CONCURRENCY) {
    const group = ranges.slice(i, i + LOG_SWEEP_CONCURRENCY);
    const settledGroup = await Promise.all(
      group.map(([from, to]) =>
        readRange(client, query, from, to).then(
          (found) => ({ ok: true as const, found }),
          (err: unknown) => ({ ok: false as const, err, from, to }),
        ),
      ),
    );

    let stop = false;
    for (const result of settledGroup) {
      if (!result.ok) {
        // The node's own message is the diagnosis: an over-wide chunk names its exact ceiling, a
        // pruned node names its earliest retained block. Swallowing it left the banner's generic
        // advice as the only signal, which is how an invalid chunk size went unnoticed.
        console.warn(
          `[history] log sweep stopped at blocks ${result.from}-${result.to}: ` +
            (result.err instanceof Error ? result.err.message : String(result.err)),
        );
        partial = true;
        interrupted = true;
        stop = true;
        continue;
      }
      entries.push(...result.found);
    }
    if (stop) break;
  }

  return {
    history: { entries: sortNewestFirst(entries).slice(0, limit), partial },
    head,
    interrupted,
  };
}

/**
 * Blocks re-read behind the last head on every incremental read. A load-balanced node can answer
 * `eth_blockNumber` from a node that is a block or two ahead of the one serving `eth_getLogs`, and
 * a log missed that way would never be read again. Overlapping rows are merged by key.
 */
const OVERLAP_BLOCKS = 12n;

/**
 * Purchases and payouts since `throughBlock` — two `getLogs`, cheap enough for every tick.
 *
 * Undefined when the gap is wider than one chunk (a tab left hidden for days): the caller sweeps
 * the window again instead. Throws on a node error, so the caller keeps its cursor and retries the
 * same range on the next tick.
 */
export async function readHistorySince(
  client: PublicClient,
  throughBlock: bigint,
  options: { splitters: Address[]; currencies: Currency[]; chunkBlocks: bigint },
): Promise<{ entries: HistoryEntry[]; head: bigint } | undefined> {
  const head = await client.getBlockNumber();
  if (head - throughBlock > options.chunkBlocks) return undefined;
  if (head <= throughBlock || options.splitters.length === 0) return { entries: [], head };
  const from = throughBlock > OVERLAP_BLOCKS ? throughBlock - OVERLAP_BLOCKS + 1n : 0n;
  const query = rangeQuery(options.splitters, options.currencies);
  return { entries: await readRange(client, query, from, head), head };
}

/**
 * Fold newly read rows into `previous`, keeping the newest `limit`. Returns `previous` itself when
 * nothing is new, so an idle tick re-renders nothing.
 */
export function mergeHistory(previous: History, fresh: HistoryEntry[], limit: number): History {
  const known = new Set(previous.entries.map(entryKey));
  const added = fresh.filter((e) => !known.has(entryKey(e)));
  if (added.length === 0) return previous;
  return {
    entries: sortNewestFirst([...added, ...previous.entries]).slice(0, limit),
    partial: previous.partial,
  };
}

/**
 * Block timestamps, cached for the life of the page.
 *
 * A settled block's timestamp never changes, and the table is re-timed after every read over
 * largely the same rows — without this, every refresh would re-fetch every timestamp it
 * already had. Bounded by HISTORY_LIMIT distinct blocks in practice.
 */
const blockTimes = new Map<bigint, number>();

/** Block-time reads per request; see `attachTimestamps`. */
const TIMESTAMP_GROUP = 8;

/**
 * Fill in the timestamps that are already cached, synchronously.
 *
 * `loadHistory` and `readHistorySince` return rows with no timestamp at all, so anything rendered
 * between the read and `attachTimestamps` resolving sees every row as timeless — that window opens
 * on *every* read, not just the first. A consumer filtering by time would empty itself whenever a
 * purchase landed. This costs
 * nothing and closes the window after the first sweep, since a settled block's timestamp is
 * cached for the life of the page.
 */
export function applyCachedTimestamps(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map((e) => ({ ...e, timestamp: blockTimes.get(e.blockNumber) }));
}

/**
 * Fill in wall-clock times for the rows on screen.
 *
 * Runs only over rows that survived the limit and dedupes by block, so a busy block costs
 * one request rather than one per row — and nothing already cached is fetched again.
 * Failure is silent: a row without a time still shows its block number.
 */
export async function attachTimestamps(
  client: PublicClient,
  entries: HistoryEntry[],
): Promise<HistoryEntry[]> {
  const missing = [...new Set(entries.map((e) => e.blockNumber))].filter((b) => !blockTimes.has(b));

  // In small groups, one after another. After the first sweep this is ~100 blocks, and sent at
  // once the transport batches them into one request of ~100 calls — which a public RPC meters
  // call by call and answers with 429s, failing most of them.
  for (let i = 0; i < missing.length; i += TIMESTAMP_GROUP) {
    await Promise.all(
      missing.slice(i, i + TIMESTAMP_GROUP).map(async (blockNumber) => {
        try {
          const block = await client.getBlock({ blockNumber });
          blockTimes.set(blockNumber, Number(block.timestamp) * 1000);
        } catch {
          /* leave undefined; retried on the next read */
        }
      }),
    );
  }

  return entries.map((e) => ({ ...e, timestamp: blockTimes.get(e.blockNumber) }));
}

/**
 * A display-only estimate for a row whose block timestamp has not been fetched yet (or whose
 * fetch failed — a rate-limited `eth_getBlock` is retried only on the next sweep).
 *
 * Extrapolated from the nearest row that does have a time, at the block rate measured across the
 * timed rows themselves, so no per-chain block time is hardcoded. Never use this to filter or
 * sort: the period filter keeps its single exact notion of "when" (see `graph.ts`). Undefined when
 * fewer than two distinct timed blocks exist to measure a rate from.
 */
export function estimateTimestamp(
  blockNumber: bigint,
  entries: HistoryEntry[],
): number | undefined {
  const timed = entries.filter((e) => e.timestamp !== undefined);
  if (timed.length < 2) return undefined;

  let newest = timed[0];
  let oldest = timed[0];
  let nearest = timed[0];
  for (const e of timed) {
    if (e.blockNumber > newest.blockNumber) newest = e;
    if (e.blockNumber < oldest.blockNumber) oldest = e;
    const d = (b: bigint) => (b > blockNumber ? b - blockNumber : blockNumber - b);
    if (d(e.blockNumber) < d(nearest.blockNumber)) nearest = e;
  }
  const blocks = Number(newest.blockNumber - oldest.blockNumber);
  if (blocks <= 0) return undefined;

  const msPerBlock = (newest.timestamp! - oldest.timestamp!) / blocks;
  return nearest.timestamp! + Number(blockNumber - nearest.blockNumber) * msPerBlock;
}
