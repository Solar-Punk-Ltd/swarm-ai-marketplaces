/**
 * Writer → reader round trip: chunks built by the writer helpers, served by an in-memory Bee,
 * checked by verifyReview / findAnchoredPurchase.
 */
import { Bee, MerkleTree, type Bytes } from '@ethersphere/bee-js';
import { Wallet, concat, getBytes, hexlify, keccak256, verifyMessage } from 'ethers';
import { buildReview, serializeReview, reviewHash } from '../src/modules/reviews/document';
import {
  buildContentChunks,
  prepareReviewUpload,
  referenceFromFeedPayload,
  uploadReviewChunks,
  type PreparedReviewUpload,
} from '../src/modules/reviews/feed';
import {
  encodeFeedbackURI,
  feedIdentifier,
  reviewFeedTopic,
} from '../src/modules/reviews/identifiers';
import { findAnchoredPurchase, verifyReview } from '../src/modules/reviews/verify';
import type { ReputationModule } from '../src/modules/reputation';
import type { NewFeedbackEvent } from '../src/types';
import { CHAIN_ID, IDENTITY_REGISTRY, buyer, config, signedProofOfPayment } from './fixtures';

const bee = new Bee('http://localhost:1633'); // only its pure chunk helpers are used
const AGENT_ID = 42n;
const topic = reviewFeedTopic(AGENT_ID);

/** In-memory Bee: serves SOCs by (owner, identifier) and data by reference. */
class FakeBee {
  socs = new Map<string, Uint8Array>();
  data = new Map<string, Uint8Array>();

  store(prepared: PreparedReviewUpload, reviewBytes: Uint8Array) {
    const key = `${prepared.soc.owner.toHex()}:${prepared.identifier.slice(2)}`;
    this.socs.set(key.toLowerCase(), prepared.soc.payload.toUint8Array());
    this.data.set(prepared.reference, reviewBytes);
  }

  makeSOCReader(owner: string) {
    return {
      download: async (identifier: string) => {
        const payload = this.socs.get(`${owner.slice(2)}:${identifier}`.toLowerCase());
        if (!payload) throw new Error('404');
        return { payload: { toUint8Array: () => payload } };
      },
    };
  }

  async downloadData(reference: string) {
    const bytes = this.data.get(reference);
    if (!bytes) throw new Error('404');
    return { toUint8Array: () => bytes } as unknown as Bytes;
  }
}

async function publish(
  fake: FakeBee,
  opts: { index: bigint; value?: bigint; signer?: Wallet; txHash?: string; agentId?: bigint } = {
    index: 0n,
  },
) {
  const signer = opts.signer ?? (buyer as unknown as Wallet);
  const pop = await signedProofOfPayment();
  if (opts.txHash) pop.txHash = opts.txHash;
  const review = buildReview({
    chainId: CHAIN_ID,
    identityRegistry: IDENTITY_REGISTRY,
    agentId: opts.agentId ?? AGENT_ID,
    clientAddress: signer.address,
    value: opts.value ?? 85n,
    valueDecimals: 0,
    comment: 'Good data',
    proofOfPayment: pop,
  });
  const bytes = serializeReview(review);
  const prepared = await prepareReviewUpload({
    bee,
    reviewBytes: bytes,
    signerPrivateKey: signer.privateKey,
    topic: reviewFeedTopic(opts.agentId ?? AGENT_ID),
    index: opts.index,
    timestamp: 1_800_000_000,
  });
  fake.store(prepared, bytes);
  const entry: NewFeedbackEvent = {
    agentId: AGENT_ID,
    clientAddress: signer.address,
    feedbackIndex: opts.index + 1n,
    value: review.value === undefined ? 0n : BigInt(review.value),
    valueDecimals: 0,
    tag1: '',
    tag2: '',
    endpoint: '',
    feedbackURI: encodeFeedbackURI({
      owner: signer.address,
      topic: reviewFeedTopic(opts.agentId ?? AGENT_ID),
      index: opts.index,
    }),
    feedbackHash: reviewHash(bytes),
    blockNumber: 100 + Number(opts.index),
    logIndex: 0,
    transactionHash: hexlify(new Uint8Array(32)),
  };
  return { review, bytes, prepared, entry, pop };
}

