import { Wallet } from 'ethers';
import {
  envelopeRequestDomain,
  isEnvelopeRequestFresh,
  recoverEnvelopeRequestSigner,
  signEnvelopeRequest,
} from '../src/modules/reviews/envelope-request';
import type { EnvelopeRequest } from '../src/modules/reviews/types';
import { CHAIN_ID, buyer, factory } from './fixtures';

const request: EnvelopeRequest = {
  agentId: 42n,
  txHash: `0x${'11'.repeat(32)}`,
  chunkAddresses: ['aa'.repeat(32), `0x${'bb'.repeat(32)}`],
  timestamp: 1_800_000_000n,
};

describe('envelope request signature', () => {
  const domain = envelopeRequestDomain(CHAIN_ID, factory);

  it('recovers the reviewer', async () => {
    const signature = await signEnvelopeRequest(buyer, domain, request);
    expect(recoverEnvelopeRequestSigner(domain, request, signature)).toBe(buyer.address);
  });

  it('is not valid at another marketplace or for other chunks', async () => {
    const signature = await signEnvelopeRequest(buyer, domain, request);
    const otherMarketplace = envelopeRequestDomain(CHAIN_ID, Wallet.createRandom().address);
    expect(recoverEnvelopeRequestSigner(otherMarketplace, request, signature)).not.toBe(
      buyer.address,
    );
    const otherChunks = { ...request, chunkAddresses: ['cc'.repeat(32)] };
    expect(recoverEnvelopeRequestSigner(domain, otherChunks, signature)).not.toBe(buyer.address);
  });

  it('treats chunk addresses with and without 0x alike', async () => {
    const signature = await signEnvelopeRequest(buyer, domain, request);
    const prefixed = {
      ...request,
      chunkAddresses: request.chunkAddresses.map((a) => (a.startsWith('0x') ? a : `0x${a}`)),
    };
    expect(recoverEnvelopeRequestSigner(domain, prefixed, signature)).toBe(buyer.address);
  });
});

describe('isEnvelopeRequestFresh', () => {
  const now = 1_800_000_000;
  it('accepts requests inside the window', () => {
    expect(isEnvelopeRequestFresh(BigInt(now - 299), 300, now)).toBe(true);
    expect(isEnvelopeRequestFresh(BigInt(now + 30), 300, now)).toBe(true);
  });
  it('rejects stale and far-future requests', () => {
    expect(isEnvelopeRequestFresh(BigInt(now - 301), 300, now)).toBe(false);
    expect(isEnvelopeRequestFresh(BigInt(now + 61), 300, now)).toBe(false);
  });
});
