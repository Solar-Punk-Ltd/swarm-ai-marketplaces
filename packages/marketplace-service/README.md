# marketplace-service

Backend for one marketplace operator. It runs the review-storage subsidy — paying (from one postage
batch per seller) to store buyers' reviews after checking Proof-of-Purchase, without seeing the
score or text — and the reputation indexer. Design and rules: repo-root `CLAUDE.md` ("Settled design decisions",
"Marketplace service endpoints").

## Endpoints

| Method | Path                              | Purpose                                                                                      |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/v1/reviews/config`              | This marketplace's terms: chain, registries, factory, accepted splitter terms, score, limits |
| POST   | `/v1/reviews/envelopes`           | Postage envelopes for a review's chunk addresses                                             |
| GET    | `/v1/sellers/:agentId/reputation` | Indexer: a seller's score over PoP-valid reviews (absent when `INDEXER_ENABLED=false`)       |

`POST /v1/reviews/envelopes` body:

```json
{
  "agentId": "42",
  "proofOfPayment": {
    "fromAddress": "0x…",
    "toAddress": "0x…splitter",
    "chainId": "84532",
    "txHash": "0x…",
    "purchaseIntent": { "domain": {}, "message": {}, "signature": "0x…" }
  },
  "chunkAddresses": ["<64-hex>", "…"],
  "timestamp": 1800000000,
  "signature": "0x… EIP-712 EnvelopeRequest by the buyer (adapter signEnvelopeRequest)"
}
```

Response: `{ batchId, envelopes: [{ address, batchId, issuer, index, timestamp, signature }] }`
(adapter `envelopeFromWire` turns each back into a bee-js envelope for `uploadChunk`).

Checks, in order: shape → chunk cap → timestamp → reviewer signature → `verifyPoP` → no
non-revoked review already claims the purchase → seller batch usable (else `503
batch_unavailable` + `Retry-After`) → per-purchase envelope quota → `bee.createEnvelope` per
address. Errors use the shared `ApiError` envelope (`src/errors.ts`).

## Indexer

A cache over chain events and Swarm content, never an authority (design Step 9). Each tick
(`src/indexer.ts`):

1. Ingests `NewFeedback` / `FeedbackRevoked` / `ResponseAppended` for **every** agent from the
   checkpoint to `head − INDEXER_CONFIRMATIONS`, paged by `LOG_RANGE_MAX`, and advances the
   checkpoint in the same SQLite transaction.
2. Verifies pending reviews once each: `verifyReview` (feed signature, hash, fields vs chain) and
   `verifyPoP`. Missing Swarm content is retried `INDEXER_MAX_ATTEMPTS` times; RPC errors never
   count as a verdict.

Scoring happens at read time (`src/reputation.ts`): anchored, non-revoked, verified reviews, one
per purchase (earliest wins), so a revocation frees its purchase for a later review. The response:

```json
{
  "agentId": "42",
  "score": 87.5,
  "scale": { "min": 0, "max": 100, "decimals": 0 },
  "count": 3,
  "popValidCount": 2,
  "pendingCount": 0,
  "recency": "…",
  "lastReviewAt": "…",
  "checkpoint": { "block": 61299902, "lastEvent": { "block": 61299000, "txHash": "0x…" } },
  "popValidClients": ["0x…"],
  "responseCount": 1
}
```

`count` is every anchored, non-revoked entry the indexer saw — what a buyer compares against the
chain census. Before the first tick completes the endpoint answers `503 indexer_unavailable`;
buyer tools then read the chain directly.

**RPC limits.** The public Base Sepolia RPC caps `eth_getLogs` at 200 blocks (`LOG_RANGE_MAX=200`,
the default). Backfilling from the registry deploy block at that size is slow; use an RPC with a
larger range and raise `LOG_RANGE_MAX` for production.

## Run

```bash
cp .env.example .env   # set SPLITTER_FACTORY_ADDRESS, ACCEPTED_ASSETS, ARCHIVE_RPC_URL …
npx tsx src/index.ts
pnpm --filter @solarpunk/marketplace-service test
```

The Bee node's wallet must hold xBZZ and xDAI: the first review of each seller buys that seller's
immutable batch (`REVIEW_BATCH_SIZE_MB`, `REVIEW_BATCH_TTL_DAYS`). Top-ups are manual for now.
