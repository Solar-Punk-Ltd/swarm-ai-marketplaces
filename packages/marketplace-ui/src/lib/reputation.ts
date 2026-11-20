/**
 * Seller reputation from the marketplace-service indexer (`GET /v1/sellers/:agentId/reputation`).
 *
 * The indexer is a cache over chain events and Swarm content, not an authority — buyer agents
 * verify against the chain before paying. Here it is display only, so a missing or lagging indexer
 * degrades to "no reputation shown", never to an error on the dashboard.
 */

/** The indexer's answer (see packages/marketplace-service/src/reputation.ts). */
export interface SellerReputation {
  agentId: string;
  score: number | null;
  scale: { min: number; max: number; decimals: number };
  count: number; // anchored, non-revoked reviews
  popValidCount: number; // the ones that count: PoP-valid, one per purchase
  pendingCount: number; // not verified yet
  recency: string | null;
  checkpoint: { block: number; lastEvent: { block: number; txHash: string } | null };
  popValidClients: string[];
  responseCount: number;
}

export type ReputationEntry =
  | { state: 'ok'; reputation: SellerReputation }
  /** The indexer is up but has not finished its first pass (503). */
  | { state: 'syncing' }
  | { state: 'unavailable' };

/** Keyed by agent id (decimal string). */
export type ReputationIndex = Map<string, ReputationEntry>;

export const EMPTY_REPUTATIONS: ReputationIndex = new Map();

const TIMEOUT_MS = 10_000;

async function fetchOne(baseUrl: string, agentId: string): Promise<ReputationEntry> {
  try {
    const res = await fetch(`${baseUrl}/v1/sellers/${agentId}/reputation`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 503) return { state: 'syncing' };
    if (!res.ok) return { state: 'unavailable' };
    return { state: 'ok', reputation: (await res.json()) as SellerReputation };
  } catch {
    // Unreachable, CORS-blocked or timed out: nothing to show, nothing to alarm about.
    return { state: 'unavailable' };
  }
}

/**
 * One request per agent against our own service (not the rate-limited RPC). A failed read keeps
 * the previous answer for that agent, so a blip does not make reputations flicker away.
 */
export async function loadReputations(
  baseUrl: string,
  agentIds: string[],
  previous: ReputationIndex,
): Promise<ReputationIndex> {
  const entries = await Promise.all(
    agentIds.map(async (id) => {
      const next = await fetchOne(baseUrl, id);
      const before = previous.get(id);
      return [id, next.state === 'unavailable' && before ? before : next] as const;
    }),
  );
  return new Map(entries);
}

/** `87`, `4.5` — at the marketplace's own precision. */
export function formatScore(score: number, scale: SellerReputation['scale']): string {
  return score.toFixed(Math.max(scale.decimals, Number.isInteger(score) ? 0 : 1));
}
