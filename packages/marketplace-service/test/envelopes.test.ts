import { BatchId } from '@ethersphere/bee-js';
import {
  envelopeRequestDomain,
  signEnvelopeRequest,
  type PoPResult,
  type ProofOfPayment,
} from '@solarpunk/erc8004-adapter';
import { Wallet, hexlify, randomBytes } from 'ethers';
import { Store } from '../src/db.js';
import { issueEnvelopes, type EnvelopeDeps } from '../src/envelopes.js';
import { ServiceError } from '../src/errors.js';

const CHAIN_ID = 84532n;
const FACTORY = Wallet.createRandom().address;
const NOW = 1_800_000_000;
const BATCH = 'ba'.repeat(32);
const SETTLEMENT_BLOCK = 4_242;

const buyer = Wallet.createRandom();
const domain = envelopeRequestDomain(CHAIN_ID, FACTORY);

function proofOfPayment(txHash = hexlify(randomBytes(32))): ProofOfPayment {
  return {
    fromAddress: buyer.address,
    toAddress: Wallet.createRandom().address,
    chainId: CHAIN_ID.toString(),
    txHash,
    purchaseIntent: {
      domain: { name: 'x', version: '1', chainId: 84532, verifyingContract: FACTORY },
      message: {} as ProofOfPayment['purchaseIntent']['message'],
      signature: '0x00',
    },
  };
}

const chunks = (n: number) => Array.from({ length: n }, () => hexlify(randomBytes(32)).slice(2));

async function body(
  opts: {
    signer?: Wallet;
    pop?: ProofOfPayment;
    chunkAddresses?: string[];
    timestamp?: number;
    agentId?: string;
    signDomain?: typeof domain;
  } = {},
) {
  const pop = opts.pop ?? proofOfPayment();
  const chunkAddresses = opts.chunkAddresses ?? chunks(2);
  const timestamp = opts.timestamp ?? NOW;
  const agentId = opts.agentId ?? '42';
  const signature = await signEnvelopeRequest(
    (opts.signer ?? buyer) as unknown as Wallet,
    opts.signDomain ?? domain,
    { agentId: BigInt(agentId), txHash: pop.txHash, chunkAddresses, timestamp: BigInt(timestamp) },
  );
  return { agentId, proofOfPayment: pop, chunkAddresses, timestamp, signature };
}

function deps(overrides: Partial<EnvelopeDeps> = {}): EnvelopeDeps & { store: Store } {
  const store = new Store(':memory:');
  return {
    config: {
      chainId: CHAIN_ID,
      splitterFactory: FACTORY,
      maxChunksPerRequest: 4,
      maxEnvelopesPerPurchase: 6,
      requestMaxAgeSeconds: 300,
    },
    store,
    batches: { usableBatch: jest.fn(async () => ({ batchId: BATCH })) },
    bee: {
      createEnvelope: jest.fn(async () => ({
        batchId: new BatchId(BATCH),
        issuer: randomBytes(20),
        index: randomBytes(8),
        timestamp: randomBytes(8),
        signature: randomBytes(65),
      })),
    },
    // Like the real verifyPoP: only the payer passes.
    verifyPoP: jest.fn(
      async ({ clientAddress }): Promise<PoPResult> =>
        clientAddress === buyer.address
          ? {
              valid: true,
              splitter: FACTORY,
              seller: FACTORY,
              token: FACTORY,
              amount: 5_000n,
              settlementBlock: SETTLEMENT_BLOCK,
              settlementLogIndex: 1,
              itemId: 'ab'.repeat(32),
            }
          : { valid: false, reason: 'wrong_payer' },
    ),
    findAnchoredPurchase: jest.fn(async () => null),
    nowSeconds: () => NOW,
    ...overrides,
  } as EnvelopeDeps & { store: Store };
}

async function expectError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(ServiceError);
  await promise.catch((err: ServiceError) => expect(err.code).toBe(code));
}

