import { Bee } from '@ethersphere/bee-js';
import {
  encodeFeedbackURI,
  envelopeRequestDomain,
  recoverEnvelopeRequestSigner,
  reviewFeedTopic,
  reviewHash,
  type PoPResult,
} from '@solarpunk/erc8004-adapter';
import { Wallet, toUtf8Bytes } from 'ethers';
import type { BuyerStore } from '../src/buyer-store';
import type { EnvelopeRequestBody, EnvelopeResult } from '../src/reviews';
import { ReviewToolError } from '../src/reviews';
import { runSubmitReview, type SubmitReviewDeps } from '../src/tools/submit_review/run';
import { CHAIN_ID, FACTORY, ITEM, TX, storeWithPurchase, terms, wireEnvelopes } from './helpers';

const bee = new Bee('http://localhost:1633'); // only pure chunk helpers are used
const buyer = Wallet.createRandom() as unknown as Wallet;
const NOW = 1_800_000_000;
const AGENT = '42';

const validPoP: PoPResult = {
  valid: true,
  splitter: FACTORY,
  seller: FACTORY,
  token: FACTORY,
  amount: 5000n,
  settlementBlock: 1234,
  settlementLogIndex: 1,
  itemId: ITEM,
};

type MockDeps = SubmitReviewDeps & {
  marketplace: { requestEnvelopes: jest.Mock; getTerms: jest.Mock; getSellerReputation: jest.Mock };
  verifyPoP: jest.Mock;
  findAnchoredPurchase: jest.Mock;
  nextFeedIndex: jest.Mock;
  uploadChunks: jest.Mock;
  postFeedback: jest.Mock;
  sleep: jest.Mock;
};

function deps(store: BuyerStore, overrides: Partial<SubmitReviewDeps> = {}): MockDeps {
  const requestEnvelopes = jest.fn(
    async (body: EnvelopeRequestBody): Promise<EnvelopeResult> => ({
      ok: true,
      batchId: 'ba'.repeat(32),
      envelopes: wireEnvelopes(body.chunkAddresses),
    }),
  );
  return {
    store,
    bee,
    wallet: buyer,
    marketplace: {
      getTerms: jest.fn(async () => terms),
      requestEnvelopes,
      getSellerReputation: jest.fn(async () => null),
    },
    terms,
    verifyPoP: jest.fn(async () => validPoP),
    findAnchoredPurchase: jest.fn(async () => null),
    nextFeedIndex: jest.fn(async () => 0n),
    uploadChunks: jest.fn(async () => undefined),
    postFeedback: jest.fn(async () => ({
      txHash: '0xfeedback',
      feedbackIndex: 7n,
      blockNumber: 2000,
    })),
    sleep: jest.fn(async () => undefined),
    nowSeconds: () => NOW,
    ...overrides,
  } as MockDeps;
}

const args = { txHash: TX, agentId: AGENT, value: 85, comment: 'Good data' };

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(ReviewToolError);
  await promise.catch((err: ReviewToolError) => expect(err.code).toBe(code));
}

