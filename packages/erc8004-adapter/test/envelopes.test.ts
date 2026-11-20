import { BatchId } from '@ethersphere/bee-js';
import { hexlify, randomBytes } from 'ethers';
import { envelopeFromWire, envelopeToWire } from '../src/modules/reviews/envelopes';

describe('envelope wire format', () => {
  it('round-trips every field', () => {
    const envelope = {
      batchId: new BatchId('cd'.repeat(32)),
      issuer: randomBytes(20),
      index: randomBytes(8),
      timestamp: randomBytes(8),
      signature: randomBytes(65),
    };
    const wire = envelopeToWire(`0x${'AB'.repeat(32)}`, envelope);
    expect(wire.address).toBe('ab'.repeat(32));
    expect(wire.batchId).toBe('cd'.repeat(32));
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);

    const back = envelopeFromWire(wire);
    expect(back.batchId.toHex()).toBe(envelope.batchId.toHex());
    expect(hexlify(back.issuer)).toBe(hexlify(envelope.issuer));
    expect(hexlify(back.index)).toBe(hexlify(envelope.index));
    expect(hexlify(back.timestamp)).toBe(hexlify(envelope.timestamp));
    expect(hexlify(back.signature)).toBe(hexlify(envelope.signature));
  });
});
