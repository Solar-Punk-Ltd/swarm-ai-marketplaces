import type { Request, RequestHandler, Response } from 'express';
import type { EnvelopeWithBatchId } from '@ethersphere/bee-js';
import {
  envelopeRequestDomain,
  envelopeToWire,
  isEnvelopeRequestFresh,
  recoverEnvelopeRequestSigner,
  type AnchoredReview,
  type EnvelopeRequest,
  type PoPResult,
  type ProofOfPayment,
  type WireEnvelope,
} from '@solarpunk/erc8004-adapter';
import type { BatchLookup } from './batches.js';
import type { ServiceConfig } from './config.js';
import type { Store } from './db.js';
import { ServiceError, sendError } from './errors.js';

export interface EnvelopeDeps {
  config: Pick<
    ServiceConfig,
    | 'chainId'
    | 'splitterFactory'
    | 'maxChunksPerRequest'
    | 'maxEnvelopesPerPurchase'
    | 'requestMaxAgeSeconds'
  >;
  store: Store;
  batches: { usableBatch(agentId: bigint): Promise<BatchLookup> };
  bee: { createEnvelope(batchId: string, address: string): Promise<EnvelopeWithBatchId> };
  verifyPoP(input: {
    agentId: bigint;
    clientAddress: string;
    proofOfPayment: ProofOfPayment;
  }): Promise<PoPResult>;
  findAnchoredPurchase(params: {
    agentId: bigint;
    clientAddress: string;
    txHash: string;
    fromBlock: number;
  }): Promise<AnchoredReview | null>;
  nowSeconds?: () => number;
}

export interface EnvelopeResponse {
  batchId: string;
  envelopes: WireEnvelope[];
}

interface ParsedRequest {
  agentId: bigint;
  proofOfPayment: ProofOfPayment;
  chunkAddresses: string[]; // 64-hex, lowercase, no 0x
  timestamp: bigint;
  signature: string;
}

/**
 * POST /v1/reviews/envelopes — postage stamps for a review's chunks, issued against chunk
 * addresses only (the service never sees the score or text).
 *
 * Order: shape → chunk cap → freshness → reviewer signature → PoP → one review per purchase →
 * seller batch → per-purchase quota → envelopes.
 */
export function envelopesHandler(deps: EnvelopeDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      res.json(await issueEnvelopes(deps, req.body));
    } catch (err) {
      sendError(res, err);
    }
  };
}

