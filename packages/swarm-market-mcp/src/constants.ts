export const DEFAULT_BEE_API_URL = 'http://localhost:1633';
export const DEFAULT_RPC_URL = 'https://sepolia.base.org';
export const DEFAULT_CHAIN = 'base-sepolia';
export const RPC_TIMEOUT_MS = 15_000;
export const CARD_FETCH_TIMEOUT_MS = 15_000;
export const CARD_UPLOAD_TIMEOUT_MS = 60_000;
export const SCAN_TIMEOUT_MS = 60_000;
export const TX_TIMEOUT_MS = 120_000;
export const DEFAULT_BUYER_DB_PATH = './data/buyer.db';
export const DEFAULT_LOG_RANGE_MAX = 2_000;
export const MARKETPLACE_TIMEOUT_MS = 30_000;
// Longest submit_review waits in-call for a seller's new review batch before returning
// batch_unavailable (the call is resumable, so the agent can simply retry later).
export const MAX_BATCH_WAIT_MS = 120_000;
