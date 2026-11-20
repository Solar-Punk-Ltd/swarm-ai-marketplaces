/**
 * Shared plumbing for the buyer review tools: the marketplace-service client, score scaling, and
 * the chain context (buyer wallet, ERC-8004 client, PoP reader). Review logic itself lives in
 * @solarpunk/erc8004-adapter — this file only wires it up.
 */
import {
  createERC8004Client,
  createPoPChainReader,
  type ERC8004Client,
  type PoPChainReader,
  type ReviewMarketplaceConfig,
  type WireEnvelope,
} from '@solarpunk/erc8004-adapter';
import { JsonRpcProvider, Wallet, getAddress } from 'ethers';
import config from './config';
import { MARKETPLACE_TIMEOUT_MS } from './constants';
import { getBuyerStore, type BuyerStore } from './buyer-store';
import { getErrorMessage, getToolErrorResponse, type ToolResponse } from './utils';

/** A failure with a stable code (CLAUDE.md "Review tools spec" error lists). */
export class ReviewToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ReviewToolError';
  }
}

/** GET /v1/reviews/config, typed: this marketplace's terms. */
export interface MarketplaceTerms {
  review: ReviewMarketplaceConfig;
  score: { min: number; max: number; decimals: number };
  maxChunksPerRequest: number;
  maxEnvelopesPerPurchase: number;
  requestMaxAgeSeconds: number;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export interface EnvelopeRequestBody {
  agentId: string;
  proofOfPayment: unknown;
  chunkAddresses: string[];
  timestamp: number;
  signature: string;
}

export type EnvelopeResult =
  | { ok: true; batchId: string; envelopes: WireEnvelope[] }
  | { ok: false; status: number; error: ApiErrorBody };

export interface MarketplaceApi {
  getTerms(): Promise<MarketplaceTerms>;
  requestEnvelopes(body: EnvelopeRequestBody): Promise<EnvelopeResult>;
  /** The indexer's answer, or null when the marketplace runs no indexer (404). */
  getSellerReputation(agentId: string): Promise<Record<string, unknown> | null>;
}

export function marketplaceApi(baseUrl: string): MarketplaceApi {
  const base = baseUrl.replace(/\/+$/, '');
  const get = (path: string) =>
    fetch(`${base}${path}`, { signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS) });

