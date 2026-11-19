import { AbiCoder, Wallet, keccak256, toUtf8Bytes, concat } from 'ethers';
import {
  encodeFeedbackURI,
  feedIdentifier,
  parseCaip10,
  parseFeedbackURI,
  reviewFeedTopic,
  toCaip10,
} from '../src/modules/reviews/identifiers';

describe('reviewFeedTopic', () => {
  it('is keccak256("swarm-ai-review.v1" ‖ agentId as uint256)', () => {
    const agentIdWord = AbiCoder.defaultAbiCoder().encode(['uint256'], [42n]);
    const expected = keccak256(concat([toUtf8Bytes('swarm-ai-review.v1'), agentIdWord]));
    expect(reviewFeedTopic(42n)).toBe(expected);
  });

  it('gives each seller its own topic', () => {
    expect(reviewFeedTopic(1n)).not.toBe(reviewFeedTopic(2n));
  });
});

describe('feedIdentifier', () => {
  it('is keccak256(topic ‖ index as 8-byte big-endian)', () => {
    const topic = reviewFeedTopic(7n);
    const index = 258n; // 0x0102 — catches byte-order mistakes
    const expected = keccak256(concat([topic, '0x0000000000000102']));
    expect(feedIdentifier(topic, index)).toBe(expected);
  });

  it('rejects indexes that do not fit 8 bytes', () => {
    expect(() => feedIdentifier(reviewFeedTopic(1n), 2n ** 64n)).toThrow();
    expect(() => feedIdentifier(reviewFeedTopic(1n), -1n)).toThrow();
  });
});

describe('feedbackURI', () => {
  const owner = Wallet.createRandom().address;
  const topic = reviewFeedTopic(42n);

  it('round-trips', () => {
    const uri = encodeFeedbackURI({ owner, topic, index: 3n });
    expect(uri).toBe(`swarm-feed://${owner}/${topic.slice(2)}/3`);
    expect(parseFeedbackURI(uri)).toEqual({ owner, topic, index: 3n });
  });

  it('accepts a lowercase owner and normalises it', () => {
    const uri = `swarm-feed://${owner.toLowerCase()}/${topic.slice(2)}/0`;
    expect(parseFeedbackURI(uri)?.owner).toBe(owner);
  });

  it.each([
    ['wrong scheme', `bzz://${owner}/${topic.slice(2)}/0`],
    ['0x-prefixed topic', `swarm-feed://${owner}/${topic}/0`],
    ['short topic', `swarm-feed://${owner}/abcd/0`],
    ['leading zero index', `swarm-feed://${owner}/${topic.slice(2)}/01`],
    ['negative index', `swarm-feed://${owner}/${topic.slice(2)}/-1`],
    ['index past uint64', `swarm-feed://${owner}/${topic.slice(2)}/${2n ** 64n}`],
    ['trailing slash', `swarm-feed://${owner}/${topic.slice(2)}/0/`],
  ])('rejects %s', (_, uri) => {
    expect(parseFeedbackURI(uri)).toBeNull();
  });
});

describe('CAIP-10', () => {
  it('round-trips with a checksummed address', () => {
    const address = Wallet.createRandom().address;
    const caip = toCaip10(84532n, address.toLowerCase());
    expect(caip).toBe(`eip155:84532:${address}`);
    expect(parseCaip10(caip)).toEqual({ chainId: 84532n, address });
  });

  it('rejects other namespaces and malformed values', () => {
    expect(parseCaip10('solana:1:abc')).toBeNull();
    expect(parseCaip10('eip155:84532:0x1234')).toBeNull();
  });
});
