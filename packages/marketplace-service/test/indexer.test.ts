import type {
  FeedbackRevokedEvent,
  NewFeedbackEvent,
  PoPResult,
  ReviewDocument,
  ReviewVerification,
} from '@solarpunk/erc8004-adapter';
import { Wallet } from 'ethers';
import { IndexStore } from '../src/index-store.js';
import { ReviewIndexer, type IndexerDeps, type IndexerOptions } from '../src/indexer.js';
import { ServiceError } from '../src/errors.js';
import { sellerReputation } from '../src/reputation.js';

const SCALE = { min: 0, max: 100, decimals: 0 };
const alice = Wallet.createRandom().address;
const bob = Wallet.createRandom().address;

const OPTIONS: IndexerOptions = {
  startBlock: 100,
  confirmations: 5,
  maxBlocksPerTick: 1_000,
  chunkSize: 500,
  verifyBatch: 10,
  maxAttempts: 2,
  pollMs: 1_000,
};

let logIndex = 0;
function feedback(
  agentId: bigint,
  client: string,
  index: bigint,
  value: bigint,
  block: number,
  uri: string,
): NewFeedbackEvent {
  return {
    agentId,
    clientAddress: client,
    feedbackIndex: index,
    value,
    valueDecimals: 0,
    tag1: '',
    tag2: '',
    endpoint: '',
    feedbackURI: uri,
    feedbackHash: '0x00',
    blockNumber: block,
    logIndex: logIndex++,
    transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
  };
}

function revocation(
  agentId: bigint,
  client: string,
  index: bigint,
  block: number,
): FeedbackRevokedEvent {
  return {
    agentId,
    clientAddress: client,
    feedbackIndex: index,
    blockNumber: block,
    logIndex: logIndex++,
    transactionHash: `0xr${block}`,
  };
}

const okReview = (txHash: string): ReviewVerification => ({
  valid: true,
  review: { proofOfPayment: { txHash } } as unknown as ReviewDocument,
  reference: 'r',
});

const validPoP: PoPResult = {
  valid: true,
  splitter: alice,
  seller: alice,
  token: alice,
  amount: 1n,
  settlementBlock: 1,
  settlementLogIndex: 0,
  itemId: 'item',
};

function setup(chain: {
  head: number;
  feedback?: NewFeedbackEvent[];
  revocations?: FeedbackRevokedEvent[];
  reviews?: Record<string, ReviewVerification>;
}) {
  const store = new IndexStore(':memory:');
  const inRange = <T extends { blockNumber: number }>(
    events: T[],
    o: { fromBlock: number; toBlock?: number },
  ) =>
    events.filter((e) => e.blockNumber >= o.fromBlock && e.blockNumber <= (o.toBlock ?? Infinity));
  const deps = {
    store,
    latestBlock: jest.fn(async () => chain.head),
    getNewFeedbackEvents: jest.fn(async (_: null, o) => inRange(chain.feedback ?? [], o)),
    getFeedbackRevokedEvents: jest.fn(async (_: null, o) => inRange(chain.revocations ?? [], o)),
    getResponseAppendedEvents: jest.fn(async () => []),
    verifyReview: jest.fn(
      async (e: { feedbackURI: string }) => chain.reviews?.[e.feedbackURI] ?? okReview('0xdefault'),
    ),
    verifyPoP: jest.fn(async (): Promise<PoPResult> => validPoP),
    blockTimestamp: jest.fn(async (b: number) => 1_800_000_000 + b),
  } satisfies IndexerDeps;
  return { store, deps, indexer: new ReviewIndexer(deps, OPTIONS) };
}

