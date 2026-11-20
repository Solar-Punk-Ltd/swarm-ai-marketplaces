import 'dotenv/config';
import { getAddress, isAddress } from 'ethers';

// Everything marketplace-specific comes from here — the repo is a framework for many
// marketplaces, so no marketplace value is hardcoded in the service logic.
export interface ServiceConfig {
  port: number;
  network: string; // CAIP-2, e.g. "eip155:84532"
  chainId: bigint;
  rpcUrl: string;
  // Archive node for state at past blocks (PoP rule 2's historical link read). Optional when
  // rpcUrl already serves archive state.
  archiveRpcUrl?: string;
  erc8004Chain: string; // adapter chain name for registry defaults, e.g. "base-sepolia"
  identityRegistry?: string; // overrides the adapter default
  reputationRegistry?: string; // overrides the adapter default
  splitterFactory: string;
  // Accepted clone terms. Unset → the factory's current treasury + defaultTaxBps, read at startup.
  splitterTerms?: { treasury: string; taxBps: number }[];
  acceptedAssets: string[];
  valueFloor: { asset: string; amount: bigint }[];
  score: { min: number; max: number; decimals: number };
  maxChunksPerRequest: number;
  maxEnvelopesPerPurchase: number;
  requestMaxAgeSeconds: number;
  logRangeMax: number;
  beeApiUrl: string;
  // Per-seller review batch, bought on the seller's first review.
  reviewBatch: { sizeMb: number; ttlDays: number; retryAfterSeconds: number };
  dbPath: string;
  // Origins allowed to read the GET endpoints from a browser; ['*'] = any (the data is public).
  corsAllowedOrigins: string[];
  indexer: {
    enabled: boolean;
    // First block to ingest. For a complete census use the ReputationRegistry deploy block.
    // Unset → head − RECENT_BLOCK_COUNT on first start (older reviews are then not indexed).
    startBlock?: number;
    confirmations: number;
    maxBlocksPerTick: number;
    verifyBatch: number;
    maxAttempts: number;
    pollSeconds: number;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function address(name: string, value: string): string {
  if (!isAddress(value)) throw new Error(`${name}: not an address: "${value}"`);
  return getAddress(value);
}

// CAIP-2 "eip155:84532" → 84532n
export function parseChainId(caip2: string): bigint {
  const match = /^eip155:([1-9][0-9]*)$/.exec(caip2);
  if (!match) throw new Error(`Invalid CAIP-2 network identifier: ${caip2}`);
  return BigInt(match[1]);
}

// "0xTreasury:500,0xOther:300"
export function parseSplitterTerms(raw: string): { treasury: string; taxBps: number }[] {
  return list(raw).map((entry) => {
    const [treasury, bps] = entry.split(':');
    const taxBps = Number(bps);
    if (!Number.isInteger(taxBps) || taxBps < 0 || taxBps > 10_000) {
      throw new Error(`SPLITTER_TERMS: bad taxBps in "${entry}"`);
    }
    return { treasury: address('SPLITTER_TERMS', treasury), taxBps };
  });
}

// "0xToken:1000,0xOther:5" — amounts in token base units
export function parseValueFloor(raw: string): { asset: string; amount: bigint }[] {
  return list(raw).map((entry) => {
    const [asset, amount] = entry.split(':');
    if (!/^[0-9]+$/.test(amount ?? '')) throw new Error(`VALUE_FLOOR: bad amount in "${entry}"`);
    return { asset: address('VALUE_FLOOR', asset), amount: BigInt(amount) };
  });
}

function list(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): ServiceConfig {
  const network = process.env.NETWORK ?? 'eip155:84532';
  const maxChunksPerRequest = int('MAX_CHUNKS_PER_REQUEST', 16);
  const score = {
    min: int('SCORE_MIN', 0),
    max: int('SCORE_MAX', 100),
    decimals: int('SCORE_DECIMALS', 0),
  };
  if (score.min > score.max) throw new Error('SCORE_MIN must not exceed SCORE_MAX');
  if (score.decimals > 18) throw new Error('SCORE_DECIMALS must be 0–18 (registry limit)');

  const acceptedAssets = list(required('ACCEPTED_ASSETS')).map((a) =>
    address('ACCEPTED_ASSETS', a),
  );

  return {
    port: int('PORT', 3100),
    network,
    chainId: parseChainId(network),
    rpcUrl: process.env.RPC_URL ?? 'https://sepolia.base.org',
    archiveRpcUrl: process.env.ARCHIVE_RPC_URL || undefined,
    erc8004Chain: process.env.ERC8004_CHAIN ?? 'base-sepolia',
    identityRegistry: process.env.IDENTITY_REGISTRY
      ? address('IDENTITY_REGISTRY', process.env.IDENTITY_REGISTRY)
      : undefined,
    reputationRegistry: process.env.REPUTATION_REGISTRY
      ? address('REPUTATION_REGISTRY', process.env.REPUTATION_REGISTRY)
      : undefined,
    splitterFactory: address('SPLITTER_FACTORY_ADDRESS', required('SPLITTER_FACTORY_ADDRESS')),
    splitterTerms: process.env.SPLITTER_TERMS
      ? parseSplitterTerms(process.env.SPLITTER_TERMS)
      : undefined,
    acceptedAssets,
    valueFloor: process.env.VALUE_FLOOR ? parseValueFloor(process.env.VALUE_FLOOR) : [],
    score,
    maxChunksPerRequest,
    maxEnvelopesPerPurchase: int('MAX_ENVELOPES_PER_PURCHASE', 4 * maxChunksPerRequest),
    requestMaxAgeSeconds: int('REQUEST_MAX_AGE_SECONDS', 300),
    logRangeMax: int('LOG_RANGE_MAX', 200),
    beeApiUrl: process.env.BEE_API_URL ?? 'http://localhost:1633',
    reviewBatch: {
      sizeMb: int('REVIEW_BATCH_SIZE_MB', 1),
      ttlDays: int('REVIEW_BATCH_TTL_DAYS', 30),
      retryAfterSeconds: int('BATCH_RETRY_AFTER_SECONDS', 60),
    },
    dbPath: process.env.DB_PATH ?? './data/marketplace.db',
    corsAllowedOrigins: list(process.env.CORS_ALLOWED_ORIGINS ?? '*'),
    indexer: {
      enabled: (process.env.INDEXER_ENABLED ?? 'true') !== 'false',
      startBlock: process.env.INDEXER_START_BLOCK ? int('INDEXER_START_BLOCK', 0) : undefined,
      confirmations: int('INDEXER_CONFIRMATIONS', 5),
      maxBlocksPerTick: int('INDEXER_MAX_BLOCKS_PER_TICK', 10 * int('LOG_RANGE_MAX', 200)),
      verifyBatch: int('INDEXER_VERIFY_BATCH', 20),
      maxAttempts: int('INDEXER_MAX_ATTEMPTS', 5),
      pollSeconds: int('INDEXER_POLL_SECONDS', 15),
    },
  };
}
