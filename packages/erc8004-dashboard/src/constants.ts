export const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://sepolia.base.org';
export const AGENT_DISPLAY_LIMIT = 25;
export const CATALOGUE_FEED_BROWSER_URL = 'http://localhost:3001/';
// marketplace-service (its indexer serves agent reputation). Optional: unset hides reputation.
export const MARKETPLACE_SERVICE_URL = (import.meta.env.VITE_MARKETPLACE_SERVICE_URL ?? '').replace(
  /\/+$/,
  '',
);