describe('issueEnvelopes', () => {
  it('issues one envelope per chunk address for a valid, signed request', async () => {
    const d = deps();
    const b = await body();
    const res = await issueEnvelopes(d, b);

    expect(res.batchId).toBe(BATCH);
    expect(res.envelopes.map((e) => e.address)).toEqual(b.chunkAddresses);
    expect(d.bee.createEnvelope).toHaveBeenCalledTimes(2);
    expect(d.verifyPoP).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 42n, clientAddress: buyer.address }),
    );
    expect(d.findAnchoredPurchase).toHaveBeenCalledWith({
      agentId: 42n,
      clientAddress: buyer.address,
      txHash: b.proofOfPayment.txHash,
      fromBlock: SETTLEMENT_BLOCK,
    });
  });

  it('accepts 0x-prefixed chunk addresses and returns them normalized', async () => {
    const addresses = chunks(1).map((a) => `0x${a.toUpperCase()}`);
    const res = await issueEnvelopes(deps(), await body({ chunkAddresses: addresses }));
    expect(res.envelopes[0].address).toBe(addresses[0].slice(2).toLowerCase());
  });

  it.each([
    ['no body', null],
    ['bad agentId', { agentId: '-1' }],
    ['no chunks', { chunkAddresses: [] }],
    ['short chunk address', { chunkAddresses: ['abcd'] }],
    ['no purchaseIntent', { proofOfPayment: { ...proofOfPayment(), purchaseIntent: undefined } }],
  ])('rejects a malformed request (%s)', async (_, patch) => {
    const b = patch === null ? null : { ...(await body()), ...patch };
    await expectError(issueEnvelopes(deps(), b), 'bad_request');
  });

  it('rejects duplicate chunk addresses', async () => {
    const [a] = chunks(1);
    await expectError(
      issueEnvelopes(deps(), await body({ chunkAddresses: [a, a] })),
      'bad_request',
    );
  });

  it('caps chunk addresses per request', async () => {
    await expectError(
      issueEnvelopes(deps(), await body({ chunkAddresses: chunks(5) })),
      'too_many_chunks',
    );
  });

  it('rejects stale requests', async () => {
    await expectError(
      issueEnvelopes(deps(), await body({ timestamp: NOW - 301 })),
      'request_expired',
    );
  });

  it('rejects an unparseable signature', async () => {
    const b = { ...(await body()), signature: '0x1234' };
    await expectError(issueEnvelopes(deps(), b), 'bad_request_signature');
  });

  it('refuses a seller replaying the buyer’s PoP with its own signature', async () => {
    const seller = Wallet.createRandom();
    const d = deps();
    await expectError(
      issueEnvelopes(d, await body({ signer: seller as unknown as Wallet })),
      'pop_invalid',
    );
    expect(d.bee.createEnvelope).not.toHaveBeenCalled();
  });

  it('refuses a request signed for another marketplace', async () => {
    const otherDomain = envelopeRequestDomain(CHAIN_ID, Wallet.createRandom().address);
    await expectError(
      issueEnvelopes(deps(), await body({ signDomain: otherDomain })),
      'pop_invalid',
    );
  });

  it('passes the PoP failure reason through', async () => {
    const d = deps({
      verifyPoP: jest.fn(async () => ({ valid: false, reason: 'below_value_floor' }) as PoPResult),
    });
    await issueEnvelopes(d, await body()).catch((err: ServiceError) => {
      expect(err.code).toBe('pop_invalid');
      expect(err.details).toEqual({ reason: 'below_value_floor' });
    });
  });

  it('refuses a purchase that already has a non-revoked review', async () => {
    const anchored = { event: { feedbackIndex: 3n }, review: {} } as never;
    const d = deps({ findAnchoredPurchase: jest.fn(async () => anchored) });
    await expectError(issueEnvelopes(d, await body()), 'pop_already_claimed');
  });

  it('answers batch_unavailable with retryAfter while the seller batch is bought', async () => {
    const d = deps({ batches: { usableBatch: jest.fn(async () => ({ retryAfter: 60 })) } });
    await issueEnvelopes(d, await body()).catch((err: ServiceError) => {
      expect(err.code).toBe('batch_unavailable');
      expect(err.details).toEqual({ retryAfter: 60 });
    });
    // Nothing was counted against the purchase.
    expect(d.store.reserveEnvelopes('0x' + '00'.repeat(32), buyer.address, '42', 6, 6).ok).toBe(
      true,
    );
  });

  it('allows retries until the per-purchase quota is used up', async () => {
    const d = deps();
    const pop = proofOfPayment();
    await issueEnvelopes(d, await body({ pop, chunkAddresses: chunks(4) }));
    await issueEnvelopes(d, await body({ pop, chunkAddresses: chunks(2) })); // 6 of 6
    await expectError(
      issueEnvelopes(d, await body({ pop, chunkAddresses: chunks(1) })),
      'envelope_quota_exceeded',
    );
  });

  it('gives the reservation back when Bee fails to create envelopes', async () => {
    const d = deps({
      bee: { createEnvelope: jest.fn(async () => Promise.reject(new Error('bee down'))) },
    });
    const pop = proofOfPayment();
    await expect(issueEnvelopes(d, await body({ pop, chunkAddresses: chunks(4) }))).rejects.toThrow(
      'bee down',
    );
    expect(d.store.reserveEnvelopes(pop.txHash, buyer.address, '42', 6, 6).ok).toBe(true);
  });
});