export async function issueEnvelopes(deps: EnvelopeDeps, body: unknown): Promise<EnvelopeResponse> {
  const request = parseRequest(body);
  const { config } = deps;

  if (request.chunkAddresses.length > config.maxChunksPerRequest) {
    throw new ServiceError(
      'too_many_chunks',
      `At most ${config.maxChunksPerRequest} chunk addresses per request`,
      { maxChunksPerRequest: config.maxChunksPerRequest },
    );
  }

  const now = deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  if (!isEnvelopeRequestFresh(request.timestamp, config.requestMaxAgeSeconds, now)) {
    throw new ServiceError('request_expired', 'Request timestamp is outside the accepted window', {
      requestMaxAgeSeconds: config.requestMaxAgeSeconds,
    });
  }

  // Only the reviewer may request envelopes for their purchase: the seller saw the signed
  // PurchaseIntent at purchase time, so a valid PoP alone proves nothing about who is asking.
  const signed: EnvelopeRequest = {
    agentId: request.agentId,
    txHash: request.proofOfPayment.txHash,
    chunkAddresses: request.chunkAddresses,
    timestamp: request.timestamp,
  };
  let requester: string;
  try {
    requester = recoverEnvelopeRequestSigner(
      envelopeRequestDomain(config.chainId, config.splitterFactory),
      signed,
      request.signature,
    );
  } catch {
    throw new ServiceError('bad_request_signature', 'Envelope request signature is invalid');
  }

  // The requester must be the payer: verifyPoP checks the Transfer came from `requester`.
  const pop = await deps.verifyPoP({
    agentId: request.agentId,
    clientAddress: requester,
    proofOfPayment: request.proofOfPayment,
  });
  if (!pop.valid) {
    throw new ServiceError('pop_invalid', `Proof-of-Purchase rejected: ${pop.reason}`, {
      reason: pop.reason,
    });
  }

  // One review per purchase; a revoked review frees it again (edits).
  const anchored = await deps.findAnchoredPurchase({
    agentId: request.agentId,
    clientAddress: requester,
    txHash: request.proofOfPayment.txHash,
    fromBlock: pop.settlementBlock,
  });
  if (anchored) {
    throw new ServiceError('pop_already_claimed', 'This purchase already has a review', {
      feedbackIndex: anchored.event.feedbackIndex.toString(),
    });
  }

  const batch = await deps.batches.usableBatch(request.agentId);
  if ('retryAfter' in batch) {
    throw new ServiceError('batch_unavailable', "The seller's review batch is not usable yet", {
      retryAfter: batch.retryAfter,
    });
  }

  const count = request.chunkAddresses.length;
  const reservation = deps.store.reserveEnvelopes(
    request.proofOfPayment.txHash,
    requester,
    request.agentId.toString(),
    count,
    config.maxEnvelopesPerPurchase,
  );
  if (!reservation.ok) {
    if (reservation.reason === 'other_client') {
      throw new ServiceError(
        'pop_already_claimed',
        'Another address already requested envelopes for this purchase',
      );
    }
    throw new ServiceError(
      'envelope_quota_exceeded',
      'Envelope quota for this purchase is used up',
      {
        maxEnvelopesPerPurchase: config.maxEnvelopesPerPurchase,
        issued: reservation.issued,
      },
    );
  }

  let envelopes: WireEnvelope[];
  try {
    envelopes = await Promise.all(
      request.chunkAddresses.map(async (address) =>
        envelopeToWire(address, await deps.bee.createEnvelope(batch.batchId, address)),
      ),
    );
  } catch (err) {
    deps.store.releaseEnvelopes(request.proofOfPayment.txHash, count);
    throw err;
  }
  deps.store.recordEnvelopes(request.proofOfPayment.txHash, batch.batchId, request.chunkAddresses);

  return { batchId: batch.batchId, envelopes };
}

function parseRequest(body: unknown): ParsedRequest {
  const bad = (message: string): never => {
    throw new ServiceError('bad_request', message);
  };
  if (!body || typeof body !== 'object') bad('Body must be a JSON object');
  const b = body as Record<string, unknown>;

  const agentId = toBigInt(b.agentId) ?? bad('agentId must be a non-negative integer');
  const timestamp = toBigInt(b.timestamp) ?? bad('timestamp must be unix seconds');

  if (typeof b.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(b.signature)) {
    bad('signature must be a 0x-hex string');
  }

  if (!Array.isArray(b.chunkAddresses) || b.chunkAddresses.length === 0) {
    bad('chunkAddresses must be a non-empty array');
  }
  const chunkAddresses = (b.chunkAddresses as unknown[]).map((a) => {
    if (typeof a !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(a)) {
      bad('Each chunk address must be 32-byte hex');
    }
    return (a as string).replace(/^0x/, '').toLowerCase();
  });
  if (new Set(chunkAddresses).size !== chunkAddresses.length) bad('Duplicate chunk addresses');

  const pop = b.proofOfPayment as Record<string, unknown> | undefined;
  const intent = pop?.purchaseIntent as Record<string, unknown> | undefined;
  const popOk =
    typeof pop?.fromAddress === 'string' &&
    typeof pop?.toAddress === 'string' &&
    typeof pop?.chainId === 'string' &&
    typeof pop?.txHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(pop.txHash) &&
    typeof intent?.signature === 'string' &&
    typeof intent?.domain === 'object' &&
    intent.domain !== null &&
    typeof intent?.message === 'object' &&
    intent.message !== null;
  if (!popOk) bad('proofOfPayment is missing required fields (incl. purchaseIntent)');

  return {
    agentId,
    proofOfPayment: pop as unknown as ProofOfPayment,
    chunkAddresses,
    timestamp,
    signature: b.signature as string,
  };
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}
