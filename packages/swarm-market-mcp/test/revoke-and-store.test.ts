import { Wallet } from 'ethers';
import { BuyerStore } from '../src/buyer-store';
import { ReviewToolError, parseTerms, toFixedPointScore } from '../src/reviews';
import { runRevokeReview, type RevokeReviewDeps } from '../src/tools/revoke_review/run';
import { TX, intent, storeWithPurchase, terms } from './helpers';

const buyer = Wallet.createRandom().address;

function anchoredStore() {
  const store = storeWithPurchase();
  store.markAnchored(TX, { agentId: '42', feedbackIndex: '7', feedbackTx: '0xfb' });
  return store;
}

function deps(store: BuyerStore, overrides: Partial<RevokeReviewDeps> = {}) {
  return {
    store,
    buyer,
    getFeedback: jest.fn(async () => ({
      value: 85n,
      valueDecimals: 0,
      score: 85,
      tag1: '',
      tag2: '',
      isRevoked: false,
    })),
    revokeFeedback: jest.fn(async () => '0xrevoke'),
    ...overrides,
  } satisfies RevokeReviewDeps;
}

describe('runRevokeReview', () => {
  it('revokes by purchase txHash and frees the purchase', async () => {
    const store = anchoredStore();
    const d = deps(store);
    expect(await runRevokeReview({ txHash: TX }, d)).toEqual({
      agentId: '42',
      feedbackIndex: '7',
      revokeTxHash: '0xrevoke',
      txHash: TX,
    });
    expect(d.getFeedback).toHaveBeenCalledWith(42n, buyer, 7n);
    expect(store.getPurchase(TX)!.reviewState).toBe('revoked');
    expect(store.listPurchases(true).map((p) => p.txHash)).toContain(TX);
  });

  it('revokes by agentId + feedbackIndex and finds the purchase locally', async () => {
    const store = anchoredStore();
    const result = await runRevokeReview({ agentId: '42', feedbackIndex: '7' }, deps(store));
    expect(result.txHash).toBe(TX);
  });

  it('reports a missing or already-revoked review', async () => {
    await expect(runRevokeReview({ txHash: TX }, deps(storeWithPurchase()))).rejects.toMatchObject({
      code: 'review_not_found',
    });
    const gone = deps(anchoredStore(), {
      getFeedback: jest.fn(async () => Promise.reject(new Error('revert'))),
    });
    await expect(runRevokeReview({ txHash: TX }, gone)).rejects.toMatchObject({
      code: 'review_not_found',
    });

    const revoked = deps(anchoredStore(), {
      getFeedback: jest.fn(async () => ({
        value: 1n,
        valueDecimals: 0,
        score: 1,
        tag1: '',
        tag2: '',
        isRevoked: true,
      })),
    });
    await expect(runRevokeReview({ txHash: TX }, revoked)).rejects.toMatchObject({
      code: 'already_revoked',
    });
    expect(revoked.revokeFeedback).not.toHaveBeenCalled();
  });
});

describe('BuyerStore', () => {
  it('keeps the signed PurchaseIntent and ignores duplicate inserts', () => {
    const store = storeWithPurchase();
    store.recordPurchase({
      txHash: TX.toUpperCase().replace('0X', '0x'),
      itemId: 'other',
      chainId: '1',
      payTo: '0x',
      asset: '',
      amount: '1',
      purchaseIntent: intent,
      settledAt: 'later',
    });
    const p = store.getPurchase(TX)!;
    expect(p.itemId).not.toBe('other');
    expect(p.purchaseIntent).toEqual(intent);
    expect(p.reviewState).toBe('none');
  });

  it('lists only purchases without a live review when asked', () => {
    const store = anchoredStore();
    expect(store.listPurchases()).toHaveLength(1);
    expect(store.listPurchases(true)).toHaveLength(0);
    store.resetReview(TX);
    expect(store.listPurchases(true)).toHaveLength(1);
  });
});

describe('marketplace terms', () => {
  it('parses the config endpoint body', () => {
    const body = {
      chainId: '84532',
      identityRegistry: terms.review.identityRegistry.toLowerCase(),
      reputationRegistry: terms.review.reputationRegistry,
      splitterFactory: terms.review.splitterFactory,
      splitterTerms: terms.review.splitterTerms,
      score: { min: 1, max: 5, decimals: 1 },
      valueFloor: [{ asset: terms.review.acceptedAssets[0], amount: '1000' }],
      acceptedAssets: terms.review.acceptedAssets,
      maxChunksPerRequest: 16,
      maxEnvelopesPerPurchase: 64,
      requestMaxAgeSeconds: 300,
    };
    const parsed = parseTerms(body);
    expect(parsed.review.chainId).toBe(84532n);
    expect(parsed.review.identityRegistry).toBe(terms.review.identityRegistry);
    expect(parsed.review.valueFloor[0].amount).toBe(1000n);
    expect(parsed.score).toEqual({ min: 1, max: 5, decimals: 1 });
  });

  it('scales scores and enforces range and precision', () => {
    const scale = { min: 1, max: 5, decimals: 1 };
    expect(toFixedPointScore(4.5, scale)).toBe(45n);
    expect(toFixedPointScore(1, scale)).toBe(10n);
    expect(() => toFixedPointScore(0.5, scale)).toThrow(ReviewToolError);
    expect(() => toFixedPointScore(4.55, scale)).toThrow('decimal');
  });
});
