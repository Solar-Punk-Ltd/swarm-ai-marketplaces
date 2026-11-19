# Swarm AI Data Exchange — Reputation

Decentralized marketplace where AI agents publish, discover and buy AI data assets on Swarm, gated by x402 micropayments and ACT encryption. **Current focus: the reputation layer** — buyers review sellers on their own Swarm feeds, anchor each review on-chain via ERC-8004 `giveFeedback`, and only reviews backed by a real, taxed purchase (Proof-of-Purchase, PoP) count.

## Specification

The reputation design is `documents/data-enriched-marketplaces.md`. **Read the relevant section before implementing anything.** Do not infer behaviour from existing code or package names.

Supporting docs:

- `documents/ERC-8004.md` — ERC-8004 registries as used in this POC
- `documents/swarm-ai-catalog-design-v1_2026-05-29-final-draft.md` — catalog + purchase flow (already implemented; read only when touching purchase/catalog code)

## What already exists (do not rebuild)

| Design step                                        | Status  | Where                                                                                                                                                                                       |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 2 — seller ERC-8004 identity                  | Done    | `erc8004-adapter` `modules/identity.ts`; MCP `register_agent`                                                                                                                               |
| Step 2 / 4b — per-seller split contract            | Done    | `contracts/src/RevenueSplitter.sol`, `SplitterFactory.sol`, viem SDK `contracts/ts/index.ts`. Agent → splitter link: metadata key `agent_splitter` (`erc8004-adapter/src/splitter-link.ts`) |
| Step 4 — x402 `payTo` = splitter                   | Done    | `x402-swarm-server/src/intent.ts` (`payment_destination_untaxed`); MCP `build_catalog` via `swarm-market-mcp/src/splitter.ts` `resolvePayTo()`                                              |
| Step 4 — purchase + seller-side record             | Done    | `x402-swarm-server/src/purchase.ts`, `db.ts` (`purchases`: consumer, item, tx_hash, settled_at, pay_to). `ActGrantResult.txHash` is returned to the buyer                                   |
| ReputationRegistry wrapper (Phase 1)               | Done    | `erc8004-adapter/src/modules/reputation.ts` — content `feedbackHash`, no `FeedbackAuth`, `appendResponse` / `getClients` / `readAllFeedback`, paged event queries, `getSummary` fixed       |
| Reviews module (Phase 2)                           | Done    | `erc8004-adapter/src/modules/reviews/` — review file, feed writing, `verifyPoP`, `verifyReview`, `findAnchoredPurchase`, envelope-request signatures; Jest tests in `erc8004-adapter/test/` |
| Steps 5–9 services (envelopes, MCP tools, indexer) | Missing | Phases 3–5                                                                                                                                                                                  |

Gaps in "done" parts that reputation depends on:

- The buyer side does not persist purchases: MCP `purchase_catalog_item` returns `txHash` but stores nothing.

## Settled design decisions

These were agreed while reviewing the design. Follow them unless the user changes them.

- **Reviewer = buyer address.** The same key signs the review feed and calls `giveFeedback` (it becomes the ERC-8004 `clientAddress`). The reviewer does **not** need an ERC-8004 identity. A session key is out of scope for the prototype.
- **`giveFeedback` is called by the reviewer** on the ReputationRegistry, from their own wallet — no marketplace or seller signature. The reviewer pays gas (only storage is subsidized). `feedbackAuth` is obsolete — the live ABI has no such parameter.
- **Review JSON** = the ERC-8004 off-chain feedback file plus `proofOfPayment`:
  ```json
  {
    "agentRegistry": "eip155:84532:<IdentityRegistry>",
    "agentId": 42,
    "clientAddress": "eip155:84532:<reviewer>",
    "createdAt": "<ISO-8601>",
    "value": 85,
    "valueDecimals": 0,
    "tag1": "",
    "tag2": "",
    "comment": "<text, or a Swarm reference for long reviews>",
    "salt": "0x<32 random bytes>",
    "proofOfPayment": {
      "fromAddress": "<reviewer>",
      "toAddress": "<seller splitter>",
      "chainId": "84532",
      "txHash": "<settlement tx>",
      "purchaseIntent": { "domain": {}, "message": {}, "signature": "0x…" }
    }
  }
  ```
  Required by ERC-8004: `agentRegistry`, `agentId`, `clientAddress`, `createdAt`, `value`, `valueDecimals`. `proofOfPayment`'s four base fields are ERC-8004; `comment`, `salt` and `purchaseIntent` are our extensions. In this design `proofOfPayment`, `purchaseIntent` and `salt` are mandatory.