describe('runSubmitReview', () => {
  it('publishes with marketplace envelopes and anchors the review', async () => {
    const store = storeWithPurchase();
    const d = deps(store);
    const result = await runSubmitReview(args, d);

    const topic = reviewFeedTopic(42n);
    const feedbackURI = encodeFeedbackURI({ owner: buyer.address, topic, index: 0n });
    const stored = store.getPurchase(TX)!;
    expect(result).toMatchObject({
      agentId: AGENT,
      txHash: TX,
      itemId: ITEM,
      feedbackIndex: '7',
      feedbackURI,
      feedIndex: '0',
      giveFeedbackTxHash: '0xfeedback',
      storage: 'marketplace-envelopes',
    });
    expect(result.feedbackHash).toBe(reviewHash(toUtf8Bytes(stored.reviewJson!)));
    expect(d.postFeedback).toHaveBeenCalledWith({
      agentId: 42n,
      value: 85n,
      valueDecimals: 0,
      tag1: undefined,
      tag2: undefined,
      feedbackURI,
      feedbackHash: result.feedbackHash,
    });
    expect(stored).toMatchObject({ reviewState: 'anchored', feedbackIndex: '7', agentId: AGENT });

    // The envelope request is signed by the buyer for this marketplace.
    const body = d.marketplace.requestEnvelopes.mock.calls[0][0];
    const signer = recoverEnvelopeRequestSigner(
      envelopeRequestDomain(CHAIN_ID, FACTORY),
      {
        agentId: 42n,
        txHash: TX,
        chunkAddresses: body.chunkAddresses,
        timestamp: BigInt(body.timestamp),
      },
      body.signature,
    );
    expect(signer).toBe(buyer.address);

    // Every chunk is uploaded with the envelope issued for its address.
    const [prepared, stampFor] = d.uploadChunks.mock.calls[0] as unknown as [
      { chunkAddresses: string[] },
      (a: string) => { batchId: { toHex(): string } },
    ];
    for (const address of prepared.chunkAddresses) {
      expect(stampFor(address).batchId.toHex()).toBe('ba'.repeat(32));
    }
  });

  it('self-funds storage with postageBatchId and never asks the marketplace', async () => {
    const d = deps(storeWithPurchase());
    const result = await runSubmitReview({ ...args, postageBatchId: 'cd'.repeat(32) }, d);
    expect(result.storage).toBe('self-funded');
    expect(d.marketplace.requestEnvelopes).not.toHaveBeenCalled();
    const stampFor = (d.uploadChunks.mock.calls[0] as unknown[])[1] as (a: string) => string;
    expect(stampFor('any')).toBe('cd'.repeat(32));
  });

  it('rejects scores outside the marketplace scale or with too many decimals', async () => {
    await expectCode(
      runSubmitReview({ ...args, value: 101 }, deps(storeWithPurchase())),
      'score_out_of_range',
    );
    await expectCode(
      runSubmitReview({ ...args, value: 4.5 }, deps(storeWithPurchase())),
      'score_out_of_range',
    );
  });

  it('scales decimal scores to fixed point', async () => {
    const d = deps(storeWithPurchase(), {
      terms: { ...terms, score: { min: 0, max: 5, decimals: 1 } },
    });
    await runSubmitReview({ ...args, value: 4.5 }, d);
    expect(d.postFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ value: 45n, valueDecimals: 1 }),
    );
  });

  it('refuses purchases that were not recorded', async () => {
    await expectCode(
      runSubmitReview({ ...args, txHash: `0x${'00'.repeat(32)}` }, deps(storeWithPurchase())),
      'purchase_not_found',
    );
  });

  it('stops before spending gas when PoP fails', async () => {
    const d = deps(storeWithPurchase(), {
      verifyPoP: jest.fn(
        async () => ({ valid: false, reason: 'splitter_seller_mismatch' }) as PoPResult,
      ),
    });
    await expectCode(runSubmitReview(args, d), 'pop_invalid');
    expect(d.uploadChunks).not.toHaveBeenCalled();
    expect(d.postFeedback).not.toHaveBeenCalled();
  });

  it('reports already_reviewed when the chain has a live review, and syncs the store', async () => {
    const store = storeWithPurchase();
    const anchored = {
      event: { feedbackIndex: 3n, feedbackURI: 'swarm-feed://x', feedbackHash: '0xab' },
      review: {},
    } as never;
    const d = deps(store, { findAnchoredPurchase: jest.fn(async () => anchored) });
    await expectCode(runSubmitReview(args, d), 'already_reviewed');
    expect(d.findAnchoredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 1234, clientAddress: buyer.address }),
    );
    expect(store.getPurchase(TX)).toMatchObject({ reviewState: 'anchored', feedbackIndex: '3' });
  });

  it('waits for a seller batch that is still being bought', async () => {
    const d = deps(storeWithPurchase());
    const real = d.marketplace.requestEnvelopes.getMockImplementation()!;
    d.marketplace.requestEnvelopes
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        error: { error: 'batch_unavailable', message: 'not yet', details: { retryAfter: 60 } },
      })
      .mockImplementation(real);
    await runSubmitReview(args, d);
    expect(d.sleep).toHaveBeenCalledWith(60_000);
    expect(d.marketplace.requestEnvelopes).toHaveBeenCalledTimes(2);
  });

  it('gives up waiting after the bounded wait and says to retry later', async () => {
    const d = deps(storeWithPurchase());
    d.marketplace.requestEnvelopes.mockResolvedValue({
      ok: false,
      status: 503,
      error: { error: 'batch_unavailable', message: 'not yet', details: { retryAfter: 60 } },
    });
    await expectCode(runSubmitReview(args, d), 'batch_unavailable');
    expect(d.sleep).toHaveBeenCalledTimes(2); // 120 s max
  });

  it('passes quota exhaustion through with the self-funding hint', async () => {
    const d = deps(storeWithPurchase());
    d.marketplace.requestEnvelopes.mockResolvedValue({
      ok: false,
      status: 429,
      error: { error: 'envelope_quota_exceeded', message: 'used up' },
    });
    await runSubmitReview(args, d).catch((err: ReviewToolError) => {
      expect(err.code).toBe('envelope_quota_exceeded');
      expect(err.message).toContain('postageBatchId');
    });
  });

  it('resumes at giveFeedback after a failed transaction, without re-uploading', async () => {
    const store = storeWithPurchase();
    const first = deps(store, {
      postFeedback: jest.fn(async () => Promise.reject(new Error('nonce too low'))),
    });
    await expectCode(runSubmitReview(args, first), 'give_feedback_failed');
    expect(store.getPurchase(TX)!.reviewState).toBe('uploaded');

    const second = deps(store);
    const result = await runSubmitReview(args, second);
    expect(result.storage).toBe('resumed');
    expect(second.uploadChunks).not.toHaveBeenCalled();
    expect(second.marketplace.requestEnvelopes).not.toHaveBeenCalled();
    expect(result.feedbackURI).toBe(store.getPurchase(TX)!.feedbackUri);
    expect(result.reviewReference).toMatch(/^[0-9a-f]{64}$/);
  });

  it('republishes instead of resuming when the review changed', async () => {
    const store = storeWithPurchase();
    await runSubmitReview(
      args,
      deps(store, { postFeedback: jest.fn(async () => Promise.reject(new Error('x'))) }),
    ).catch(() => undefined);
    const second = deps(store, { nextFeedIndex: jest.fn(async () => 1n) });
    const result = await runSubmitReview({ ...args, comment: 'Changed my mind' }, second);
    expect(result.storage).toBe('marketplace-envelopes');
    expect(result.feedIndex).toBe('1');
  });

  it('maps an unfunded buyer wallet to insufficient_gas', async () => {
    const err = Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS' });
    const d = deps(storeWithPurchase(), { postFeedback: jest.fn(async () => Promise.reject(err)) });
    await expectCode(runSubmitReview(args, d), 'insufficient_gas');
  });
});
