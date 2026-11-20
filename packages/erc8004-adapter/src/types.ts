import type { Signer, Provider } from 'ethers';

export interface ERC8004Config {
  provider: Provider;
  signer?: Signer;
  chain: 'base-sepolia' | 'base' | 'mainnet' | (string & {});
  contracts?: {
    identityRegistry?: string;
    reputationRegistry?: string;
  };
}

export interface MetadataEntry {
  metadataKey: string;
  metadataValue: Uint8Array;
}

export interface AgentService {
  name: string; // e.g. "MCP", "Swarm", "web", "email"
  endpoint: string; // The service endpoint URL or identifier
  version?: string; // SHOULD - e.g. "0.3.0", "2025-06-18"
  skills?: string[]; // OPTIONAL
  domains?: string[]; // OPTIONAL
}

export interface AgentRegistration {
  agentId: bigint;
  agentRegistry: string; // e.g. "eip155:1:0x742d35Cc6634C0532925a3b844Bc9e7595f42e99"
}

export interface AgentCard {
  type: string; // MUST be "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"
  name: string;
  description: string;
  version: string;
  image?: string; // OPTIONAL - e.g. "https://example.com/agentimage.png"
  services: AgentService[];
  x402Support: boolean;
  active: boolean;
  registrations?: AgentRegistration[];
  supportedTrust?: string[]; // OPTIONAL - e.g. ["reputation", "crypto-economic"]
  capabilities?: string[];
}

export type AgentCardParams = Omit<AgentCard, 'type' | 'x402Support' | 'active'> & {
  type?: string;
  x402Support?: boolean;
  active?: boolean;
};

export interface RegisterResult {
  agentId: bigint;
  txHash: string;
}

export interface PostFeedbackParams {
  agentId: bigint;
  // Fixed-point score: `value / 10^valueDecimals`. The registry fixes no range — the marketplace
  // configures one, so it is not clamped here.
  value: bigint;
  valueDecimals: number; // 0–18 (registry limit)
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI: string; // e.g. swarm-feed://<owner>/<topic>/<index>
  feedbackHash: string; // keccak256 of the content feedbackURI resolves to — never of the URI itself
}

export interface PostFeedbackResult {
  txHash: string;
  feedbackIndex: bigint; // from the NewFeedback event
  blockNumber: number;
}

// Off-chain authorization: new wallet signs this to consent to being registered as the agent wallet.
export interface WalletAuth {
  agentId: bigint;
  wallet: string; // the wallet being registered
  owner: string; // agent NFT owner the consent is bound to
  deadline: number; // unix timestamp, at most 5 minutes ahead (registry limit)
  signature: string; // EIP-712 AgentWalletSet signature from `wallet`
}

export interface FeedbackResult {
  value: bigint;
  valueDecimals: number;
  score: number; // value / 10^valueDecimals, on whatever scale the marketplace uses
  tag1: string;
  tag2: string;
  isRevoked: boolean;
}

export interface FeedbackEntry extends FeedbackResult {
  clientAddress: string;
  feedbackIndex: bigint;
}

export interface ReputationSummary {
  count: bigint;
  averageScore: number; // the registry's average, as a decimal number
  rawValue: bigint; // the registry's average, fixed-point
  rawDecimals: number;
}

export interface ReputationScore {
  agentId: bigint;
  score: number; // average on the marketplace's scale
  feedbackCount: bigint;
  reliable: boolean; // score >= minScore and count >= minCount
}

// Paging for event scans. `fromBlock` is required: an open-ended default would silently return a
// partial view.
export interface LogQueryOptions {
  fromBlock: number;
  toBlock?: number; // default: latest
  chunkSize?: number; // default: DEFAULT_LOG_RANGE_MAX
}

interface FeedbackLogMeta {
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface NewFeedbackEvent extends FeedbackLogMeta {
  agentId: bigint;
  clientAddress: string;
  feedbackIndex: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}

export interface FeedbackRevokedEvent extends FeedbackLogMeta {
  agentId: bigint;
  clientAddress: string;
  feedbackIndex: bigint;
}

export interface ResponseAppendedEvent extends FeedbackLogMeta {
  agentId: bigint;
  clientAddress: string;
  feedbackIndex: bigint;
  responder: string;
  responseURI: string;
  responseHash: string;
}

export interface SwarmUploadResult {
  /** 64-char hex content hash of the uploaded payload */
  reference: string;
  /** bzz://<reference> — direct immutable link to this version of the card */
  url: string;
  /** Bee API feed URL — resolves to the latest card version via owner + topic */
  feedUrl: string;
}
