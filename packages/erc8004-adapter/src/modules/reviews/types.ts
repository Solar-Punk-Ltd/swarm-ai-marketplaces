import type { Eip712Domain, PurchaseIntentMessage } from '@solarpunk/swarm-catalog';

/** The EIP-712 PurchaseIntent exactly as the buyer signed it at purchase time. */
export interface PurchaseIntentProof {
  domain: Eip712Domain;
  message: PurchaseIntentMessage;
  signature: string;
}

/**
 * ERC-8004 `proofOfPayment` (fromAddress, toAddress, chainId, txHash) plus our mandatory
 * `purchaseIntent`, which binds the review to one item.
 */
export interface ProofOfPayment {
  fromAddress: string;
  toAddress: string; // the seller's splitter clone
  chainId: string;
  txHash: string; // settlement tx
  purchaseIntent: PurchaseIntentProof;
}

/**
 * The review file on Swarm: the ERC-8004 off-chain feedback file plus our extensions
 * (`comment`, `salt`, `proofOfPayment.purchaseIntent`). `feedbackHash` commits to its canonical
 * serialization.
 */
export interface ReviewDocument {
  agentRegistry: string; // CAIP-10 of the IdentityRegistry
  agentId: number;
  clientAddress: string; // CAIP-10 of the reviewer
  createdAt: string; // ISO-8601
  value: number;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  comment?: string;
  // Fresh 32 random bytes. Without it the marketplace could brute-force `value` from the chunk
  // addresses it sees before issuing envelopes.
  salt: string;
  proofOfPayment: ProofOfPayment;
}

/** One marketplace's terms. Comes from config — never hardcode (the repo is a framework). */
export interface ReviewMarketplaceConfig {
  chainId: bigint;
  identityRegistry: string;
  reputationRegistry: string;
  splitterFactory: string;
  /** Clone terms this marketplace accepts. A splitter with other terms earns no PoP. */
  splitterTerms: { treasury: string; taxBps: number }[];
  /** ERC-20 token addresses accepted as payment. */
  acceptedAssets: string[];
  /** Minimum settled amount per token, in base units. Tokens without an entry have no floor. */
  valueFloor: { asset: string; amount: bigint }[];
}

export type PoPFailureReason =
  | 'chain_mismatch'
  | 'pop_fields_mismatch'
  | 'tx_not_found'
  | 'tx_failed'
  | 'no_transfer_to_splitter'
  | 'wrong_payer'
  | 'splitter_unlinked'
  | 'splitter_not_factory_clone'
  | 'splitter_terms_mismatch'
  | 'asset_not_accepted'
  | 'below_value_floor'
  | 'intent_bad_signature'
  | 'intent_not_in_tx'
  | 'intent_payment_mismatch';

export interface PoPSuccess {
  valid: true;
  splitter: string;
  seller: string;
  token: string;
  amount: bigint;
  settlementBlock: number;
  settlementLogIndex: number;
  itemId: string;
}

export type PoPResult = PoPSuccess | { valid: false; reason: PoPFailureReason };

export type ReviewFailureReason =
  | 'uri_malformed'
  | 'uri_owner_mismatch'
  | 'topic_mismatch'
  | 'soc_unavailable'
  | 'payload_malformed'
  | 'content_unavailable'
  | 'hash_mismatch'
  | 'json_malformed'
  | 'field_mismatch';

export type ReviewVerification =
  | { valid: true; review: ReviewDocument; reference: string }
  | { valid: false; reason: ReviewFailureReason; detail?: string };

export interface FeedCoordinates {
  owner: string; // checksummed 0x address
  topic: string; // 0x-prefixed 32-byte hex
  index: bigint;
}

/** One chunk ready for upload: its Swarm address and the bytes to POST. */
export interface PreparedChunk {
  address: string; // 64-hex, no 0x (Bee's format)
  data: Uint8Array;
}

export interface EnvelopeRequest {
  agentId: bigint;
  txHash: string;
  chunkAddresses: string[]; // 0x-prefixed 32-byte hex
  timestamp: bigint; // unix seconds
}
