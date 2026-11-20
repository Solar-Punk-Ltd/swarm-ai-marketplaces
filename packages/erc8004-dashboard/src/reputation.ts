/**
 * Agent reputation from the marketplace-service indexer (`GET /v1/sellers/:agentId/reputation`).
 *
 * The indexer is a cache, not an authority — buyer agents re-verify against the chain before they
 * pay. Here it is display only, so any failure (no URL, unreachable, CORS) just shows nothing.
 */
import { MARKETPLACE_SERVICE_URL } from './constants';

export interface Reputation {
  score: number | null;
  scale: { min: number; max: number; decimals: number };
  count: number; // anchored, non-revoked reviews
  popValidCount: number; // the ones that count (PoP-valid, one per purchase)
  pendingCount: number;
  recency: string | null;
}

/** `undefined` while loading or when unavailable; `'syncing'` while the indexer's first pass runs. */
export type ReputationState = Reputation | 'syncing' | undefined;

export async function fetchReputation(agentId: string): Promise<ReputationState> {
  if (!MARKETPLACE_SERVICE_URL) return undefined;
  try {
    const res = await fetch(`${MARKETPLACE_SERVICE_URL}/v1/sellers/${agentId}/reputation`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 503) return 'syncing';
    if (!res.ok) return undefined;
    return (await res.json()) as Reputation;
  } catch {
    return undefined;
  }
}

export function formatScore(score: number, scale: Reputation['scale']): string {
  return score.toFixed(Math.max(scale.decimals, Number.isInteger(score) ? 0 : 1));
}
