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

/** One review behind the score (see marketplace-service `SellerReview`). */
export interface SellerReview {
  feedbackIndex: string;
  clientAddress: string;
  value: number; // on the marketplace scale
  /** counted — in the score; pending — not verified yet; not_counted — `reason` says why. */
  status: 'counted' | 'pending' | 'not_counted';
  reason: string | null;
  comment: string | null; // third-party text: render as text, never as HTML
  reviewedAt: string | null;
  anchorTx: string; // the giveFeedback transaction: the on-chain proof
  anchorBlock: number;
  purchaseTx: string | null;
  itemId: string | null;
  feedbackURI: string;
  feedbackHash: string;
}

/**
 * The reviews of one seller, newest first (`GET /v1/sellers/:agentId/reviews`). Fetched on demand
 * when a reader opens them, like a catalog document — not part of the context's polling. Throws on
 * any failure; the caller says so and offers a retry.
 */
export async function fetchSellerReviews(
  baseUrl: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<SellerReview[]> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${baseUrl}/v1/sellers/${agentId}/reviews`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 503) throw new Error('The reputation indexer is still catching up.');
  if (!res.ok) throw new Error(`The marketplace service answered ${res.status}.`);
  const body = (await res.json()) as { reviews: SellerReview[] };
  return body.reviews;
}