const deps = (fake: FakeBee) => ({ bee: fake as unknown as Bee, config });

describe('content chunks', () => {
  it('uses a single chunk, addressed like bee-js, for small files', async () => {
    const data = new TextEncoder().encode('{"hello":"swarm"}');
    const { reference, chunks } = await buildContentChunks(data);
    expect(chunks).toHaveLength(1);
    expect(reference).toBe(bee.makeContentAddressedChunk(data).address.toHex());
  });

  it('builds the full BMT tree for files over 4 KB', async () => {
    const data = getBytes(hexlify(new Uint8Array(10_000).map((_, i) => i % 251)));
    const { reference, chunks } = await buildContentChunks(data);
    expect(chunks.length).toBe(4); // 3 leaves + 1 intermediate root
    expect(reference).toBe(hexlify((await MerkleTree.root(data)).hash()).slice(2));
    expect(chunks.map((c) => c.address)).toContain(reference);
  });
});

describe('prepareReviewUpload', () => {
  it('builds a feed update signed by the reviewer with payload timestamp ‖ R', async () => {
    const { prepared } = await publish(new FakeBee(), { index: 5n });
    const payload = prepared.soc.payload.toUint8Array();
    expect(payload).toHaveLength(40);
    expect(hexlify(payload.slice(0, 8))).toBe('0x000000006b49d200'); // 1_800_000_000
    expect(referenceFromFeedPayload(payload)).toBe(prepared.reference);

    const identifier = feedIdentifier(topic, 5n);
    expect(prepared.identifier).toBe(identifier);
    expect(prepared.socAddress).toBe(keccak256(concat([identifier, buyer.address])).slice(2));
    expect(prepared.soc.owner.toHex()).toBe(buyer.address.slice(2).toLowerCase());
    expect(prepared.chunkAddresses).toEqual([prepared.reference, prepared.socAddress]);
  });

  it('signs keccak256(identifier ‖ CAC address) with the reviewer key, as Bee verifies SOCs', async () => {
    const { prepared } = await publish(new FakeBee(), { index: 1n });
    const data = prepared.soc.data;
    const identifier = hexlify(data.slice(0, 32));
    const signature = hexlify(data.slice(32, 97));
    const cacAddress = bee
      .makeContentAddressedChunk(prepared.soc.payload.toUint8Array())
      .address.toHex();
    const digest = getBytes(keccak256(concat([identifier, `0x${cacAddress}`])));
    expect(verifyMessage(digest, signature)).toBe(buyer.address);
  });
});

describe('uploadReviewChunks', () => {
  it('sends content chunks to /chunks and the feed update to /soc, each with its own stamp', async () => {
    const { prepared } = await publish(new FakeBee(), { index: 2n });
    const socUpload = jest.fn(async () => ({}));
    const fakeBee = {
      uploadChunk: jest.fn(async () => ({})),
      makeSOCWriter: jest.fn(() => ({ upload: socUpload })),
    };
    const stampFor = (address: string) => `stamp-${address}`;

    await uploadReviewChunks(fakeBee as unknown as Bee, prepared, stampFor, buyer.privateKey);

    expect(fakeBee.uploadChunk.mock.calls).toEqual(
      prepared.contentChunks.map((c) => [`stamp-${c.address}`, c.data]),
    );
    expect(fakeBee.makeSOCWriter).toHaveBeenCalledWith(buyer.privateKey.slice(2));
    expect(socUpload).toHaveBeenCalledWith(
      `stamp-${prepared.socAddress}`,
      prepared.identifier.slice(2),
      prepared.soc.payload.toUint8Array(),
    );
  });
});

