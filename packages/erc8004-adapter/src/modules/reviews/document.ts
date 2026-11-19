/** Building, serializing and hashing the review file. */
import { getAddress, hexlify, keccak256, randomBytes, toUtf8Bytes, toUtf8String } from 'ethers';
import { toCaip10 } from './identifiers';
import type { ProofOfPayment, ReviewDocument } from './types';

export interface BuildReviewParams {
  chainId: bigint;
  identityRegistry: string;
  agentId: bigint;
  clientAddress: string;
  value: bigint;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  comment?: string;
  proofOfPayment: ProofOfPayment;
  createdAt?: Date;
  salt?: string; // tests only — production reviews always get a fresh one
}

export function buildReview(params: BuildReviewParams): ReviewDocument {
  const review: ReviewDocument = {
    agentRegistry: toCaip10(params.chainId, params.identityRegistry),
    agentId: toSafeNumber(params.agentId, 'agentId'),
    clientAddress: toCaip10(params.chainId, params.clientAddress),
    createdAt: (params.createdAt ?? new Date()).toISOString(),
    value: toSafeNumber(params.value, 'value'),
    valueDecimals: params.valueDecimals,
    salt: params.salt ?? hexlify(randomBytes(32)),
    proofOfPayment: {
      ...params.proofOfPayment,
      fromAddress: getAddress(params.proofOfPayment.fromAddress),
      toAddress: getAddress(params.proofOfPayment.toAddress),
    },
  };
  if (params.tag1) review.tag1 = params.tag1;
  if (params.tag2) review.tag2 = params.tag2;
  if (params.comment) review.comment = params.comment;
  return review;
}

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. The hash commits to these exact
 * bytes, so writer and verifier must never re-serialize differently.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function serializeReview(review: ReviewDocument): Uint8Array {
  return toUtf8Bytes(canonicalJson(review));
}

/** `feedbackHash` = keccak256 of the review file's bytes. */
export function reviewHash(bytes: Uint8Array): string {
  return keccak256(bytes);
}

/** Parses review bytes and checks the shape. Throws on anything malformed. */
export function parseReview(bytes: Uint8Array): ReviewDocument {
  const json = JSON.parse(toUtf8String(bytes)) as Record<string, unknown>;
  const pop = json.proofOfPayment as Record<string, unknown> | undefined;
  const intent = pop?.purchaseIntent as Record<string, unknown> | undefined;

  const ok =
    typeof json.agentRegistry === 'string' &&
    Number.isSafeInteger(json.agentId) &&
    typeof json.clientAddress === 'string' &&
    typeof json.createdAt === 'string' &&
    Number.isSafeInteger(json.value) &&
    Number.isInteger(json.valueDecimals) &&
    typeof json.salt === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(json.salt) &&
    typeof pop?.fromAddress === 'string' &&
    typeof pop?.toAddress === 'string' &&
    typeof pop?.chainId === 'string' &&
    typeof pop?.txHash === 'string' &&
    typeof intent?.signature === 'string' &&
    typeof intent?.domain === 'object' &&
    typeof intent?.message === 'object';
  if (!ok) throw new Error('Review file is missing required fields');
  return json as unknown as ReviewDocument;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function toSafeNumber(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${name} does not fit a JSON number: ${value}`);
  }
  return Number(value);
}