  return {
    async getTerms() {
      const res = await get('/v1/reviews/config');
      if (!res.ok) throw new Error(`GET /v1/reviews/config → ${res.status}: ${await res.text()}`);
      return parseTerms(await res.json());
    },

    async requestEnvelopes(body) {
      const res = await fetch(`${base}/v1/reviews/envelopes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        return {
          ok: true,
          batchId: json.batchId as string,
          envelopes: json.envelopes as WireEnvelope[],
        };
      }
      return {
        ok: false,
        status: res.status,
        error: {
          error: typeof json.error === 'string' ? json.error : 'http_error',
          message: typeof json.message === 'string' ? json.message : `HTTP ${res.status}`,
          details: json.details as Record<string, unknown> | undefined,
          retryable: json.retryable as boolean | undefined,
        },
      };
    },

    async getSellerReputation(agentId) {
      const res = await get(`/v1/sellers/${agentId}/reputation`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET reputation → ${res.status}: ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    },
  };
}

export function parseTerms(json: unknown): MarketplaceTerms {
  const j = json as Record<string, unknown>;
  const terms = j.splitterTerms as { treasury: string; taxBps: number }[];
  const floor = j.valueFloor as { asset: string; amount: string }[];
  return {
    review: {
      chainId: BigInt(j.chainId as string),
      identityRegistry: getAddress(j.identityRegistry as string),
      reputationRegistry: getAddress(j.reputationRegistry as string),
      splitterFactory: getAddress(j.splitterFactory as string),
      splitterTerms: terms.map((t) => ({ treasury: getAddress(t.treasury), taxBps: t.taxBps })),
      acceptedAssets: (j.acceptedAssets as string[]).map((a) => getAddress(a)),
      valueFloor: floor.map((f) => ({ asset: getAddress(f.asset), amount: BigInt(f.amount) })),
    },
    score: j.score as MarketplaceTerms['score'],
    maxChunksPerRequest: j.maxChunksPerRequest as number,
    maxEnvelopesPerPurchase: j.maxEnvelopesPerPurchase as number,
    requestMaxAgeSeconds: j.requestMaxAgeSeconds as number,
  };
}

/**
 * Decimal score → fixed-point `value` at the marketplace's decimals. Rejects values outside the
 * marketplace's range (in score units) and values with more precision than it allows.
 */
export function toFixedPointScore(score: number, scale: MarketplaceTerms['score']): bigint {
  if (!Number.isFinite(score) || score < scale.min || score > scale.max) {
    throw new ReviewToolError(
      'score_out_of_range',
      `Score must be between ${scale.min} and ${scale.max}`,
      { scale },
    );
  }
  const factor = 10 ** scale.decimals;
  const fixed = Math.round(score * factor);
  if (Math.abs(fixed / factor - score) > 1e-9) {
    throw new ReviewToolError(
      'score_out_of_range',
      `Score allows at most ${scale.decimals} decimal place(s)`,
      { scale },
    );
  }
  return BigInt(fixed);
}

export interface ReadChain {
  provider: JsonRpcProvider;
  erc8004: ERC8004Client;
  reader: PoPChainReader;
}

export interface ReviewChain extends ReadChain {
  wallet: Wallet; // the buyer: paid, signs the review feed, sends giveFeedback
}

/** Read-only chain access for one marketplace, using the registries the marketplace reports. */
export function readChain(
  terms: MarketplaceTerms,
  signer?: (p: JsonRpcProvider) => Wallet,
): ReadChain & { wallet?: Wallet } {
  const chainId = Number(terms.review.chainId);
  const provider = new JsonRpcProvider(config.chain.rpcUrl, chainId, { staticNetwork: true });
  const archiveProvider = config.review.archiveRpcUrl
    ? new JsonRpcProvider(config.review.archiveRpcUrl, chainId, { staticNetwork: true })
    : undefined;
  const wallet = signer?.(provider);
  const erc8004 = createERC8004Client({
    provider,
    signer: wallet,
    chain: config.chain.chain,
    contracts: {
      identityRegistry: terms.review.identityRegistry,
      reputationRegistry: terms.review.reputationRegistry,
    },
  });
  const reader = createPoPChainReader({
    provider,
    archiveProvider,
    identityRegistry: terms.review.identityRegistry,
  });
  return { provider, erc8004, reader, wallet };
}

/** Chain access signing as the buyer (BUYER_WALLET_PK). */
export function reviewChain(terms: MarketplaceTerms): ReviewChain {
  const walletPk = config.payment.walletPrivateKey;
  if (!walletPk) {
    throw new ReviewToolError(
      'wallet_missing',
      'BUYER_WALLET_PK is not set (the buyer signs reviews).',
    );
  }
  const key = walletPk.startsWith('0x') ? walletPk : `0x${walletPk}`;
  const chain = readChain(terms, (provider) => new Wallet(key, provider));
  return { ...chain, wallet: chain.wallet as Wallet };
}

export function resolveMarketplace(url?: string): MarketplaceApi {
  const base = url || config.review.marketplaceServiceUrl;
  if (!base) {
    throw new ReviewToolError(
      'marketplace_missing',
      'Missing marketplace service: pass marketplaceServiceUrl or set MARKETPLACE_SERVICE_URL.',
    );
  }
  return marketplaceApi(base);
}

export function buyerStore(): BuyerStore {
  return getBuyerStore(config.review.buyerDbPath);
}

export async function loadTerms(api: MarketplaceApi): Promise<MarketplaceTerms> {
  try {
    return await api.getTerms();
  } catch (err) {
    throw new ReviewToolError(
      'marketplace_unavailable',
      `Could not load the marketplace's review config: ${getErrorMessage(err)}`,
    );
  }
}

/** ethers marks a funding failure with code INSUFFICIENT_FUNDS. */
export function isInsufficientFunds(err: unknown): boolean {
  return (err as { code?: string })?.code === 'INSUFFICIENT_FUNDS';
}

/** MCP error response; review failures carry their stable code first. */
export function toolError(err: unknown): ToolResponse {
  if (err instanceof ReviewToolError) {
    const details = err.details ? ` ${JSON.stringify(err.details)}` : '';
    return getToolErrorResponse(`${err.code}: ${err.message}${details}`);
  }
  return getToolErrorResponse(getErrorMessage(err));
}
