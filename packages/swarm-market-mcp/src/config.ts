import dotenv from 'dotenv';
import {
  DEFAULT_BEE_API_URL,
  DEFAULT_BUYER_DB_PATH,
  DEFAULT_CHAIN,
  DEFAULT_LOG_RANGE_MAX,
  DEFAULT_RPC_URL,
} from './constants';

dotenv.config({ quiet: true });

function normalizeHexKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.startsWith('0x') ? key : `0x${key}`;
}

export interface BeeConfig {
  endpoint: string;
  // Catalog feed signer (cold key).
  catalogFeedPrivateKey?: string;
  // Per-item state feed signer (hot key) — must differ from catalogFeedPrivateKey.
  itemStateFeedPrivateKey?: string;
  postageBatchId?: string;
}

// ERC-8004 access. rpcUrl + chain are used read-only by get_agent; walletPrivateKey is
// required by register_agent to sign the NFT mint transaction.
export interface ChainConfig {
  rpcUrl: string;
  chain: string;
  walletPrivateKey?: string;
}

// Buyer-side settlement config for purchase_catalog_item. The wallet key signs the
// EIP-712 PurchaseIntent + ERC-3009 authorization; rpcUrl reads the token EIP-712 domain.
export interface PaymentConfig {
  walletPrivateKey?: string;
  rpcUrl?: string;
  // Fallback x402 base endpoint when a purchase call omits x402Endpoint (the seller's
  // Agent Card is the primary source).
  x402Endpoint?: string;
}

// Per-seller revenue splitter (@solarpunk/contracts). When both values are set, build_catalog
// resolves payment[].payTo to this seller's splitter clone, so listings settle through the taxed
// path that earns Proof-of-Purchase. Unset = legacy behaviour: payTo must be supplied explicitly.
export interface SplitterConfig {
  factoryAddress?: string;
  sellerAddress?: string;
  // Key of sellerAddress, when available: lets register_agent sign the consent that registers the
  // seller as the agent wallet (needed whenever the seller is not the NFT owner).
  sellerPrivateKey?: string;
}

// Buyer-side reviews (submit_review / revoke_review / get_seller_reputation / list_purchases).
// Signed with payment.walletPrivateKey — the buyer key that paid is the only key that can review.
export interface ReviewConfig {
  // Local SQLite store of purchases (incl. the signed PurchaseIntent) and their review state.
  buyerDbPath: string;
  // The marketplace's backend: GET /v1/reviews/config, envelopes, (later) the indexer.
  marketplaceServiceUrl?: string;
  // Archive node for PoP checks that read past state; falls back to chain.rpcUrl.
  archiveRpcUrl?: string;
  // eth_getLogs page size — keep within the RPC provider's block-range cap.
  logRangeMax: number;
}

export interface Config {
  bee: BeeConfig;
  chain: ChainConfig;
  payment: PaymentConfig;
  splitter: SplitterConfig;
  review: ReviewConfig;
}

const config: Config = {
  bee: {
    endpoint: process.env.BEE_API_URL || DEFAULT_BEE_API_URL,
    catalogFeedPrivateKey: normalizeHexKey(process.env.BEE_FEED_PK),
    itemStateFeedPrivateKey: normalizeHexKey(process.env.ITEM_STATE_FEED_PK),
    postageBatchId: process.env.POSTAGE_BATCH_ID,
  },
  chain: {
    rpcUrl: process.env.RPC_URL || DEFAULT_RPC_URL,
    chain: process.env.ERC8004_CHAIN || DEFAULT_CHAIN,
    walletPrivateKey: normalizeHexKey(process.env.PRIVATE_KEY),
  },
  payment: {
    walletPrivateKey: process.env.BUYER_WALLET_PK,
    rpcUrl: process.env.PAYMENT_RPC_URL,
    x402Endpoint: process.env.X402_ENDPOINT,
  },
  splitter: {
    factoryAddress: process.env.SPLITTER_FACTORY_ADDRESS,
    sellerAddress: process.env.AGENT_PAYMENT_ADDRESS,
    sellerPrivateKey: normalizeHexKey(process.env.AGENT_PAYMENT_PK),
  },
  review: {
    buyerDbPath: process.env.BUYER_DB_PATH || DEFAULT_BUYER_DB_PATH,
    marketplaceServiceUrl: process.env.MARKETPLACE_SERVICE_URL,
    archiveRpcUrl: process.env.ARCHIVE_RPC_URL,
    logRangeMax: Number(process.env.LOG_RANGE_MAX || DEFAULT_LOG_RANGE_MAX),
  },
};

export default config;
