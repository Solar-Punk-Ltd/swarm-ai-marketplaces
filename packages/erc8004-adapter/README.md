# @solarpunk/erc8004-adapter

TypeScript SDK for interacting with the [ERC-8004 "Trustless Agents"](https://eips.ethereum.org/EIPS/eip-8004) on-chain registries. Provides agent identity registration, reputation feedback, and aggregated trust scoring for the Swarm Data Exchange.

This SDK is designed for autonomous agents and agent-aware services (MCPs, x402 servers, wallets) that want to integrate ERC-8004 without directly wiring raw contract calls.

> **Scope:** This package only interacts with ERC-8004-compliant registries. It does not manage Swarm uploads or x402 payment flows itself, but provides types and helpers that integrate cleanly with those layers.

---

## Overview

ERC-8004 defines on-chain registries for agent identity, reputation, and (optionally) third-party validation. This adapter covers the **Identity Registry** and **Reputation Registry** — the two components required for a working data exchange loop. The Validation Registry is optional under the spec and is not included here.

- **Identity Registry** — each agent is minted as a unique NFT. The NFT's URI points to an "Agent Card" stored on Swarm (`bzz://<hash>`), keeping metadata off-chain for gas efficiency.
- **Reputation Registry** — buyers post scored feedback after data exchanges, pointing at a review file on their own Swarm feed. The registry is permissionless (only the agent's own owner/operators are rejected); Sybil resistance comes from Proof-of-Purchase, checked by the reviews module.

This adapter wraps both registries into three modules, plus the reviews module:

| Module       | Class / exports    | Purpose                                                                                          |
| ------------ | ------------------ | ------------------------------------------------------------------------------------------------ |
| `identity`   | `IdentityModule`   | Register agents, manage URIs, wallets, and metadata                                              |
| `reputation` | `ReputationModule` | Post, revoke, respond to and read feedback; paged event queries                                  |
| `aggregate`  | `AggregateModule`  | Average score over a given (PoP-valid) client set                                                |
| reviews      | functions          | Review files, feed writing with envelopes, Proof-of-Purchase and review verification (see below) |

A helper module (`agent-card`) handles generating, serializing, and parsing Agent Card JSON. These helpers are **pure TypeScript** — they do not interact with the blockchain.

---

## Architecture

```
createERC8004Client(config)
        │
        ├── identity   → IdentityModule  → IdentityRegistry  (ERC-721, on Base Sepolia)
        ├── reputation → ReputationModule → ReputationRegistry (on Base Sepolia)
        └── aggregate  → AggregateModule  → wraps ReputationModule
```

The client is read-only when initialized with a `Provider`. Pass a `Signer` to enable write operations (register, postFeedback, etc.).

---

## Installation

```bash
pnpm add @solarpunk/erc8004-adapter ethers
```

---

## Quick Start

### 1. Initialize the client

```typescript
import { ethers } from 'ethers';
import { createERC8004Client } from '@solarpunk/erc8004-adapter';

const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const erc8004 = createERC8004Client({
  provider,
  signer, // omit for read-only use
  chain: 'base-sepolia',
});
```

### 2. Generate and register an agent (provider flow)

```typescript
import { generateAgentCard, uploadAgentCard } from '@solarpunk/erc8004-adapter';

// Build the Agent Card JSON
const card = generateAgentCard({
  name: 'My Data Provider',
  description: 'Sells encrypted image datasets via Swarm',
  version: '1.0.0',
  services: [
    { name: 'x402', endpoint: 'https://provider.example.com/data' },
    { name: 'swarm-ai-catalog', endpoint: '0xCatalogFeedOwnerAddress' },
  ],
  x402Support: true,
  active: true,
  supportedTrust: ['reputation'],
  capabilities: ['Swarm', 'trading', 'image_generation'],
});

// Upload the Agent Card to a Swarm feed — reads BEE_FEED_PK, BEE_API_URL, BEE_POSTAGE_STAMP from env.
// Using a feed means the card can be updated later without changing the on-chain URI.
const { feedUrl } = await uploadAgentCard(card);

// Mint the ERC-8004 NFT with optional metadata attached at registration time
const { agentId, txHash } = await erc8004.identity.register(feedUrl, [
  { metadataKey: 'swarm_ai_capable', metadataValue: new Uint8Array([1]) },
]);
console.log('Registered agentId:', agentId.toString());
```

The agent is now discoverable by anyone querying the Identity Registry or watching for `Registered` events on-chain.

### 2b. Set or update metadata after registration

Metadata can also be written (or overwritten) any time after the NFT exists, and read back as raw bytes:

```typescript
// Write arbitrary key/value bytes on-chain (owner only)
await erc8004.identity.setMetadata(agentId, 'swarm_ai_capable', new Uint8Array([1]));

// Read it back
const value = await erc8004.identity.getMetadata(agentId, 'swarm_ai_capable');
// value is a Uint8Array — e.g. Uint8Array(1) [ 1 ]
```

The `metadataValue` is stored as raw `bytes` on-chain. Use `new Uint8Array([1])` / `new Uint8Array([0])` for boolean flags, or `ethers.toUtf8Bytes(str)` for string values.

### 3. Discover and evaluate a provider (consumer flow)

To discover all agents that have advertised a specific capability, use `findAgentsWithMetadata`. It scans `MetadataSet` events, deduplicates per agent, and returns each agent's on-chain URI alongside the raw metadata value.

```typescript
import { ethers } from 'ethers';
import { SWARM_AI_CAPABLE } from '@solarpunk/erc8004-adapter/constants';

// Find all agents that have set the swarm_ai_capable metadata key
const agents = await erc8004.identity.findAgentsWithMetadata(SWARM_AI_CAPABLE);

// Filter to those where the value is 1 (capability is active)
const capableAgents = agents.filter((a) => ethers.toBigInt(a.rawValue) === 1n);

console.log(`Found ${capableAgents.length} SwarmAI-capable agents`);
for (const agent of capableAgents) {
  console.log(`agentId: ${agent.agentId} — uri: ${agent.uri}`);
}
```

You can optionally scope the scan to a block range to reduce RPC calls:

```typescript
const agents = await erc8004.identity.findAgentsWithMetadata(SWARM_AI_CAPABLE, 36304145);
```

Once you have a URI, read the agent's on-chain data directly:

```typescript
// Read the agent's on-chain URI and fetch the Agent Card from Swarm
const uri = await erc8004.identity.getAgentURI(agentId); // "bzz://<hash>"
const owner = await erc8004.identity.getOwner(agentId);

// Check reputation before paying — over the PoP-valid client set, never all clients
const rep = await erc8004.aggregate.calculateReputation(agentId, popValidClients, {
  minScore: 70, // on your marketplace's score scale
  minCount: 3n,
});
console.log(`Score: ${rep.score} | Reviews: ${rep.feedbackCount} | Reliable: ${rep.reliable}`);
```

### 4. Post a review after a data exchange

The buyer writes the review to its own Swarm feed and anchors it with `giveFeedback` from the same key. The full flow (envelopes from the marketplace, Proof-of-Purchase) is specified in the repo-root `CLAUDE.md`; the adapter supplies the pieces:

```typescript
import {
  buildReview,
  serializeReview,
  reviewHash,
  reviewFeedTopic,
  nextFeedIndex,
  prepareReviewUpload,
  uploadReviewChunks,
  encodeFeedbackURI,
} from '@solarpunk/erc8004-adapter';

const review = buildReview({
  chainId: 84532n,
  identityRegistry,
  agentId,
  clientAddress: buyer.address,
  value: 92n,
  valueDecimals: 0,
  comment: 'Dataset matched its description',
  proofOfPayment, // { fromAddress, toAddress: splitter, chainId, txHash, purchaseIntent }
});
const bytes = serializeReview(review);
const topic = reviewFeedTopic(agentId);
const index = await nextFeedIndex(bee, buyer.address, topic);
const prepared = await prepareReviewUpload({
  bee,
  reviewBytes: bytes,
  signerPrivateKey: buyer.privateKey,
  topic,
  index,
});

// prepared.chunkAddresses → request envelopes from the marketplace (or use your own batch)
await uploadReviewChunks(bee, prepared, (address) => envelopes[address]);

const { feedbackIndex } = await erc8004.reputation.postFeedback({
  agentId,
  value: 92n,
  valueDecimals: 0,
  feedbackURI: encodeFeedbackURI({ owner: buyer.address, topic, index }),
  feedbackHash: reviewHash(bytes), // hash of the review content, never of the URI
});
```

Readers check a review with `verifyReview` (feed signature, hash, fields vs the chain) and `verifyPoP` (the purchase was a genuine, taxed sale through this marketplace's splitter).

**What's next?**

- Integrate this client into your MCP server or x402 provider to automate the full data exchange loop.
- Run `pnpm test:sepolia` to walk through a complete agent lifecycle on-chain.

---

## CLI — `create-agent`

The `create-agent` script handles the full registration flow — generate card → upload to Swarm → register on-chain — in a single command, without writing any TypeScript.

```sh
pnpm create-agent [flags]
```

### Flags

| Flag                 | Required | Description                                                                                                                                          |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`             | Yes      | Human-readable agent name                                                                                                                            |
| `--description`      | Yes      | Short description of what the agent does                                                                                                             |
| `--image`            | No       | URL of the agent avatar image                                                                                                                        |
| `--version`          | No       | Agent Card version string (default: `1.0.0`)                                                                                                         |
| `--x402`             | No       | x402 service endpoint URL                                                                                                                            |
| `--catalogFeedOwner` | No       | Catalog feed owner address (0x-prefixed EOA). Published as the `swarm-ai-catalog` service entry — the discovery entry point for the agent's catalog. |
| `--capabilities`     | No       | Comma-separated capability tags, e.g. `trading,price-feeds`                                                                                          |
| `--privateKey`       | No       | On-chain wallet private key — falls back to `PRIVATE_KEY` env var                                                                                    |
| `--feedPrivateKey`   | No       | Swarm feed signing key — falls back to `BEE_FEED_PK` env var                                                                                         |
| `--postageBatchId`   | No       | Postage stamp batch ID (64-char hex) — falls back to `BEE_POSTAGE_STAMP` env var; auto-selected from the Bee node if neither is set                  |
| `--beeApiUrl`        | No       | Bee node base URL — falls back to `BEE_API_URL` env var (default: `http://localhost:1633`)                                                           |

`--privateKey` and `--feedPrivateKey` (or their env var equivalents) are the only values that are always required — everything else has a sensible default or is optional.

### Example

The following registers a trading data provider with an x402 endpoint and a catalog feed owner address:

```sh
pnpm create-agent \
  --name "Solarpunk Trading Data Agent" \
  --description "Provides real-time and historical trading data for DeFi protocols on Base." \
  --image "https://cdn.solarpunk.buzz/agents/trading-avatar.png" \
  --version "1.2.0" \
  --x402 "https://data.solarpunk.buzz/trading/v1" \
  --catalogFeedOwner "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" \
  --capabilities "trading,historical-data,price-feeds" \
  --privateKey "0xac0974bec29a17e37ba4a6b4d238ff947bacb478cbed5efcae784d7bf4f2ff80" \
  --feedPrivateKey "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" \
  --beeApiUrl "http://localhost:1633"
```

> **Note:** The private keys above are the standard Hardhat/Anvil dev accounts and are safe to use as examples. Never use them with real funds.

### Output

The script logs each step and exits with a JSON result:

```
[1/4] Agent Card
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "Solarpunk Trading Data Agent",
  "description": "Provides real-time and historical trading data for DeFi protocols on Base.",
  "version": "1.2.0",
  "image": "https://cdn.solarpunk.buzz/agents/trading-avatar.png",
  "services": [
    { "name": "x402", "endpoint": "https://data.solarpunk.buzz/trading/v1" },
    { "name": "swarm-ai-catalog", "endpoint": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" }
  ],
  "x402Support": true,
  "active": true,
  "capabilities": ["trading", "historical-data", "price-feeds"]
}

[2/4] Uploading to Swarm…
  AgentURI:  https://api.gateway.ethswarm.org/feeds/f39fd6e51aad88f6f4ce6ab8827279cfffb92266/6167656e742d63617264...

[3/4] Registering on-chain…

[4/4] Updating Agent Card with registration…

✓ Agent registered successfully
{
  "agentId": "42",
  "txHash": "0xabc123def456...",
  "agentURI": "https://api.gateway.ethswarm.org/feeds/f39fd6e51aad88f6f4ce6ab8827279cfffb92266/6167656e742d63617264..."
}
```

After step 3 returns the on-chain `agentId`, step 4 writes a `registrations[]` entry back into the Agent Card and re-uploads it to the same feed (same topic, so it overwrites). The persisted card therefore includes:

```json
"registrations": [
  { "agentId": "42", "agentRegistry": "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e" }
]
```

`agentRegistry` is a CAIP-10 reference (`eip155:<chainId>:<contractAddress>`) derived from the live client — not hardcoded — making the Agent Card the single source of truth for the agent's on-chain identity.

- **`agentId`** — the NFT token ID assigned by the Identity Registry. Use this for reputation queries and metadata lookups.
- **`txHash`** — the Base Sepolia transaction hash. Verify at `https://sepolia.basescan.org/tx/<txHash>`.
- **`agentURI`** — the Swarm feed URL stored on-chain. It always resolves to the latest version of the Agent Card, so the URI never needs to change even if the card is updated.

### Running from the monorepo root

You can run the command from anywhere in the repo using pnpm's `--filter` flag — no need to `cd` into the package first:

```sh
pnpm --filter @solarpunk/erc8004-adapter create-agent \
  --name "Solarpunk Trading Data Agent" \
  --description "Provides real-time and historical trading data for DeFi protocols on Base." \
  --image "https://cdn.solarpunk.buzz/agents/trading-avatar.png" \
  --version "1.2.0" \
  --x402 "https://data.solarpunk.buzz/trading/v1" \
  --catalogFeedOwner "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" \
  --capabilities "trading,historical-data,price-feeds" \
  --privateKey "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" \
  --feedPrivateKey "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
```

### Using env vars instead of flags

If `PRIVATE_KEY` and `BEE_FEED_PK` are already in your environment or `.env`, you can omit the key flags:

```sh
pnpm --filter @solarpunk/erc8004-adapter create-agent \
  --name "Solarpunk Trading Data Agent" \
  --description "Provides real-time and historical trading data for DeFi protocols on Base." \
  --x402 "https://data.solarpunk.buzz/trading/v1" \
  --capabilities "trading,price-feeds"
```

---

## CLI — `discover-agents`

The `discover-agents` script queries the Identity Registry for every agent that has the `swarm_ai_capable` metadata flag set to `1`, then fetches each matching agent's card from Swarm and prints the full list as JSON. No Swarm upload or on-chain write is performed — the command is read-only.

```sh
pnpm discover-agents [--privateKey "0x..."]
```

### Flags

| Flag           | Required | Description                                                                                                                                            |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--privateKey` | No       | On-chain wallet private key — falls back to `PRIVATE_KEY` env var. Required in practice (used to initialize the provider/signer for contract queries). |

When `PRIVATE_KEY` is already set in your `.env`, no flags are needed at all.

### What it does

1. Scans all `MetadataSet` events on the Identity Registry for the key `swarm_ai_capable`, deduplicating to the latest value per agent.
2. Filters to agents whose value equals `1` (capability active).
3. For each matching agent, fetches the Agent Card JSON from the Swarm feed URL stored on-chain.
4. Prints a JSON array with one entry per agent: `agentId`, `agentURI`, and the full `agentCard` object.

If a Swarm fetch fails for a specific agent (e.g. the card is temporarily unreachable), a warning is printed to stderr and `agentCard` is `null` for that entry — the rest of the results are still returned.

### Example

```sh
pnpm discover-agents --privateKey "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
```

Or, with `PRIVATE_KEY` already in `.env`:

```sh
pnpm discover-agents
```

### Output

```
Discovering swarm_ai_capable agents…
Found 2 capable agent(s). Fetching agent cards…

[
  {
    "agentId": "41",
    "agentURI": "https://api.gateway.ethswarm.org/feeds/f39fd6e51aad88f6f4ce6ab8827279cfffb92266/6167656e742d63617264...",
    "agentCard": {
      "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      "name": "Solarpunk Weather Data Agent",
      "version": "1.0.0",
      "description": "Provides historical and real-time weather data for on-chain applications.",
      "image": "https://api.gateway.ethswarm.org/bzz/1edce577.../img/avatar.jpg",
      "services": [
        { "name": "x402", "endpoint": "https://data.solarpunk.buzz/weather/v1" },
        { "name": "swarm-ai-catalog", "endpoint": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" }
      ],
      "x402Support": true,
      "active": true,
      "capabilities": ["weather", "historical-data"]
    }
  },
  {
    "agentId": "42",
    "agentURI": "https://api.gateway.ethswarm.org/feeds/f39fd6e51aad88f6f4ce6ab8827279cfffb92266/6167656e742d63617264...",
    "agentCard": {
      "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      "name": "Solarpunk Trading Data Agent",
      "version": "1.0.0",
      "description": "Provides real-time and historical trading data for DeFi protocols on Base.",
      "image": "https://api.gateway.ethswarm.org/bzz/1edce577.../img/avatar.jpg",
      "services": [
        { "name": "x402", "endpoint": "https://data.solarpunk.buzz/trading/v1" },
        { "name": "swarm-ai-catalog", "endpoint": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" }
      ],
      "x402Support": true,
      "active": true,
      "capabilities": ["trading"]
    }
  }
]
```

- **`agentId`** — the NFT token ID in the Identity Registry.
- **`agentURI`** — the Swarm feed URL stored on-chain; always resolves to the latest version of the Agent Card.
- **`agentCard`** — the parsed Agent Card fetched from Swarm, or `null` if the fetch failed.

### Running from the monorepo root

```sh
pnpm --filter @solarpunk/erc8004-adapter discover-agents \
  --privateKey "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
```

### Using env vars instead of flags

With `PRIVATE_KEY` in your `.env`:

```sh
pnpm --filter @solarpunk/erc8004-adapter discover-agents
```

---

## CLI — `get-agent`

The `get-agent` script fetches a single ERC-8004 agent by its NFT token ID. It reads the agent's URI directly from the Identity Registry and downloads the Agent Card from Swarm, returning a single JSON object. No Swarm upload or on-chain write is performed — the command is read-only.

```sh
pnpm get-agent --agentId <id> [--privateKey "0x..."]
```

### Flags

| Flag           | Required | Description                                                                                                                                            |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--agentId`    | Yes      | The NFT token ID of the agent to look up (e.g. `5102`)                                                                                                 |
| `--privateKey` | No       | On-chain wallet private key — falls back to `PRIVATE_KEY` env var. Required in practice (used to initialize the provider/signer for contract queries). |

When `PRIVATE_KEY` is already set in your `.env`, only `--agentId` is needed.

### What it does

1. Calls `tokenURI(agentId)` on the Identity Registry to read the on-chain Swarm feed URL.
2. Fetches the Agent Card JSON from that URL using `downloadAgentCard()` — always resolves to the latest version of the card.
3. Prints a single JSON object with `agentId`, `agentURI`, and the full `agentCard`.

If the Swarm fetch fails (e.g. the card is temporarily unreachable), a warning is printed to stderr and `agentCard` is `null` — the rest of the fields are still returned.

### Example

```sh
pnpm get-agent --agentId 5102 --privateKey "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
```

Or, with `PRIVATE_KEY` already in `.env`:

```sh
pnpm get-agent --agentId 5102
```

### Output

```json
{
  "agentId": "5102",
  "agentURI": "https://api.gateway.ethswarm.org/feeds/5468fb0537098ab63a8848dfc30f283894b37179/a1087ef3dd0e5c2fef60db3cdedac0d559d9b99b2cc922eb1b91bad419e45010",
  "agentCard": {
    "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    "name": "Solarpunk Trading Data Agent",
    "version": "1.0.0",
    "description": "Provides real-time and historical trading data for DeFi protocols on Base.",
    "image": "https://api.gateway.ethswarm.org/bzz/1edce577.../img/avatar.jpg",
    "services": [
      { "name": "x402", "endpoint": "https://data.solarpunk.buzz/trading/v1" },
      { "name": "swarm-ai-catalog", "endpoint": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" }
    ],
    "x402Support": true,
    "active": true,
    "capabilities": ["trading"]
  }
}
```

- **`agentId`** — the NFT token ID that was queried.
- **`agentURI`** — the Swarm feed URL stored on-chain; always resolves to the latest version of the Agent Card.
- **`agentCard`** — the parsed Agent Card fetched from Swarm, or `null` if the fetch failed.

If the `agentId` does not exist, the script exits with an error from the contract call (`ERC721: invalid token ID` or equivalent).

### Running from the monorepo root

```sh
pnpm --filter @solarpunk/erc8004-adapter get-agent --agentId 5102
```

### Using env vars instead of flags

With `PRIVATE_KEY` in your `.env`:

```sh
pnpm --filter @solarpunk/erc8004-adapter get-agent --agentId 5102
```

---

## API Reference

> For an overview of how these modules layer on top of the on-chain contracts, see the [Architecture diagram](#architecture) above.

**Type conventions:** All agent IDs are `bigint` (matching Solidity `uint256`). Scores are fixed-point (`value`, `valueDecimals`) on the marketplace's own scale; `score` fields are the decimal form.

### `createERC8004Client(config)`

Factory function. Returns `{ identity, reputation, aggregate }`.

```typescript
interface ERC8004Config {
  provider: Provider;
  signer?: Signer; // required for write operations
  chain: 'base-sepolia' | 'base' | 'mainnet' | string;
  contracts?: {
    identityRegistry?: string; // override deployed address
    reputationRegistry?: string;
  };
}
```

Only `base-sepolia` has pre-configured contract addresses. For other chains, pass addresses via `config.contracts`.

---

### IdentityModule (`erc8004.identity`)

| Method                   | Signature                                                                        | Description                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`               | `(agentURI: string, metadata?: MetadataEntry[]) → RegisterResult`                | Mints a new agent NFT with optional on-chain metadata. Returns `{ agentId, txHash }`.                                                                                                                                                    |
| `getAgentURI`            | `(agentId: bigint) → string`                                                     | Reads the stored `bzz://` URI from the NFT.                                                                                                                                                                                              |
| `setAgentURI`            | `(agentId, newURI) → txHash`                                                     | Updates the URI. Owner/operator only.                                                                                                                                                                                                    |
| `getOwner`               | `(agentId: bigint) → address`                                                    | Returns current NFT owner.                                                                                                                                                                                                               |
| `setAgentWallet`         | `(agentId, wallet, deadline, sig) → txHash`                                      | Attaches a hot wallet for payments, keeping the agent NFT owner separate. Requires EIP-712 proof.                                                                                                                                        |
| `signAgentWalletAuth`    | `(agentId, walletSigner, owner, ttl?) → WalletAuth`                              | The new wallet's consent for `setAgentWallet`: EIP-712 `AgentWalletSet(agentId, newWallet, owner, deadline)`, domain `ERC8004IdentityRegistry` v1, deadline ≤ 5 min. `agentWalletTypedData` returns the same data for signing elsewhere. |
| `getAgentWallet`         | `(agentId: bigint) → address`                                                    | Returns the associated wallet, or zero address.                                                                                                                                                                                          |
| `setMetadata`            | `(agentId, key, value: Uint8Array) → txHash`                                     | Stores arbitrary key/value bytes on-chain.                                                                                                                                                                                               |
| `getMetadata`            | `(agentId, key) → Uint8Array`                                                    | Reads stored metadata bytes.                                                                                                                                                                                                             |
| `getRegisteredAgents`    | `(fromBlock?, toBlock?) → { agentId, agentURI, owner }[]`                        | Returns all agents registered in the given block range by scanning `Registered` events.                                                                                                                                                  |
| `getAgentsByMetadata`    | `(metadataKey, fromBlock?, toBlock?) → { agentId, rawValue: Uint8Array }[]`      | Returns all agents that had a given metadata key set, by scanning `MetadataSet` events. May include duplicates if a key was overwritten — filter to the latest entry per `agentId` or confirm with `getMetadata` for the current value.  |
| `findAgentsWithMetadata` | `(metadataKey, fromBlock?, toBlock?) → { agentId, uri, rawValue: Uint8Array }[]` | Higher-level helper: scans `MetadataSet` events, deduplicates by `agentId` (latest event wins), and fetches the on-chain URI for each matching agent. Use `ethers.toBigInt(rawValue) === 1n` to filter for boolean-flag metadata keys.   |

---

### ReputationModule (`erc8004.reputation`)

| Method                      | Signature                                                                             | Description                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `postFeedback`              | `(params: PostFeedbackParams) → { txHash, feedbackIndex, blockNumber }`               | `giveFeedback` from the signer (who becomes the clientAddress).                    |
| `revokeFeedback`            | `(agentId, feedbackIndex) → txHash`                                                   | Revokes the signer's feedback entry.                                               |
| `appendResponse`            | `(agentId, clientAddress, feedbackIndex, responseURI, responseHash) → txHash`         | Appends a response (e.g. the seller's rebuttal) to an entry.                       |
| `getFeedback`               | `(agentId, clientAddress, feedbackIndex) → FeedbackResult`                            | Reads a single feedback entry.                                                     |
| `getClients`                | `(agentId, blockTag?) → string[]`                                                     | Every address that left feedback. `blockTag` needs an archive RPC.                 |
| `readAllFeedback`           | `(agentId, clients, { tag1?, tag2?, includeRevoked?, blockTag? }) → FeedbackEntry[]`  | Entries from `clients`; revoked excluded by default.                               |
| `getSummary`                | `(agentId, clientAddresses, tag1?, tag2?) → ReputationSummary`                        | The registry's average over `clientAddresses` (required — pass the PoP-valid set). |
| `getNewFeedbackEvents`      | `(agentId, { fromBlock, toBlock?, chunkSize?, clientAddress? }) → NewFeedbackEvent[]` | Paged log scan. The only place `feedbackURI` / `feedbackHash` are available.       |
| `getFeedbackRevokedEvents`  | same options → `FeedbackRevokedEvent[]`                                               | Paged log scan.                                                                    |
| `getResponseAppendedEvents` | same options → `ResponseAppendedEvent[]`                                              | Paged log scan.                                                                    |

**`PostFeedbackParams`:**

```typescript
interface PostFeedbackParams {
  agentId: bigint;
  value: bigint; // fixed-point score; the marketplace defines the scale (not clamped)
  valueDecimals: number; // 0–18
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI: string; // e.g. swarm-feed://<owner>/<topic>/<index>
  feedbackHash: string; // keccak256 of the content feedbackURI resolves to
}
```

---

### AggregateModule (`erc8004.aggregate`)

| Method                | Signature                                                              | Description                                                     |
| --------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `calculateReputation` | `(agentId, clientAddresses, { minScore, minCount }) → ReputationScore` | Average over the given clients, judged against your thresholds. |

---

### Reviews module

Pure helpers plus Bee/chain-backed checks for the reputation layer (spec: repo-root `CLAUDE.md`).

| Export                                                                                                      | Purpose                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `reviewFeedTopic(agentId)`                                                                                  | Per-seller topic: `keccak256("swarm-ai-review.v1" ‖ agentId as uint256)`                      |
| `encodeFeedbackURI` / `parseFeedbackURI`                                                                    | `swarm-feed://<owner>/<topic>/<index>`                                                        |
| `feedIdentifier(topic, index)`                                                                              | `keccak256(topic ‖ index as 8-byte BE)` (bee-js 12 does not export its own)                   |
| `buildReview` / `serializeReview` / `parseReview` / `reviewHash`                                            | Review file with a random salt, canonical JSON, keccak256                                     |
| `prepareReviewUpload` / `uploadReviewChunks` / `nextFeedIndex`                                              | Build content chunks + the signed feed update offline; upload with per-address stamps         |
| `verifyPoP(input, reader, config)` / `createPoPChainReader`                                                 | Proof-of-Purchase rules: settlement, payer, factory clone + terms, floor, PurchaseIntent ↔ tx |
| `verifyReview(entry, { bee, config })`                                                                      | Feed signature, `feedbackHash`, JSON ↔ on-chain consistency                                   |
| `findAnchoredPurchase(deps, params)`                                                                        | The buyer's non-revoked review already claiming a purchase (one review per purchase)          |
| `signEnvelopeRequest` / `recoverEnvelopeRequestSigner` / `envelopeRequestDomain` / `isEnvelopeRequestFresh` | EIP-712 envelope request, bound to one marketplace                                            |

---

### Agent Card helpers

```typescript
import {
  generateAgentCard,
  generateRegistrationFile, // alias for generateAgentCard
  serializeAgentCard,
  parseAgentCard,
  uploadAgentCard,
  downloadAgentCard,
} from '@solarpunk/erc8004-adapter';
```

| Function                        | Description                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateAgentCard(params)`     | Creates an `AgentCard` object. `name`, `description`, `version`, and `services` are required. `type`, `active` and `x402Support` are optional and default when omitted. `capabilities` and `supportedTrust` are optional string arrays.                    |
| `serializeAgentCard(card)`      | JSON-stringifies with 2-space indentation, encoding any `bigint` (e.g. `registrations[].agentId`) as a string. Use this as the content to upload to Swarm. `parseAgentCard` re-hydrates those strings back to `bigint` on read.                            |
| `parseAgentCard(json)`          | Parses and validates a JSON string. Throws if `type` is not the ERC-8004 registration type string, or if `name`, `description`, `services`, `x402Support`, or `active` are missing or invalid. `registrations` is optional and may be absent or undefined. |
| `uploadAgentCard(card, topic?)` | Uploads the card to a Swarm feed and returns `{ reference, url, feedUrl }`. Reads `BEE_FEED_PK`, `BEE_API_URL` and `BEE_POSTAGE_STAMP` from the environment. `feedUrl` always uses the public Swarm gateway.                                               |
| `downloadAgentCard(agentURI)`   | Fetches and parses an Agent Card from a Swarm feed URL (the `agentURI` stored on-chain). Always resolves to the latest version of the card. Throws if the fetch fails or the response is not a valid Agent Card.                                           |

`uploadAgentCard` returns a `SwarmUploadResult`:

```typescript
interface SwarmUploadResult {
  reference: string; // 64-char hex Swarm content hash
  url: string; // bzz://<reference> — immutable direct link to this version
  feedUrl: string; // https://api.gateway.ethswarm.org/feeds/<owner>/<topic> — always resolves to the latest version
}
```

Example:

```typescript
import { generateAgentCard, uploadAgentCard } from '@solarpunk/erc8004-adapter';

const card = generateAgentCard({ ... });
// BEE_FEED_PK, BEE_API_URL, BEE_POSTAGE_STAMP are read from environment
const { feedUrl } = await uploadAgentCard(card);

// Use the feed URL as the on-chain agent URI so the card can be updated later
const { agentId } = await erc8004.identity.register(feedUrl);
```

**`AgentCard` structure:**

```typescript
interface AgentCard {
  type: string; // MUST be "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"
  name: string;
  description: string;
  version: string; // e.g. "1.0.0" — semver or date string identifying the card revision
  image?: string; // OPTIONAL — defaults to a Swarm-hosted placeholder avatar
  services: AgentService[];
  x402Support: boolean; // true if the agent accepts x402 micropayments
  active: boolean; // false to soft-deactivate without un-registering
  registrations?: AgentRegistration[]; // OPTIONAL — populated after on-chain registration
  supportedTrust?: string[]; // e.g. ["reputation", "crypto-economic"]
  capabilities?: string[]; // OPTIONAL — e.g. ["Swarm", "trading", "image_generation"]
}

interface AgentService {
  name: string; // e.g. "MCP", "Swarm", "x402", "web"
  endpoint: string; // full URL or bzz:// URI
  version?: string; // e.g. "0.3.0" or "2025-06-18"
  skills?: string[];
  domains?: string[];
}

interface AgentRegistration {
  agentId: bigint;
  agentRegistry: string; // CAIP-10 reference, e.g. "eip155:84532:0x8004A818..."
}
```

---

## Deployed Contracts

| Chain            | Network | Identity Registry                            | Reputation Registry                          |
| ---------------- | ------- | -------------------------------------------- | -------------------------------------------- |
| Base Sepolia     | Testnet | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Base Mainnet     | —       | not configured                               | not configured                               |
| Ethereum Mainnet | —       | not configured                               | not configured                               |

Agents registered on Base Sepolia are browsable at [8004scan.io](https://8004scan.io).

---

## Running the Integration Test

The integration test registers a real agent on Base Sepolia and exercises the catalog purchase path. It sends on-chain transactions and requires testnet ETH. Feedback is not posted: the registry rejects feedback from the agent's own owner, so a review needs a separate buyer wallet.

### 1. Set up environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PRIVATE_KEY=0x<provider-private-key>
RPC_URL=https://sepolia.base.org                 # optional, this is the default
CHAIN=base-sepolia                               # optional, this is the default
BEE_FEED_PK=0x<hex-private-key>                 # required to upload Agent Card to Swarm
BEE_API_URL=http://localhost:1633                # optional, this is the default (Bee node used for uploading)
BEE_POSTAGE_STAMP=<64-char-hex-stamp-id>         # optional, auto-discovered from Bee node if not set
```

Get testnet ETH from the [Base Sepolia faucet](https://faucet.quicknode.com/base/sepolia) for your wallet.

> **Swarm upload:** `BEE_FEED_PK` is required to upload the Agent Card to Swarm. If not set, step 2 is skipped and a placeholder `bzz://` URI is registered on-chain instead. `BEE_POSTAGE_STAMP` is optional — if omitted, the Bee node is queried automatically for a usable batch. To buy a stamp, run `bee stamp buy --depth 20 --amount 100` on your Bee node.

### 2. Build the package

```bash
pnpm install
pnpm build
```

### 3. Run the test

```bash
pnpm test:sepolia
```

Expected output:

```
[Provider wallet] 0xProviderAddress
[Balance] 0.05 ETH

[Step 1: Generate Agent Card]
[Agent Card] { name: 'Test Data Provider', ... }
[Agent Card round-trip] OK

[Step 2: Upload Agent Card to Swarm]
  Skipped — BEE_FEED_PK not set. Using placeholder URI.
  Set BEE_FEED_PK (and optionally BEE_POSTAGE_STAMP, BEE_API_URL) to upload.

[Step 3: Register on-chain (Identity Registry)]
  Sending transaction...
[Registered agentId] 42
[Transaction] 0x...
[On-chain URI] bzz://placeholder-...
[On-chain owner] 0xProviderAddress

✓ Steps completed successfully
  agentId: 42
  View on BaseScan: https://sepolia.basescan.org/tx/0x...
```

With `BEE_FEED_PK` set, the full flow runs:

```
[Step 2: Upload Agent Card to Swarm]
  Uploading to Swarm feed...
[Swarm reference] a1b2c3d4...
[Feed URL] https://api.gateway.ethswarm.org/feeds/0xowneraddress/topichex...

[Step 3: Register on-chain (Identity Registry)]
  Sending transaction...
[Registered agentId] 42
...

[Step 5: Post feedback (Reputation Registry)]
  Sending transaction...
[Feedback tx] 0x...

[Step 6: Calculate reputation]
[Reputation] { agentId: '42', score: 90, feedbackCount: '1', reliable: false }

✓ Steps completed successfully
  agentId: 42
  View on BaseScan: https://sepolia.basescan.org/tx/0x...
```

> The `reliable` flag requires `score >= 70` and at least **3** feedback entries. A single test submission will always show `reliable: false`.

> The integration test typically completes in under 30 seconds on Base Sepolia, depending on network congestion. If it pauses silently after "Sending transaction...", the node is waiting for block confirmation — this is normal.

### 4. Run unit tests

```bash
pnpm test
```

Unit tests use Jest. No wallet or network connection is needed.

---

## Custom Chain / Local Node

To use a custom RPC or a locally deployed contract:

```typescript
const erc8004 = createERC8004Client({
  provider,
  signer,
  chain: 'base-sepolia', // used for EIP-712 domain chainId
  contracts: {
    identityRegistry: '0xCustomIdentityAddress',
    reputationRegistry: '0xCustomReputationAddress',
  },
});
```

For fully custom chains not in the pre-configured list, pass any string as `chain` along with explicit `contracts` addresses:

```typescript
const erc8004 = createERC8004Client({
  provider,
  signer,
  chain: 'hardhat',
  contracts: {
    identityRegistry: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    reputationRegistry: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  },
});
```

---

## Development

```bash
pnpm install          # install dependencies
pnpm build            # compile TypeScript → dist/
pnpm dev              # watch mode
pnpm test             # run unit tests
pnpm test:sepolia     # end-to-end integration test on Base Sepolia
```

---

## Security

Signing happens locally: transactions, review feed updates and EIP-712 envelope requests are signed with the caller's key, which is never transmitted or stored. Read-only operations (checking reputation, reading agent URIs) require only a `Provider` and expose no key material.

---

## Contributing

Contributions and bug reports are welcome. Please open an issue or PR with a failing test case that reproduces the problem.
