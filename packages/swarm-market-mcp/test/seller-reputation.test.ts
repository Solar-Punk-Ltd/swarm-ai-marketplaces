import type {
  FeedbackEntry,
  NewFeedbackEvent,
  PoPResult,
  ReviewDocument,
  ReviewVerification,
} from '@solarpunk/erc8004-adapter';
import { Wallet } from 'ethers';
import {
  runGetSellerReputation,
  type GetSellerReputationDeps,
} from '../src/tools/get_seller_reputation/run';
import { ITEM, terms } from './helpers';

const alice = Wallet.createRandom().address;
const bob = Wallet.createRandom().address;
const carol = Wallet.createRandom().address;
const LATEST = 5_000;

function event(
  client: string,
  index: bigint,
  value: bigint,
  block: number,
  uri: string,
): NewFeedbackEvent {
  return {
    agentId: 42n,
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
    logIndex: 0,
    transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
  };
}

const review = (txHash: string, comment = 'ok') =>
  ({
    proofOfPayment: { txHash },
    comment,
    createdAt: '2026-11-20T00:00:00Z',
  }) as unknown as ReviewDocument;

// alice reviews purchase A (valid) then again for A (duplicate); bob's review is revoked;
// carol's content is gone.
const events = [
  event(alice, 1n, 80n, 100, 'a1'),
  event(bob, 1n, 10n, 110, 'b1'),
  event(alice, 2n, 100n, 120, 'a2'),
  event(carol, 1n, 90n, 130, 'c1'),
];
const reviews: Record<string, ReviewVerification> = {
  a1: { valid: true, review: review('0xA', 'great'), reference: 'r' },
  b1: { valid: true, review: review('0xB'), reference: 'r' },
  a2: { valid: true, review: review('0xa'), reference: 'r' }, // same purchase, other case
  c1: { valid: false, reason: 'content_unavailable' },
};

function deps(overrides: Partial<GetSellerReputationDeps> = {}) {
  return {
    terms,
    indexerReputation: jest.fn(async () => null),
    latestBlock: jest.fn(async () => LATEST),
    defaultFromBlock: (latest: number) => latest - 1_000,
    getClients: jest.fn(async () => [alice, bob, carol]),
    readAllFeedback: jest.fn(
      async (): Promise<FeedbackEntry[]> =>
        // non-revoked entries: alice x2, carol x1
        [alice, alice, carol].map((clientAddress, i) => ({
          clientAddress,
          feedbackIndex: BigInt(i),
          value: 1n,
          valueDecimals: 0,
          score: 1,
          tag1: '',
          tag2: '',
          isRevoked: false,
        })),
    ),
    getNewFeedbackEvents: jest.fn(async () => events),
    getFeedbackRevokedEvents: jest.fn(async () => [
      {
        agentId: 42n,
        clientAddress: bob,
        feedbackIndex: 1n,
        blockNumber: 140,
        logIndex: 0,
        transactionHash: '0xrev',
      },
    ]),
    verifyReview: jest.fn(async (e: NewFeedbackEvent) => reviews[e.feedbackURI]),
    verifyPoP: jest.fn(
      async (): Promise<PoPResult> => ({
        valid: true,
        splitter: alice,
        seller: alice,
        token: alice,
        amount: 1n,
        settlementBlock: 1,
        settlementLogIndex: 0,
        itemId: ITEM,
      }),
    ),
    blockTimestamp: jest.fn(async () => 1_800_000_000),
    ...overrides,
  } satisfies GetSellerReputationDeps;
}

describe('runGetSellerReputation — chain path', () => {
  it('scores only anchored, PoP-valid reviews, one per purchase', async () => {
    const d = deps();
    const rep = await runGetSellerReputation({ agentId: '42', verify: true }, d);

    expect(rep).toMatchObject({
      source: 'chain',
      score: 80,
      count: 3,
      popValidCount: 1,
      scannedFromBlock: 4_000,
      checkpoint: { block: LATEST, lastEvent: { block: 140, txHash: '0xrev' } },
      lastReviewAt: '2027-01-15T08:00:00.000Z',
    });
    expect(rep.verification!.invalid).toEqual([
      { feedbackIndex: '2', clientAddress: alice, reason: 'purchase_already_reviewed' },
      { feedbackIndex: '1', clientAddress: carol, reason: 'content_unavailable' },
    ]);
    expect(rep.reviews).toEqual([
      {
        feedbackIndex: '1',
        clientAddress: alice,
        value: 80,
        comment: 'great',
        createdAt: '2026-11-20T00:00:00Z',
        itemId: ITEM,
      },
    ]);
    // Census at the head needs no archive block tag.
    expect(d.getClients).toHaveBeenCalledWith(42n, undefined);
  });

  it('drops reviews whose purchase fails PoP', async () => {
    const d = deps({
      verifyPoP: jest.fn(
        async () => ({ valid: false, reason: 'splitter_terms_mismatch' }) as PoPResult,
      ),
    });
    const rep = await runGetSellerReputation({ agentId: '42' }, d);
    expect(rep.popValidCount).toBe(0);
    expect(rep.score).toBeNull();
    expect(rep.verification!.invalid[0].reason).toBe('pop:splitter_terms_mismatch');
    expect(rep.reviews).toBeUndefined();
  });

  it('flags live reviews older than the scan window as unscanned', async () => {
    const d = deps({ getNewFeedbackEvents: jest.fn(async () => [events[0]]) });
    const rep = await runGetSellerReputation({ agentId: '42' }, d);
    expect(rep.unscanned).toBe(2);
    expect(rep.verification!.censusComplete).toBe(false);
  });
});

describe('runGetSellerReputation — indexer path', () => {
  const indexed = {
    score: 80,
    count: 3,
    popValidCount: 1,
    recency: 'x',
    checkpoint: { block: 4_500, lastEvent: null },
  };

  it('returns the indexer answer as-is in the comparison phase', async () => {
    const d = deps({ indexerReputation: jest.fn(async () => indexed) });
    const rep = await runGetSellerReputation({ agentId: '42' }, d);
    expect(rep).toMatchObject({ source: 'indexer', score: 80, count: 3 });
    expect(d.getClients).not.toHaveBeenCalled();
  });

  it('checks the indexer against the census at its own checkpoint when verifying', async () => {
    const d = deps({ indexerReputation: jest.fn(async () => ({ ...indexed, count: 2 })) });
    const rep = await runGetSellerReputation({ agentId: '42', verify: true }, d);
    expect(rep.source).toBe('indexer');
    expect(rep.verification!.censusComplete).toBe(false); // indexer served 2, chain has 3
    expect(d.getClients).toHaveBeenCalledWith(42n, 4_500);
    expect(d.getNewFeedbackEvents).toHaveBeenCalledWith(42n, { fromBlock: 4_000, toBlock: 4_500 });
  });

  it('falls back to the chain when the indexer errors', async () => {
    const d = deps({ indexerReputation: jest.fn(async () => Promise.reject(new Error('down'))) });
    expect((await runGetSellerReputation({ agentId: '42' }, d)).source).toBe('chain');
  });
});