describe('ReviewIndexer.tick', () => {
  it('ingests from the start block to head − confirmations and checkpoints', async () => {
    const { store, deps, indexer } = setup({
      head: 205,
      feedback: [
        feedback(42n, alice, 1n, 80n, 150, 'a1'),
        feedback(42n, alice, 2n, 90n, 201, 'late'),
      ],
    });
    const result = await indexer.tick();

    expect(result.ingested).toEqual({ from: 100, to: 200, events: 1 });
    expect(result.caughtUp).toBe(true);
    expect(store.getCheckpoint()).toBe(200);
    expect(deps.getNewFeedbackEvents).toHaveBeenCalledWith(null, {
      fromBlock: 100,
      toBlock: 200,
      chunkSize: 500,
    });

    deps.latestBlock.mockResolvedValue(210);
    expect((await indexer.tick()).ingested).toEqual({ from: 201, to: 205, events: 1 });
  });

  it('backfills in bounded steps', async () => {
    const { indexer } = setup({ head: 5_000 });
    const first = await indexer.tick();
    expect(first.ingested).toMatchObject({ from: 100, to: 1_099 });
    expect(first.caughtUp).toBe(false);
  });

  it('verifies each review once and records the purchase it cites', async () => {
    const { store, deps, indexer } = setup({
      head: 300,
      feedback: [feedback(42n, alice, 1n, 80n, 150, 'a1')],
      reviews: { a1: okReview('0xAA') },
    });
    await indexer.tick();
    await indexer.tick();

    expect(deps.verifyReview).toHaveBeenCalledTimes(1);
    expect(store.reviewsFor('42')[0]).toMatchObject({
      status: 'valid',
      purchaseTx: '0xaa',
      itemId: 'item',
      blockTime: 1_800_000_150,
    });
  });

  it('retries unresolvable content, then gives up', async () => {
    const { store, indexer } = setup({
      head: 300,
      feedback: [feedback(42n, alice, 1n, 80n, 150, 'gone')],
      reviews: { gone: { valid: false, reason: 'content_unavailable' } },
    });
    await indexer.tick();
    expect(store.reviewsFor('42')[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await indexer.tick();
    expect(store.reviewsFor('42')[0]).toMatchObject({
      status: 'invalid',
      reason: 'content_unavailable',
    });
  });

  it('treats RPC errors during PoP as transient, and PoP failures as final', async () => {
    const { store, deps, indexer } = setup({
      head: 300,
      feedback: [feedback(42n, alice, 1n, 80n, 150, 'a1'), feedback(42n, bob, 1n, 10n, 160, 'b1')],
      reviews: { a1: okReview('0xA'), b1: okReview('0xB') },
    });
    deps.verifyPoP
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ valid: false, reason: 'splitter_seller_mismatch' } as PoPResult);
    await indexer.tick();
    const [a, b] = store.reviewsFor('42');
    expect(a).toMatchObject({ status: 'pending', reason: 'rpc: timeout' });
    expect(b).toMatchObject({ status: 'invalid', reason: 'pop:splitter_seller_mismatch' });
  });
});

describe('sellerReputation', () => {
  it('is unavailable before the first checkpoint', () => {
    expect(() => sellerReputation(new IndexStore(':memory:'), '42', SCALE)).toThrow(ServiceError);
  });

  it('counts each purchase once, earliest valid review wins, revocations excluded', async () => {
    const { store, indexer } = setup({
      head: 400,
      feedback: [
        feedback(42n, alice, 1n, 80n, 150, 'a1'), // purchase A — wins
        feedback(42n, alice, 2n, 20n, 160, 'a2'), // purchase A again — ignored
        feedback(42n, bob, 1n, 60n, 170, 'b1'), // purchase B — revoked below
        feedback(42n, bob, 2n, 100n, 180, 'b2'), // purchase B again — wins after revocation
        feedback(7n, bob, 1n, 1n, 190, 'other'), // other seller
      ],
      revocations: [revocation(42n, bob, 1n, 175)],
      reviews: {
        a1: okReview('0xA'),
        a2: okReview('0xa'),
        b1: okReview('0xB'),
        b2: okReview('0xB'),
      },
    });
    await indexer.tick();

    const rep = sellerReputation(store, '42', SCALE);
    expect(rep).toMatchObject({
      agentId: '42',
      score: 90,
      count: 3,
      popValidCount: 2,
      pendingCount: 0,
      recency: new Date((1_800_000_000 + 180) * 1000).toISOString(),
      checkpoint: { block: 395, lastEvent: { block: 180 } },
      popValidClients: [alice.toLowerCase(), bob.toLowerCase()],
    });
    expect(sellerReputation(store, '7', SCALE).count).toBe(1);
  });

  it('reports pending reviews separately', async () => {
    const { store, deps, indexer } = setup({
      head: 300,
      feedback: [feedback(42n, alice, 1n, 80n, 150, 'a1')],
    });
    deps.verifyPoP.mockRejectedValue(new Error('rpc down'));
    await indexer.tick();
    expect(sellerReputation(store, '42', SCALE)).toMatchObject({
      count: 1,
      popValidCount: 0,
      pendingCount: 1,
      score: null,
    });
  });
});