describe('verifyReview', () => {
  it('accepts an authentic review that matches its on-chain entry', async () => {
    const fake = new FakeBee();
    const { entry, review, prepared } = await publish(fake, { index: 0n });
    expect(await verifyReview(entry, deps(fake))).toEqual({
      valid: true,
      review,
      reference: prepared.reference,
    });
  });

  it('rejects a feedbackURI owned by someone other than the client', async () => {
    const fake = new FakeBee();
    const { entry } = await publish(fake, { index: 0n });
    const other = { ...entry, clientAddress: Wallet.createRandom().address };
    expect(await verifyReview(other, deps(fake))).toMatchObject({ reason: 'uri_owner_mismatch' });
  });

  it('rejects a review filed under another seller’s topic', async () => {
    const fake = new FakeBee();
    const { entry } = await publish(fake, { index: 0n, agentId: 7n });
    expect(await verifyReview(entry, deps(fake))).toMatchObject({ reason: 'topic_mismatch' });
  });

  it('rejects content that does not match feedbackHash', async () => {
    const fake = new FakeBee();
    const { entry, prepared, bytes } = await publish(fake, { index: 0n });
    const tampered = new Uint8Array(bytes);
    tampered[10] ^= 1;
    fake.data.set(prepared.reference, tampered);
    expect(await verifyReview(entry, deps(fake))).toMatchObject({ reason: 'hash_mismatch' });
  });

  it('rejects a JSON score that differs from the on-chain value', async () => {
    const fake = new FakeBee();
    const { entry } = await publish(fake, { index: 0n });
    expect(await verifyReview({ ...entry, value: 10n }, deps(fake))).toMatchObject({
      reason: 'field_mismatch',
      detail: 'value',
    });
  });

  it('rejects a review for another marketplace’s registry', async () => {
    const fake = new FakeBee();
    const { entry } = await publish(fake, { index: 0n });
    const otherConfig = { ...config, identityRegistry: Wallet.createRandom().address };
    expect(
      await verifyReview(entry, { bee: fake as unknown as Bee, config: otherConfig }),
    ).toMatchObject({
      reason: 'field_mismatch',
      detail: 'agentRegistry',
    });
  });

  it('reports missing chunks as unavailable, not invalid', async () => {
    const fake = new FakeBee();
    const { entry } = await publish(fake, { index: 0n });
    fake.socs.clear();
    expect(await verifyReview(entry, deps(fake))).toMatchObject({ reason: 'soc_unavailable' });
  });
});

describe('findAnchoredPurchase', () => {
  const txHash = `0x${'77'.repeat(32)}`;

  function reputation(events: NewFeedbackEvent[], revokedIndexes: bigint[]) {
    return {
      getNewFeedbackEvents: jest.fn(async () => events),
      getFeedbackRevokedEvents: jest.fn(async () =>
        revokedIndexes.map((feedbackIndex) => ({ feedbackIndex })),
      ),
    } as unknown as ReputationModule;
  }

  it('returns the earliest non-revoked, verifiable review citing the purchase', async () => {
    const fake = new FakeBee();
    const other = await publish(fake, { index: 0n }); // cites another tx
    const revoked = await publish(fake, { index: 1n, txHash });
    const winner = await publish(fake, { index: 2n, txHash });
    const later = await publish(fake, { index: 3n, txHash });
    const rep = reputation(
      [later.entry, winner.entry, revoked.entry, other.entry],
      [revoked.entry.feedbackIndex],
    );

    const found = await findAnchoredPurchase(
      { reputation: rep, bee: fake as unknown as Bee, config },
      { agentId: AGENT_ID, clientAddress: buyer.address, txHash, fromBlock: 90 },
    );
    expect(found?.event).toBe(winner.entry);
    expect(rep.getNewFeedbackEvents).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ clientAddress: buyer.address, fromBlock: 90 }),
    );
  });

  it('frees the purchase once its review is revoked', async () => {
    const fake = new FakeBee();
    const revoked = await publish(fake, { index: 0n, txHash });
    const rep = reputation([revoked.entry], [revoked.entry.feedbackIndex]);
    expect(
      await findAnchoredPurchase(
        { reputation: rep, bee: fake as unknown as Bee, config },
        { agentId: AGENT_ID, clientAddress: buyer.address, txHash, fromBlock: 90 },
      ),
    ).toBeNull();
  });

  it('ignores entries whose content no longer resolves', async () => {
    const fake = new FakeBee();
    const expired = await publish(fake, { index: 0n, txHash });
    fake.data.clear();
    const rep = reputation([expired.entry], []);
    expect(
      await findAnchoredPurchase(
        { reputation: rep, bee: fake as unknown as Bee, config },
        { agentId: AGENT_ID, clientAddress: buyer.address, txHash, fromBlock: 90 },
      ),
    ).toBeNull();
  });
});
