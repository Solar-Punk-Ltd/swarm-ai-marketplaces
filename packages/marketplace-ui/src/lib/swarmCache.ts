/**
 * How often a Swarm read is repeated — Agent Cards and catalogs alike.
 *
 * What these hold changes rarely (a seller renames itself, republishes its catalog), so a found
 * value is kept for `freshMs` before it is read again. A miss is different: a cold feed or a busy
 * gateway often answers on a second try, so it is retried every `retryMs`, `maxRetries` times, and
 * then left alone for a full `freshMs` before the cycle starts over — a catalog published after
 * the page loaded still turns up, without a dead one being asked for every few seconds forever.
 *
 * Nothing here runs on a timer of its own. `refresh` is called from the context's tick, which only
 * fetches what is due, so retries pause with the tick when the tab is hidden and no row ever
 * polls by itself.
 */

export interface SwarmCachePolicy {
  freshMs: number;
  retryMs: number;
  maxRetries: number;
}

export const SWARM_READ_POLICY: SwarmCachePolicy = {
  freshMs: 5 * 60_000,
  retryMs: 10_000,
  maxRetries: 3,
};

interface Entry<T> {
  /** Last value read. Kept through failed refreshes: an older card beats no card. */
  value?: T;
  /**
   * When the last attempt started. Timed from the start, not the end, so a gateway that takes 8s
   * to fail does not stretch a 10s retry into 18s.
   */
  checkedAt: number;
  /** Consecutive misses: the first attempt, then each retry. Zero after a hit. */
  misses: number;
  inFlight?: Promise<boolean>;
}

export class SwarmCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  private readonly isHit: (value: T) => boolean;
  private readonly same: (a: T, b: T) => boolean;
  private readonly policy: SwarmCachePolicy;

  constructor(
    options: {
      /**
       * Whether a value counts as found. A catalog whose feed resolves but whose document 404s is
       * worth showing ("Catalog unavailable") and still worth retrying, so it is kept but not a hit.
       */
      isHit?: (value: T) => boolean;
      /** Whether a re-read brought nothing new, so the page is not re-rendered for it. */
      same?: (a: T, b: T) => boolean;
      policy?: SwarmCachePolicy;
    } = {},
  ) {
    this.isHit = options.isHit ?? (() => true);
    this.same = options.same ?? ((a, b) => a === b);
    this.policy = options.policy ?? SWARM_READ_POLICY;
  }

  /** What is known now, without fetching. */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  private due(entry: Entry<T> | undefined, now: number): boolean {
    if (!entry) return true;
    const { freshMs, retryMs, maxRetries } = this.policy;
    const wait = entry.misses > 0 && entry.misses <= maxRetries ? retryMs : freshMs;
    return now - entry.checkedAt >= wait;
  }

  /**
   * Read `key` again if it is due, and resolve to whether its value changed. A call that finds the
   * key already in flight waits for that read instead of starting a second one.
   */
  refresh(key: string, load: () => Promise<T | undefined>): Promise<boolean> {
    const entry = this.entries.get(key);
    if (entry?.inFlight) return entry.inFlight.then(() => false);
    if (!this.due(entry, Date.now())) return Promise.resolve(false);

    const current: Entry<T> = entry ?? { checkedAt: 0, misses: 0 };
    current.checkedAt = Date.now();
    this.entries.set(key, current);
    const inFlight = load().then(
      (value) => {
        const hit = value !== undefined && this.isHit(value);
        current.misses = hit ? 0 : current.misses + 1;
        current.inFlight = undefined;
        if (value === undefined) return false;
        if (current.value !== undefined && this.same(current.value, value)) return false;
        current.value = value;
        return true;
      },
      () => {
        current.misses += 1;
        current.inFlight = undefined;
        return false;
      },
    );
    current.inFlight = inFlight;
    return inFlight;
  }
}
