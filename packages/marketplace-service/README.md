# marketplace-service

Backend for one marketplace operator. Today it runs the review-storage subsidy: it pays (from one
postage batch per seller) to store buyers' reviews, after checking Proof-of-Purchase, without
seeing the score or text. Design and rules: repo-root `CLAUDE.md` ("Settled design decisions",
"Marketplace service endpoints").

## Endpoints

| Method | Path                    | Purpose                                                                                      |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/v1/reviews/config`    | This marketplace's terms: chain, registries, factory, accepted splitter terms, score, limits |
| POST   | `/v1/reviews/envelopes` | Postage envelopes for a review's chunk addresses                                             |

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

## Run

```bash
cp .env.example .env   # set SPLITTER_FACTORY_ADDRESS, ACCEPTED_ASSETS, ARCHIVE_RPC_URL …
npx tsx src/index.ts
pnpm --filter @solarpunk/marketplace-service test
```

The Bee node's wallet must hold xBZZ and xDAI: the first review of each seller buys that seller's
immutable batch (`REVIEW_BATCH_SIZE_MB`, `REVIEW_BATCH_TTL_DAYS`). Top-ups are manual for now.
