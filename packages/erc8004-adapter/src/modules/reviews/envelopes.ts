/**
 * JSON wire format for postage envelopes, shared by marketplace-service (issues them) and the
 * buyer's tools (upload with them). bee-js holds envelope fields as bytes; on the wire they are
 * 0x-hex strings.
 */
import { BatchId, type EnvelopeWithBatchId } from '@ethersphere/bee-js';
import { getBytes, hexlify } from 'ethers';

export interface WireEnvelope {
  address: string; // chunk address the stamp is for, 64-hex (no 0x)
  batchId: string; // 64-hex (no 0x)
  issuer: string; // 0x-hex, 20 bytes
  index: string; // 0x-hex, 8 bytes
  timestamp: string; // 0x-hex, 8 bytes
  signature: string; // 0x-hex, 65 bytes
}

export function envelopeToWire(address: string, envelope: EnvelopeWithBatchId): WireEnvelope {
  return {
    address: address.replace(/^0x/, '').toLowerCase(),
    batchId: envelope.batchId.toHex(),
    issuer: hexlify(envelope.issuer),
    index: hexlify(envelope.index),
    timestamp: hexlify(envelope.timestamp),
    signature: hexlify(envelope.signature),
  };
}

export function envelopeFromWire(wire: WireEnvelope): EnvelopeWithBatchId {
  return {
    batchId: new BatchId(wire.batchId),
    issuer: getBytes(wire.issuer),
    index: getBytes(wire.index),
    timestamp: getBytes(wire.timestamp),
    signature: getBytes(wire.signature),
  };
}
