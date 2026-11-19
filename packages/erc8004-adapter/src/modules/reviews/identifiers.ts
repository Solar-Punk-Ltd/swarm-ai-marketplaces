/**
 * Naming for review feeds: the per-seller topic, the `swarm-feed://` feedbackURI, feed-update
 * identifiers and CAIP-10 addresses. Pure functions — no network.
 */
import { concat, getAddress, isAddress, keccak256, solidityPacked, toBeHex } from 'ethers';
import type { FeedCoordinates } from './types';

export const REVIEW_TOPIC_PREFIX = 'swarm-ai-review.v1';
export const FEEDBACK_URI_SCHEME = 'swarm-feed://';

/**
 * One review feed per buyer per seller: `keccak256("swarm-ai-review.v1" ‖ agentId)`, with `agentId`
 * as a 32-byte big-endian uint256 (`abi.encodePacked(string, uint256)`).
 */
export function reviewFeedTopic(agentId: bigint): string {
  return keccak256(solidityPacked(['string', 'uint256'], [REVIEW_TOPIC_PREFIX, agentId]));
}

/**
 * Feed-update identifier: `keccak256(topic ‖ index as 8-byte big-endian)`. Same derivation as
 * bee-js's internal `makeFeedIdentifier`, which bee-js 12 does not export.
 */
export function feedIdentifier(topic: string, index: bigint): string {
  if (index < 0n || index >= 2n ** 64n) throw new Error(`Feed index out of range: ${index}`);
  return keccak256(concat([topic, toBeHex(index, 8)]));
}

/** `swarm-feed://<owner>/<topic>/<index>` — pins one feed update, never "latest". */
export function encodeFeedbackURI({ owner, topic, index }: FeedCoordinates): string {
  if (!isAddress(owner)) throw new Error(`Not an address: ${owner}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new Error(`Topic must be 32-byte hex: ${topic}`);
  return `${FEEDBACK_URI_SCHEME}${getAddress(owner)}/${topic.slice(2).toLowerCase()}/${index}`;
}

/** Strict inverse of `encodeFeedbackURI`; null on anything malformed. */
export function parseFeedbackURI(uri: string): FeedCoordinates | null {
  const match = /^swarm-feed:\/\/(0x[0-9a-fA-F]{40})\/([0-9a-fA-F]{64})\/(0|[1-9][0-9]*)$/.exec(
    uri,
  );
  if (!match) return null;
  const index = BigInt(match[3]);
  if (index >= 2n ** 64n) return null;
  return { owner: getAddress(match[1]), topic: `0x${match[2].toLowerCase()}`, index };
}

/** CAIP-10 account id: `eip155:<chainId>:<checksummed address>`. */
export function toCaip10(chainId: bigint, address: string): string {
  return `eip155:${chainId}:${getAddress(address)}`;
}

export function parseCaip10(value: string): { chainId: bigint; address: string } | null {
  const match = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/.exec(value);
  if (!match) return null;
  return { chainId: BigInt(match[1]), address: getAddress(match[2]) };
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
