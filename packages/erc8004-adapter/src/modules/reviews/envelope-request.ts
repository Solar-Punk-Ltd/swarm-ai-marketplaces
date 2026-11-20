/**
 * The reviewer-signed envelope request. Without it, a seller — who sees the buyer's signed
 * PurchaseIntent at purchase time — could request envelopes for the buyer's purchase and block the
 * real review. The domain binds the signature to one marketplace (chain + SplitterFactory).
 */
import { getAddress, verifyTypedData, type Signer, type TypedDataDomain } from 'ethers';
import type { EnvelopeRequest } from './types';

export const ENVELOPE_REQUEST_DOMAIN_NAME = 'swarm-marketplace-service';
export const ENVELOPE_REQUEST_DOMAIN_VERSION = '1';

export const ENVELOPE_REQUEST_TYPES = {
  EnvelopeRequest: [
    { name: 'agentId', type: 'uint256' },
    { name: 'txHash', type: 'bytes32' },
    { name: 'chunkAddresses', type: 'bytes32[]' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

export function envelopeRequestDomain(chainId: bigint, splitterFactory: string): TypedDataDomain {
  return {
    name: ENVELOPE_REQUEST_DOMAIN_NAME,
    version: ENVELOPE_REQUEST_DOMAIN_VERSION,
    chainId,
    verifyingContract: getAddress(splitterFactory),
  };
}

export async function signEnvelopeRequest(
  signer: Signer,
  domain: TypedDataDomain,
  request: EnvelopeRequest,
): Promise<string> {
  return signer.signTypedData(domain, ENVELOPE_REQUEST_TYPES, toMessage(request));
}

/** Returns the signer's address; the caller compares it with the PoP's payer. */
export function recoverEnvelopeRequestSigner(
  domain: TypedDataDomain,
  request: EnvelopeRequest,
  signature: string,
): string {
  return verifyTypedData(domain, ENVELOPE_REQUEST_TYPES, toMessage(request), signature);
}

/** Rejects stale requests (replay window) and ones dated in the future beyond clock skew. */
export function isEnvelopeRequestFresh(
  timestamp: bigint,
  maxAgeSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxSkewSeconds = 60,
): boolean {
  const age = BigInt(nowSeconds) - timestamp;
  return age <= BigInt(maxAgeSeconds) && age >= -BigInt(maxSkewSeconds);
}

// Bee reports chunk addresses without 0x; EIP-712 bytes32 needs it.
function toMessage(request: EnvelopeRequest) {
  return {
    agentId: request.agentId,
    txHash: request.txHash,
    chunkAddresses: request.chunkAddresses.map((a) => (a.startsWith('0x') ? a : `0x${a}`)),
    timestamp: request.timestamp,
  };
}