- **`salt` is mandatory.** Content chunk addresses are hashes of the content, and the envelope request reveals almost every other field, so without a fresh random 32-byte salt the marketplace could brute-force `value` from `chunkAddresses` before issuing envelopes.
- **`purchaseIntent` is mandatory (for now).** It is the EIP-712 `PurchaseIntent` exactly as signed at purchase (`domain`, `message: PurchaseIntentMessage`, `signature`; types in `swarm-catalog/src/types.ts`). It binds the review to a specific `itemId`. Privacy cost accepted: it publicly reveals `itemId` and `granteePublicKey`.
- **Storage:** review JSON uploaded → reference `R`; then a reviewer-signed feed update (SOC) whose payload is exactly **8-byte big-endian Unix timestamp ‖ 32-byte `R`** (40 bytes; the layout bee-js 12's internal `updateFeedWithReference` writes). bee-js 12 does not export its feed-identifier helper, so the reviews module builds the SOC itself from public APIs:
  - `identifier = keccak256(topic ‖ index as 8-byte big-endian)` (`FeedIndex.fromBigInt(index)` gives the 8 bytes);
  - chunk = `bee.makeContentAddressedChunk(timestamp ‖ R)` → `.toSingleOwnerChunk(identifier, signer)` (or `bee.makeSingleOwnerChunk` with that chunk's fields);
  - SOC address for the envelope request = `bee.calculateSingleOwnerChunkAddress(identifier, owner)`;
  - readers take bytes 8–40 of the SOC payload as `R`.
- **One review feed per buyer per seller.** Owner = buyer address; topic = `keccak256("swarm-ai-review.v1" ‖ agentId)` (`agentId` as a 32-byte big-endian uint256, i.e. `abi.encodePacked(string, uint256)`). Repeat purchases from the same seller → successive updates (indexes) on the same feed.
- **`feedbackURI`** identifies that exact feed update (owner = `clientAddress`, plus topic + index), not "latest" — a later feed update must not change what the on-chain entry points to. Format: **`swarm-feed://<owner>/<topic>/<index>`** — `owner` = 0x-prefixed reviewer address, `topic` = 64-hex `reviewFeedTopic(agentId)`, `index` = decimal feed index. Verification: rebuild the SOC address from (owner, topic, index) → fetch the SOC → check its signature recovers `owner` (= `clientAddress`) → follow its payload `R` → fetch the review JSON → `keccak256` = `feedbackHash`.
- **`feedbackHash` = `keccak256(review JSON bytes)`** — never a hash of the URI string.
- **PoP validity** — a review counts only if its `txHash`:
  1. exists and succeeded on the stated chain;
  2. contains an ERC-20 `Transfer` log **from `clientAddress` to the seller's splitter** (check the log, not `tx.from` — the facilitator submits the tx). Seller splitter = the `agent_splitter` metadata of the reviewed `agentId` **as it stood at the settlement log**, so re-pointing the link later neither invalidates old reviews nor validates new ones. Method: archive `eth_call` of `getMetadata(agentId, "agent_splitter")` at block `N − 1` (N = settlement block; needs an archive RPC, `ARCHIVE_RPC_URL`), then a single-block `MetadataSet` log query for block N, filtered by `agentId` **and** the indexed key topic `keccak256("agent_splitter")`: only logs with a lower log index than the settlement `Transfer` count, and the **last** of those wins. (Replaying `MetadataSet` from the registry deploy block is not used: RPC log-range limits.) The link is owner-written and unverified (`splitter-link.ts`), so the splitter must also be **a genuine clone of the marketplace's configured `SplitterFactory`**: `factory.splitterOf(splitter.seller()) == splitter`, and its `treasury` / `taxBps` must match the marketplace's accepted terms (from config). Otherwise a seller could point the link at their own wallet or a 0%-tax contract and mint untaxed PoP-valid reviews;
  3. moved ≥ the value floor in an accepted token;
  4. is not already claimed by another review (one purchase → one review). Only entries **whose `clientAddress` is the payer** (the `from` of the settlement `Transfer`) can claim a purchase; entries from any other wallet citing the same `txHash` are ignored and consume nothing (otherwise a seller could self-fund a junk review citing the buyer's public `txHash` and anchor it first). The winner is the **earliest non-revoked `NewFeedback` from the payer, in chain order, whose content resolves and matches its `feedbackHash`** and cites this `txHash`. A **revoked** winner frees the purchase: revoke + resubmit acts as an edit, bounded by `maxEnvelopesPerPurchase` — chain order is authoritative, not the order envelopes were issued. The citation lives in the content, so an entry whose content can't be fetched or doesn't match cites nothing. **Accepted consequence:** if the winner's content later expires, the next valid review citing the same purchase becomes the winner and the score can change — consistent with Rule A (expired evidence is unverifiable);
  5. carries a `purchaseIntent` whose EIP-712 signature recovers to `clientAddress`;
  6. contains `AuthorizationUsed(clientAddress, intent.message.nonce)` emitted by the token contract (the intent nonce = the ERC-3009 nonce, which ties the intent to this tx);
  7. has `intent.message.payment.payTo` = the seller's splitter and `payment.amount` = the `Transfer` value.
- **Envelopes:** the marketplace issues postage stamps per chunk address (`bee.createEnvelope(batchId, address)`) after validating PoP; it never sees review content. The reviewer uploads with `bee.uploadChunk(envelope, chunk)`. One envelope per chunk: the feed SOC + every chunk of the review JSON.
- **Envelope requests are signed by the reviewer.** The seller's server sees the buyer's signed `PurchaseIntent`, so a valid PoP alone doesn't prove who is asking; without a request signature a seller could claim the buyer's purchase with junk addresses and block the real review. The request carries an **EIP-712** signature by `clientAddress`, bound to one marketplace so it is invalid at any other:
  ```
  domain: { name: "swarm-marketplace-service", version: "1", chainId, verifyingContract: <configured SplitterFactory> }
  EnvelopeRequest: { agentId: uint256, txHash: bytes32, chunkAddresses: bytes32[], timestamp: uint256 }
  ```
  The service rejects timestamps older than `requestMaxAgeSeconds` (config).
- **Envelope issuance is idempotent per (`clientAddress`, `txHash`)** and is open whenever no **non-revoked** `NewFeedback` from the payer cites that purchase (same rule as PoP rule 4): retries after a failed upload get new envelopes instead of `pop_already_claimed`, and after the buyer revokes their review the purchase reopens for a new one (edit). `maxEnvelopesPerPurchase` bounds the total either way. To decide "anchored", the service queries `NewFeedback` filtered by `agentId` **and** `clientAddress` (both indexed), skips revoked entries (`FeedbackRevoked` / `readFeedback().isRevoked`), fetches only those reviews and reads their `txHash` — bounded to one buyer's reviews of one seller, so no full indexer is needed in Phase 3.
- **Log queries are paged.** `feedbackURI` exists only in the `NewFeedback` event (`readFeedback` / `readAllFeedback` return no URI), so lookups must use logs, and indexed filters don't lift RPC block-range caps. `findAnchoredPurchase` searches from the settlement block N onward (no review can cite a purchase before it happened) in chunks of the provider's maximum range (`LOG_RANGE_MAX` config). The Phase 5 indexer pages the same way, from its last checkpoint.
- **Envelope cap per purchase.** Total envelopes per (`clientAddress`, `txHash`) across all requests ≤ `maxEnvelopesPerPurchase` (config, default 4 × `maxChunksPerRequest`); beyond it → `envelope_quota_exceeded`. Stops one purchase from filling the seller's batch.
- **Shared splitters are accepted.** The factory makes one clone per seller address, so several agents with the same seller address share a splitter, and a purchase from one of them passes PoP for the others. Low risk: still one review per purchase (rule 4) and the tax is paid. (A reader may optionally check that `purchaseIntent.message.itemId` belongs to the reviewed agent's catalog.)
- **One marketplace-owned postage batch per seller**, created lazily on the seller's first review, minimum depth, **immutable** (a mutable batch overwrites old chunks once full, breaking older feed indexes); marketplace keeps the batch key. Sellers never get a write path. A new batch takes several blocks to become usable: buy it asynchronously and answer `batch_unavailable` with `retryAfter` until it is.
- **Rule C:** a review counts only if anchored on-chain **and** PoP-valid. Revoked feedback (`FeedbackRevoked`) is dropped.
- **Review ↔ on-chain consistency.** A review is valid only if the JSON's `agentId`, `clientAddress` and `value`/`valueDecimals` equal the on-chain `NewFeedback` entry, the `feedbackURI` topic equals `reviewFeedTopic(on-chain agentId)`, and `agentRegistry` / `proofOfPayment.chainId` equal the configured chain + IdentityRegistry. `clientAddress` is stored as CAIP-10 (`eip155:<chainId>:0x…`): parse it, check the chain id, and compare addresses case-insensitively. Scores use the on-chain value.
- **Counts:** `count` = all anchored, non-revoked entries for the seller; `popValidCount` = the Rule C subset. The census compares the chain against `count`, so reviews without valid PoP never look like omissions.

## Implementation plan

Phases depend on the previous ones.

### Phase 1 — `erc8004-adapter` reputation fixes

- `postFeedback`: take `feedbackURI` and `feedbackHash` (content hash) as inputs; stop hashing the URI string.
- Remove `FeedbackAuth` (`signFeedbackAuth`, `verifyFeedbackAuth`, types, config comment).
- Add wrappers: `appendResponse`, `readAllFeedback`, and event queries for `NewFeedback`, `FeedbackRevoked`, `ResponseAppended` filtered by `agentId` (pattern: `identity.ts` `queryFilter` usage).
- `getSummary`: require an explicit client set (the PoP-valid set). The registry already returns the average (reference implementation divides by count), so don't divide again. Empty tag filters mean "no filter" in the reference implementation; still confirm against the deployed registry before relying on it for the census.
- Jest unit tests in `erc8004-adapter/test/`.

### Phase 2 — reviews module in `erc8004-adapter` (`src/modules/reviews/`)

No separate package: the adapter already spans ERC-8004 + Swarm (Agent Card feeds) + marketplace specifics (`splitter-link.ts`), and both consumers (`swarm-market-mcp`, `marketplace-service`) can import it. Export it from the package entry point.

- Types: `ReviewDocument` (JSON above), `ProofOfPayment`, `ReviewRecord` (on-chain entry + resolved content + verdicts).
- Constants: `reviewFeedTopic(agentId)` (per-seller topic above), `feedbackURI` encode/parse.
- `buildReview()`, canonical serialization, `reviewHash()`.
- Writer helpers: compute chunk addresses for the review JSON and the feed SOC, upload with supplied envelopes (public bee-js APIs only, per the Storage decision: `makeContentAddressedChunk` → `toSingleOwnerChunk`, `calculateSingleOwnerChunkAddress`, `uploadChunk`). Own `feedIdentifier(topic, index)` helper.
- Verifiers: `verifyPoP(review, provider, marketplaceConfig)` (rules above, incl. factory-clone and historical-link checks), `verifyReview(entry)` (fetch via `feedbackURI`, hash = `feedbackHash`, SOC owner = `clientAddress`, plus the review ↔ on-chain consistency checks).
- `signEnvelopeRequest()` / `verifyEnvelopeRequest()` (EIP-712 `EnvelopeRequest`, shared by buyer tool and service).
- `findAnchoredPurchase(agentId, clientAddress, txHash, fromBlock)`: paged `NewFeedback` query by both indexed fields from the settlement block → drop revoked → fetch → read `txHash` (used by Phase 3 and the indexer).
- `PurchaseIntent` types/EIP-712 descriptor come from `@solarpunk/swarm-catalog` (already an adapter dependency; do not copy them).
- ethers v6 for chain reads and signature recovery (same as the rest of the adapter). Jest tests with mocked Bee/RPC.

### Phase 3 — new `packages/marketplace-service` (marketplace backend, Express; reputation is its first feature)

- `POST /v1/reviews/envelopes` → verify the reviewer's request signature, validate PoP (adapter `verifyPoP`), refuse only if the `txHash` already has a non-revoked anchored review from the payer (`findAnchoredPurchase`) or the requester is not the payer, enforce `maxEnvelopesPerPurchase`, find the seller's batch (or start buying it asynchronously → `batch_unavailable` + `retryAfter`), return one envelope per address. Cap addresses per request.
- SQLite (`better-sqlite3`): seller → batch id + status, (`clientAddress`, `txHash`) requests, envelopes issued.
- Structured `ApiError` responses, same style as `x402-swarm-server/src/errors.ts`.
- Batch top-up/dilution: manual or a simple script for the prototype.

### Phase 4 — `swarm-market-mcp` buyer tools

Full spec in **Review tools spec** below. Follow the existing tool layout: `src/tools/<name>/index.ts` + `models.ts`, JSON schema in `src/schemas/tools.ts`, zod schema in `src/schemas/zod-schemas.ts`.

### Phase 5 — read path / indexer (Step 9)

- In `marketplace-service`: index `NewFeedback` / `FeedbackRevoked` / `ResponseAppended` per `agentId`, resolve content, apply Rule C, serve `GET /v1/sellers/:agentId/reputation` → `{ score, count, popValidCount, recency, checkpoint }` (checkpoint = block height + last event seen) and the PoP-valid client set.
- Buyer-side verification in the adapter's reviews module: census check (served `count` vs non-revoked on-chain entries at the checkpoint, via `getClients` + `readAllFeedback` at `checkpoint.block`; see `get_seller_reputation`) + per-review `verifyReview`.

### Phase 6 — optional UI

- Seller reputation in `erc8004-dashboard` / `marketplace-ui`.

### Out of scope for prototype

- Session-key delegation; gas relaying / paymaster for `giveFeedback`
- Step 5b live notifications (webhook / GSOC)
- M-independent-buyers scoring, price oracle for cross-token value floors
- Custom facilitator / signed receipts (PoP is verified from on-chain `Transfer` logs)
- Ownership-transfer guard (Step 7), sparse Merkle tree, fraud proofs, multiple indexers
- Seller rebuttal persisted under the review batch (`appendResponse` on-chain wrapper is in scope)

## Review tools spec

All review tools run **locally on the buyer's machine** with `BUYER_WALLET_PK`. The marketplace never hosts them (it would hold reviewers' keys). Marketplace-specific values come from the marketplace service (`GET /v1/reviews/config`), never from hardcoded constants.

### Prerequisite — buyer-side purchase store

`purchase_catalog_item` must persist every successful purchase (today it stores nothing). SQLite at `BUYER_DB_PATH` (default `./data/buyer.db`), keyed by `txHash`:

| Column                                                                          | Source                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `tx_hash` (PK)                                                                  | `ActGrantResult.txHash`                                                |
| `item_id`, `chain_id`                                                           | request / challenge `network`                                          |
| `pay_to`, `asset`, `amount`                                                     | chosen `accepts[]` entry                                               |
| `purchase_intent`                                                               | JSON `{ domain, message, signature }` as signed                        |
| `settled_at`                                                                    | `ActGrantResult.grantedAt` or now                                      |
| `review_state`                                                                  | `none` · `uploaded` · `anchored` · `revoked` (written by review tools) |
| `review_json`, `feedback_uri`, `feedback_hash`, `feedback_index`, `feedback_tx` | written by `submit_review`                                             |

Add `list_purchases` (no inputs; optional `unreviewedOnly: boolean`) returning these rows, so an agent can find the `txHash` to review.

### Marketplace service endpoints the tools depend on (Phase 3)

- `GET /v1/reviews/config` → `{ chainId, identityRegistry, reputationRegistry, splitterFactory, splitterTerms: [{ treasury, taxBps }], score: { min, max, decimals }, valueFloor: [{ asset, amount }], acceptedAssets, maxChunksPerRequest, maxEnvelopesPerPurchase, requestMaxAgeSeconds }`
- `POST /v1/reviews/envelopes` body `{ agentId, proofOfPayment, chunkAddresses: string[], timestamp, signature }` (`proofOfPayment` incl. `purchaseIntent`, so the service validates all 7 PoP rules; `signature` = EIP-712 `EnvelopeRequest` by `clientAddress`, see Envelope requests above) → `{ batchId, envelopes: [{ address, issuer, index, timestamp, signature }] }`. Idempotent per (`clientAddress`, `txHash`) while no non-revoked review from the payer cites it. Errors (`ApiError`): `bad_request_signature`, `request_expired`, `pop_invalid` (with `reason`), `pop_already_claimed` (a non-revoked anchored review from the payer exists; requester ≠ payer → `pop_invalid` / `wrong_payer`), `too_many_chunks`, `envelope_quota_exceeded`, `batch_unavailable` (with `retryAfter` seconds).
- `GET /v1/sellers/:agentId/reputation` → see `get_seller_reputation` output.

### `submit_review`

**Input**

| Field                   | Type             | Req. | Notes                                                                                   |
| ----------------------- | ---------------- | ---- | --------------------------------------------------------------------------------------- |
| `txHash`                | string           | yes  | Settlement tx of the purchase being reviewed                                            |
| `agentId`               | string (uint256) | yes  | Seller's ERC-8004 id                                                                    |
| `value`                 | number           | yes  | Score; must be within `config.score` range, scaled by `config.score.decimals`           |
| `comment`               | string           | no   | Review text; stored in the review JSON on Swarm, never on-chain                         |
| `tag1`, `tag2`          | string           | no   | Passed to `giveFeedback` and the JSON                                                   |
| `postageBatchId`        | string           | no   | Self-fund storage instead of requesting envelopes (fallback if the marketplace refuses) |
| `marketplaceServiceUrl` | string           | no   | Falls back to `MARKETPLACE_SERVICE_URL`                                                 |

**Steps** (persist `review_state` after each durable step so a re-run resumes, never repeats)

1. Load config from the marketplace service. Validate `value` range.
2. Load the purchase by `txHash`; it must exist with a stored `purchase_intent`, else `purchase_not_found` / `purchase_intent_missing`. (Purchases made before the store existed cannot be reviewed.)
3. **Pre-flight PoP** (adapter `verifyPoP`, same rules as the service, incl. factory-clone and historical-link checks). Fail fast before spending gas. Then ask the chain, not the local store: `findAnchoredPurchase(agentId, buyer, txHash, settlementBlock)` → `already_reviewed` if a non-revoked review from the buyer cites it (a revoked one may be replaced). Local `review_state` is only a resume hint (it can be stale, e.g. after revoking from another machine); update it from the chain result.
4. Build `ReviewDocument` with `proofOfPayment.purchaseIntent` from the store and a fresh random `salt`. Serialize canonically; `feedbackHash = keccak256(bytes)`.
5. Compute chunk addresses: every chunk of the review JSON + the feed SOC (next index on the buyer's feed for `reviewFeedTopic(agentId)`; payload `timestamp ‖ R`).
6. Get stamps: sign the request (`signEnvelopeRequest`) and `POST /v1/reviews/envelopes`, or use `postageBatchId`. On `batch_unavailable`, wait `retryAfter` and retry. Map other service errors 1:1.
7. Upload all chunks with their envelopes to `BEE_API_URL` (`bee.uploadChunk`). → `review_state = uploaded`.
8. `giveFeedback(agentId, value, decimals, tag1, tag2, "", feedbackURI, feedbackHash)` from the buyer key. Read `feedbackIndex` from the `NewFeedback` event. → `review_state = anchored`.

**Output**: `{ agentId, txHash, feedbackIndex, feedbackURI, feedbackHash, reviewReference, feedIndex, giveFeedbackTxHash, itemId }`

**Errors**: `score_out_of_range`, `purchase_not_found`, `purchase_intent_missing`, `pop_invalid` (`reason`: `tx_not_found` · `tx_failed` · `no_transfer_to_splitter` · `wrong_payer` · `below_value_floor` · `splitter_unlinked` · `splitter_not_factory_clone` · `splitter_terms_mismatch` · `intent_bad_signature` · `intent_not_in_tx` · `intent_payment_mismatch`), `already_reviewed`, `pop_already_claimed`, `envelope_denied`, `envelope_quota_exceeded` (typically after several edits; retry with `postageBatchId` to self-fund storage), `batch_unavailable` (after retries), `upload_failed` (safe to retry: envelope issuance stays open while no non-revoked review from the payer cites the purchase), `give_feedback_failed` (content already on Swarm; retry resumes at step 8), `insufficient_gas` (buyer needs ETH on the chain).

### `revoke_review`

**Input**: `txHash` (looks up `agentId` + `feedbackIndex` in the store) **or** `agentId` + `feedbackIndex`.

**Steps**: `revokeFeedback(agentId, feedbackIndex)` from the buyer key → `review_state = revoked`. The on-chain revocation is authoritative; a Swarm tombstone feed entry is out of scope for the prototype. Revoking frees the purchase: `submit_review` with the same `txHash` may then publish a replacement (edit), within `maxEnvelopesPerPurchase`.

**Output**: `{ agentId, feedbackIndex, revokeTxHash }`. **Errors**: `review_not_found`, `not_review_owner`, `already_revoked`, `insufficient_gas`.

### `get_seller_reputation`

**Input**

| Field                   | Type             | Req. | Notes                                                                                                |
| ----------------------- | ---------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `agentId`               | string (uint256) | yes  |                                                                                                      |
| `verify`                | boolean          | no   | Default `false` = comparison phase (indexer answer only). `true` = commitment phase                  |
| `sample`                | number           | no   | With `verify`, how many reviews to fully check; default all                                          |
| `marketplaceServiceUrl` | string           | no   | Indexer; falls back to `MARKETPLACE_SERVICE_URL`. If unreachable, compute directly from chain (slow) |

**Steps**: query the indexer → if `verify`: census check without a full log scan: on the archive RPC at `checkpoint.block`, `getClients(agentId)` then `readAllFeedback(agentId, clients, "", "", false)` (client list split into batches to stay within RPC gas/response limits) → non-revoked entry count, compared with the indexer's `count` (all anchored, non-revoked entries, not `popValidCount`). Then a short paged log scan from `checkpoint.block` to latest confirms no newer `NewFeedback` / `FeedbackRevoked`. **Verify before relying on it:** that empty `tag1`/`tag2` mean "no filter" in the deployed registry; if not, fall back to the paged `NewFeedback` − `FeedbackRevoked` count. then for sampled reviews run `verifyReview` (hash, SOC owner, review ↔ on-chain consistency) and `verifyPoP`.

**Output**

```
{ agentId, score, scale: { min, max, decimals }, count, popValidCount, lastReviewAt,
  checkpoint: { block, lastEvent },
  source: "indexer" | "chain",
  verification?: { censusComplete, checked, invalid: [{ feedbackIndex, clientAddress, reason }] },
  reviews?: [{ feedbackIndex, clientAddress, value, comment, createdAt, itemId }] }   // only with verify
```

**Errors**: `agent_not_found`, `indexer_unavailable` (only if chain fallback also fails), `omission_detected` (returned as `verification.censusComplete = false`, not thrown).

## Open questions (ask the user before deciding)

- Value floor and accepted tokens for PoP.
- Whether Bee gateways accept envelope-stamped uploads for the target deployment.
- Per-seller batch depth / TTL and who triggers top-ups.

## Key invariants

- **This repo is a framework for building marketplaces, not one marketplace.** Never hardcode marketplace-specific values (`SplitterFactory` address, treasury, tax rate, postage batch IDs, value floor, service URLs); read them from config/env. Shared singletons (ERC-8004 registries) may have defaults.
- Review content is signed only by the reviewer's key; the marketplace and seller never write to a reviewer's feed.
- The marketplace never uploads reviews and never sees the score or text before issuing envelopes (it gets chunk addresses + the PoP only; the review `salt` keeps the score from being brute-forced out of the chunk addresses).
- Only the reviewer can request envelopes for their purchase (signed request), and only a genuine factory clone with the marketplace's terms counts as a seller's splitter.
- The on-chain feedback set is the canonical census; indexers are caches, never authorities.
- A priced listing's `payTo` is the seller's splitter clone, never a bare EOA.
- Existing catalog invariants still hold (catalog feed payload is a bare 64-hex reference; purchase record is written after `/settle`, before ACT grant).

## Tech stack

- TypeScript throughout; `@ethersphere/bee-js` 12 for Swarm (feeds, SOC, envelopes, ACT)
- `ethers` v6 in `erc8004-adapter` (incl. reviews module) and `swarm-market-mcp`; `viem` in `contracts/ts`, `x402-swarm-server`, `catalogue-feed-browser`. `marketplace-service` uses the adapter's reviews module, so ethers
- Express for HTTP servers; `better-sqlite3` for local stores; Jest for TS tests; Foundry for `contracts`
- Chain: Base Sepolia (84532). IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713` (`erc8004-adapter/src/client.ts`)

## Dev environment

- Node 22+, pnpm 9+; `pnpm install` from root
- Local Bee node at `http://localhost:1633`
- Copy `.env.example` → `.env` per package
- Run without build: `npx tsx src/index.ts`; all packages: `pnpm dev`; build: `pnpm build`
- Test one package: `pnpm --filter <package-name> test`
- `packages/contracts` needs Foundry (`forge`); its scripts skip with a warning when absent (CI: `REQUIRE_FOUNDRY=1`)

## Environment variables

| Variable                   | Package(s)                                                                  | Purpose                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `BEE_API_URL`              | all                                                                         | Bee node, default `http://localhost:1633`                                                                           |
| `POSTAGE_BATCH_ID`         | `swarm-catalog`, `x402-swarm-server`                                        | Batch for catalog uploads (`erc8004-adapter`: `BEE_POSTAGE_STAMP`)                                                  |
| `BEE_FEED_PK`              | `swarm-catalog`, `x402-swarm-server`, `erc8004-adapter`, `swarm-market-mcp` | Catalog / Agent Card feed signer                                                                                    |
| `PRIVATE_KEY`              | `erc8004-adapter`, `swarm-market-mcp`                                       | On-chain signer (seller agent)                                                                                      |
| `BUYER_WALLET_PK`          | `swarm-market-mcp`                                                          | Buyer key: purchases, and (new) review feed + `giveFeedback`                                                        |
| `RPC_URL`                  | `erc8004-adapter`, new packages                                             | EVM RPC endpoint                                                                                                    |
| `ARCHIVE_RPC_URL`          | `marketplace-service`, `swarm-market-mcp` (new)                             | Archive RPC for the historical `agent_splitter` read (PoP rule 2); falls back to `RPC_URL` if it is an archive node |
| `LOG_RANGE_MAX`            | `marketplace-service`, `swarm-market-mcp` (new)                             | Max blocks per `eth_getLogs` page (provider's range cap)                                                            |
| `SPLITTER_ADDRESS`         | `x402-swarm-server`                                                         | Seller's splitter; other `payTo` rejected                                                                           |
| `SPLITTER_FACTORY_ADDRESS` | `swarm-market-mcp`, new packages                                            | Resolves seller → splitter                                                                                          |
| `AGENT_PAYMENT_ADDRESS`    | `swarm-market-mcp`                                                          | Seller whose splitter becomes `payTo`                                                                               |
| `DB_PATH`                  | `x402-swarm-server`, `marketplace-service`                                  | SQLite file                                                                                                         |
| `MARKETPLACE_SERVICE_URL`  | `swarm-market-mcp` (new)                                                    | Marketplace envelope / reputation endpoint                                                                          |
| `BUYER_DB_PATH`            | `swarm-market-mcp` (new)                                                    | Buyer-side purchase + review store, default `./data/buyer.db`                                                       |

New variables for `marketplace-service` (batch owner key, Bee node with funded wallet, value floor) are defined when Phase 3 is built; add them here.
