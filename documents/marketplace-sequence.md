# Marketplace flow — end to end (incl. reputation)

Covers setup, seller onboarding, discovery, purchase, payout, review and indexing. Steps marked _(planned)_ are specified in `CLAUDE.md` but not built yet.

```mermaid
sequenceDiagram
    autonumber
    participant OP as Marketplace operator<br/>(marketplace-service + Bee)
    participant SA as Seller agent<br/>(swarm-market-mcp)
    participant SS as Seller server<br/>(x402-swarm-server)
    participant BA as Buyer agent<br/>(swarm-market-mcp, local)
    participant FC as x402 Facilitator
    participant SW as Swarm (Bee)
    participant CH as Base Sepolia<br/>(IdentityRegistry, ReputationRegistry,<br/>SplitterFactory / splitter, USDC)

    Note over OP,CH: 1. Marketplace setup
    OP->>CH: Deploy SplitterFactory(owner, treasury, defaultTaxBps)
    OP->>OP: Run marketplace-service · fund Bee wallet (xBZZ) for review batches

    Note over OP,CH: 2. Seller onboarding
    SA->>SW: Upload Agent Card (feed, BEE_FEED_PK)
    SA->>CH: IdentityRegistry.register(agentURI) → agentId
    SA->>CH: SplitterFactory.createSplitter(seller) → splitter clone
    SA->>CH: setMetadata(agentId, "agent_splitter", splitter)
    SA->>SW: build_catalog: items (ACT-protected), Mantaray, catalog feed (payTo = splitter)

    Note over OP,CH: 3. Discovery + reputation check (comparison phase)
    BA->>CH: Query Registered / MetadataSet events → candidate agents
    BA->>OP: GET /v1/sellers/:agentId/reputation (planned)
    OP-->>BA: { score, count, popValidCount, recency, checkpoint }
    opt verify = true (commitment phase, planned)
        BA->>CH: Census at checkpoint.block (archive): getClients + readAllFeedback<br/>(non-revoked) = count? · short log scan checkpoint → latest
        BA->>SW: Fetch reviews via feedbackURI (swarm-feed://owner/topic/index)
        BA->>BA: verifyReview (hash, SOC owner, JSON = on-chain entry) + verifyPoP
    end

    Note over OP,CH: 4. Purchase (x402, three-phase)
    BA->>SW: Read catalog feed → Mantaray → item.jsonld
    BA->>SS: POST /v1/items/:itemId/purchase (no X-Payment)
    SS-->>BA: 402 challenge (accepts[], purchaseIntentDomain, payTo = splitter)
    BA->>BA: Sign PurchaseIntent (EIP-712) + ERC-3009 auth (shared nonce)
    BA->>SS: POST purchase + X-Payment
    SS->>SS: Verify intent (sig, domain, item, payTo = splitter, time, nonce)
    SS->>FC: /verify
    SS->>FC: /settle
    FC->>CH: USDC.transferWithAuthorization → splitter<br/>(Transfer + AuthorizationUsed events)
    FC-->>SS: txHash
    SS->>SS: Record purchase (consumer, itemId, txHash, payTo)
    SS->>SW: ACT patchGrantees(buyer key) + update item state feed
    SS-->>BA: ActGrantResult { txHash, actHistoryRef, … }
    BA->>BA: Store purchase + signed PurchaseIntent in buyer.db (planned)
    BA->>SW: Download content via ACT

    Note over OP,CH: 5. Payout (any time, permissionless)
    Note over SA,CH: Either party may call. Every call pays BOTH shares: (1 − t) → seller, t → treasury
    SA->>CH: splitter.distribute(token) (e.g. right after a sale)
    OP->>CH: factory.distributeAll(token, offset, limit) (paged sweep, repeated per page)
    CH-->>SA: (1 − t) seller share
    CH-->>OP: t tax → treasury

    Note over OP,CH: 6. Review — submit_review (planned)
    BA->>OP: GET /v1/reviews/config
    BA->>CH: Pre-flight verifyPoP (tx receipt, agent_splitter at settlement log<br/>via archive RPC, factory clone + terms, AuthorizationUsed)
    BA->>CH: findAnchoredPurchase (paged from settlement block)<br/>→ already_reviewed if a non-revoked review from the buyer cites it
    BA->>BA: Build review JSON (score, comment, random salt, proofOfPayment + purchaseIntent)<br/>feedbackHash = keccak256(JSON) · compute chunk addresses (JSON chunks + feed SOC)
    BA->>BA: Sign EnvelopeRequest (EIP-712, domain = chainId + SplitterFactory)
    BA->>OP: POST /v1/reviews/envelopes { agentId, proofOfPayment, chunkAddresses, timestamp, signature }
    OP->>OP: Verify request signature = clientAddress, timestamp fresh
    OP->>CH: verifyPoP (7 rules)
    OP->>CH: NewFeedback(agentId, clientAddress) from settlement block, paged<br/>→ drop revoked → fetch → txHash already anchored?
    OP->>OP: Refuse if requester ≠ payer or a non-revoked review from the payer is anchored<br/>· idempotent per buyer + txHash · cap maxEnvelopesPerPurchase
    alt Seller has no usable batch yet
        OP->>SW: Buy immutable batch for seller (min depth, async)
        OP-->>BA: batch_unavailable { retryAfter }
        BA->>OP: Retry signed request after retryAfter
    end
    alt Envelopes issued
        OP->>SW: createEnvelope(batch, address) per chunk
        OP-->>BA: envelopes (score and text never seen)
        BA->>SW: Upload review chunks + feed SOC with envelopes (buyer key,<br/>topic = keccak256("swarm-ai-review.v1" ‖ agentId),<br/>payload = timestamp ‖ R)
    else Refused (or envelope_quota_exceeded)
        BA->>SW: Same upload with own postageBatchId (self-funded) · refusal can't block publication
    end
    BA->>CH: ReputationRegistry.giveFeedback(agentId, value, …,<br/>swarm-feed://owner/topic/index, feedbackHash)
    CH-->>BA: NewFeedback(agentId, client, feedbackIndex)

    Note over OP,CH: 7. Indexing (planned)
    CH-->>OP: NewFeedback / FeedbackRevoked / ResponseAppended events
    OP->>SW: Fetch review via feedbackURI
    OP->>OP: verifyReview + verifyPoP (Rule C) · one review per purchase<br/>(rule 4: earliest non-revoked from the payer)<br/>→ count, popValidCount, score, PoP-valid client set

    Note over OP,CH: 8. Revocation (optional, planned)
    BA->>CH: revokeFeedback(agentId, feedbackIndex)
    CH-->>OP: FeedbackRevoked → drop from score
    Note over BA,OP: Purchase is free again: submit_review with the same txHash<br/>publishes a replacement (edit), within maxEnvelopesPerPurchase
```
