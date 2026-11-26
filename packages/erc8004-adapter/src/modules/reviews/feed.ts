/**
 * Writing a review to the reviewer's own feed, with stamps someone else paid for.
 *
 * The content chunks and the feed update (SOC) are built locally so their addresses are known
 * before any stamp exists — that is what lets the marketplace issue envelopes against addresses
 * without seeing the review. Only public bee-js 12 APIs are used.
 */
import {
  Bee,
  BeeResponseError,
  MerkleTree,
  type BatchId,
  type EnvelopeWithBatchId,
  type SingleOwnerChunk,
} from '@ethersphere/bee-js';
import { computeAddress, concat, getAddress, getBytes, hexlify, toBeHex } from 'ethers';
import { feedIdentifier } from './identifiers';
import type { PreparedChunk } from './types';

/** Feed-update payload: 8-byte big-endian unix timestamp ‖ 32-byte reference (40 bytes). */
const FEED_PAYLOAD_LENGTH = 40;
const TIMESTAMP_LENGTH = 8;

export interface PreparedReviewUpload {
  reference: string; // R: root of the review file, 64-hex
  contentChunks: PreparedChunk[];
  identifier: string; // 0x-prefixed feed-update identifier
  socAddress: string; // 64-hex
  soc: SingleOwnerChunk;
  /** Every address that needs a stamp: content chunks + the feed update. */
  chunkAddresses: string[];
}

/** Splits bytes into Swarm chunks (BMT tree). The last chunk emitted is the root. */
export async function buildContentChunks(
  data: Uint8Array,
): Promise<{ reference: string; chunks: PreparedChunk[] }> {
  const byAddress = new Map<string, PreparedChunk>();
  const tree = new MerkleTree(async (chunk) => {
    const address = hexlify(chunk.hash()).slice(2);
    byAddress.set(address, { address, data: chunk.build() });
  });
  await tree.append(data);
  const root = await tree.finalize();
  return { reference: hexlify(root.hash()).slice(2), chunks: [...byAddress.values()] };
}

/**
 * Builds every chunk of a review upload without touching the network (bee-js only needs the
 * instance for its chunk helpers).
 */
export async function prepareReviewUpload(params: {
  bee: Bee;
  reviewBytes: Uint8Array;
  signerPrivateKey: string;
  topic: string;
  index: bigint;
  timestamp?: number; // unix seconds; default now
}): Promise<PreparedReviewUpload> {
  const { reference, chunks } = await buildContentChunks(params.reviewBytes);

  const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
  const payload = getBytes(concat([toBeHex(timestamp, TIMESTAMP_LENGTH), `0x${reference}`]));
  const identifier = feedIdentifier(params.topic, params.index);

  const cac = params.bee.makeContentAddressedChunk(payload);
  const soc = cac.toSingleOwnerChunk(
    identifier.slice(2),
    params.signerPrivateKey.replace(/^0x/, ''),
  );

  const owner = getAddress(computeAddress(params.signerPrivateKey));
  const socAddress = soc.address.toHex();
  // Sanity: the address the stamp is requested for must be the one Bee will store it under.
  const expected = params.bee.calculateSingleOwnerChunkAddress(soc.identifier, soc.owner).toHex();
  if (expected !== socAddress || soc.owner.toHex().toLowerCase() !== owner.slice(2).toLowerCase()) {
    throw new Error('Prepared SOC does not match its owner/identifier');
  }

  return {
    reference,
    contentChunks: chunks,
    identifier,
    socAddress,
    soc,
    chunkAddresses: [...chunks.map((c) => c.address), socAddress],
  };
}

/**
 * Uploads the prepared chunks. `stampFor` returns, per address, a marketplace envelope or the
 * reviewer's own batch id (self-funded fallback).
 *
 * The feed update goes to Bee's `/soc` endpoint (via `makeSOCWriter`), not `/chunks`: `/chunks`
 * addresses whatever it receives as a content chunk, so an envelope signed for the SOC address
 * fails there with "stamp signature is invalid". The writer re-signs the same identifier and
 * payload with the same key, so the SOC lands at `prepared.socAddress`.
 */
export async function uploadReviewChunks(
  bee: Bee,
  prepared: PreparedReviewUpload,
  stampFor: (address: string) => EnvelopeWithBatchId | BatchId | string,
  signerPrivateKey: string,
): Promise<void> {
  for (const chunk of prepared.contentChunks) {
    await bee.uploadChunk(stampFor(chunk.address), chunk.data);
  }
  await bee.makeSOCWriter(signerPrivateKey.replace(/^0x/, '')).upload(
    // bee-js 12 types omit envelopes here, but the request path sends them as
    // `swarm-postage-stamp` exactly like uploadChunk does.
    stampFor(prepared.socAddress) as BatchId | string,
    prepared.identifier.slice(2),
    prepared.soc.payload.toUint8Array(),
  );
}

/** Next free index on `owner`'s feed for `topic` (0 when the feed is empty). */
export async function nextFeedIndex(bee: Bee, owner: string, topic: string): Promise<bigint> {
  try {
    const { feedIndexNext } = await bee.makeFeedReader(topic.slice(2), owner).downloadPayload();
    if (!feedIndexNext) throw new Error('Bee did not return the next feed index');
    return feedIndexNext.toBigInt();
  } catch (err) {
    if (err instanceof BeeResponseError && err.status === 404) return 0n;
    throw err;
  }
}

/** Reads R out of a feed-update payload; null if it is not the 40-byte layout. */
export function referenceFromFeedPayload(payload: Uint8Array): string | null {
  if (payload.length !== FEED_PAYLOAD_LENGTH) return null;
  return hexlify(payload.slice(TIMESTAMP_LENGTH)).slice(2);
}
