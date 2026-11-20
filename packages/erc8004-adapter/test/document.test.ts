import { keccak256, toUtf8Bytes } from 'ethers';
import {
  buildReview,
  canonicalJson,
  parseReview,
  reviewHash,
  serializeReview,
} from '../src/modules/reviews/document';
import { CHAIN_ID, IDENTITY_REGISTRY, buyer, signedProofOfPayment } from './fixtures';

async function review(overrides: Partial<Parameters<typeof buildReview>[0]> = {}) {
  return buildReview({
    chainId: CHAIN_ID,
    identityRegistry: IDENTITY_REGISTRY,
    agentId: 42n,
    clientAddress: buyer.address.toLowerCase(),
    value: 85n,
    valueDecimals: 0,
    comment: 'Dataset matched its description.',
    proofOfPayment: await signedProofOfPayment(),
    createdAt: new Date('2026-11-17T10:00:00Z'),
    ...overrides,
  });
}

describe('canonicalJson', () => {
  it('sorts keys recursively so key order never changes the hash', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[{"x":2,"y":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe('buildReview', () => {
  it('fills the ERC-8004 fields in CAIP-10 form', async () => {
    const r = await review();
    expect(r.agentRegistry).toBe(`eip155:84532:${IDENTITY_REGISTRY}`);
    expect(r.clientAddress).toBe(`eip155:84532:${buyer.address}`);
    expect(r).toMatchObject({ agentId: 42, value: 85, valueDecimals: 0 });
    expect(r.createdAt).toBe('2026-11-17T10:00:00.000Z');
  });

  it('adds a fresh 32-byte salt to every review', async () => {
    const [a, b] = await Promise.all([review(), review()]);
    expect(a.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.salt).not.toBe(b.salt);
  });

  it('omits empty optional fields', async () => {
    const r = await review({ comment: undefined, tag1: '', tag2: undefined });
    expect(r).not.toHaveProperty('comment');
    expect(r).not.toHaveProperty('tag1');
    expect(r).not.toHaveProperty('tag2');
  });

  it('refuses values that would lose precision as JSON numbers', async () => {
    await expect(review({ agentId: 2n ** 60n })).rejects.toThrow('agentId');
  });
});

describe('serialize / hash / parse', () => {
  it('hashes the canonical bytes and parses them back', async () => {
    const r = await review();
    const bytes = serializeReview(r);
    expect(reviewHash(bytes)).toBe(keccak256(toUtf8Bytes(canonicalJson(r))));
    expect(parseReview(bytes)).toEqual(r);
  });

  it('rejects files without the mandatory salt or purchase intent', async () => {
    const r = await review();
    const { salt: _salt, ...noSalt } = r;
    expect(() => parseReview(toUtf8Bytes(JSON.stringify(noSalt)))).toThrow();
    const noIntent = { ...r, proofOfPayment: { ...r.proofOfPayment, purchaseIntent: undefined } };
    expect(() => parseReview(toUtf8Bytes(JSON.stringify(noIntent)))).toThrow();
  });
});
