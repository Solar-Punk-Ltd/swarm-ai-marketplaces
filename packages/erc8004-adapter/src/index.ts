export { createERC8004Client } from './client';
export type { ERC8004Client } from './client';

export {
  generateAgentCard,
  generateRegistrationFile,
  serializeAgentCard,
  parseAgentCard,
  uploadAgentCard,
  downloadAgentCard,
  agentCardFeedUrl,
} from './agent-card';

export {
  IdentityModule,
  AGENT_WALLET_SET_TYPES,
  MAX_AGENT_WALLET_DEADLINE_SECONDS,
} from './modules/identity';
export {
  setAgentSplitter,
  getAgentSplitter,
  findAgentSplitters,
  encodeSplitterMetadata,
  decodeSplitterMetadata,
} from './splitter-link';
export type { AgentSplitterLink } from './splitter-link';
export { ReputationModule } from './modules/reputation';
export { AggregateModule } from './modules/aggregate';
export * from './modules/reviews';
export { queryFilterChunked, DEFAULT_LOG_RANGE_MAX } from './utils/logs';

export { IDENTITY_REGISTRY_ABI } from './abis/IdentityRegistry';
export { REPUTATION_REGISTRY_ABI } from './abis/ReputationRegistry';
export { REVENUE_SPLITTER_ABI, SPLITTER_FACTORY_ABI } from './abis/Splitter';

export {
  DEFAULT_BEE_API_URL,
  DEFAULT_RPC_URL,
  DEFAULT_CHAIN,
  DEFAULT_GATEWAY_URL,
  AGENT_CARD_TOPIC,
  SWARM_AI_CAPABLE,
  SWARM_AGENT_ID,
  AGENT_SPLITTER,
  RECENT_BLOCK_COUNT,
} from './constants';

export { default as config } from './config';
export type { ERC8004AdapterConfig, ChainConfig, BeeConfig } from './config';

export type {
  ERC8004Config,
  MetadataEntry,
  AgentCard,
  AgentCardParams,
  AgentService,
  AgentRegistration,
  RegisterResult,
  PostFeedbackParams,
  PostFeedbackResult,
  WalletAuth,
  FeedbackResult,
  FeedbackEntry,
  ReputationSummary,
  ReputationScore,
  LogQueryOptions,
  NewFeedbackEvent,
  FeedbackRevokedEvent,
  ResponseAppendedEvent,
  SwarmUploadResult,
} from './types';
