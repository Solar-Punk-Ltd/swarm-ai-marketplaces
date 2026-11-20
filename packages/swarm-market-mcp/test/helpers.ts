import { BatchId } from '@ethersphere/bee-js';
import { envelopeToWire, type ProofOfPayment } from '@solarpunk/erc8004-adapter';
import { Wallet, randomBytes } from 'ethers';
import { BuyerStore } from '../src/buyer-store';
import type { MarketplaceTerms } from '../src/reviews';

export const CHAIN_ID = 84532n;
export const FACTORY = Wallet.createRandom().address;
export const SPLITTER = Wallet.createRandom().address;
export const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
export const TX = `0x${'7a'.repeat(32)}`;
export const ITEM = 'ab'.repeat(32);

export const terms: MarketplaceTerms = {
  review: {
    chainId: CHAIN_ID,
    identityRegistry: IDENTITY,
    reputationRegistry: REPUTATION,
    splitterFactory: FACTORY,
    splitterTerms: [{ treasury: Wallet.createRandom().address, taxBps: 500 }],
    acceptedAssets: [Wallet.createRandom().address],
    valueFloor: [],
  },
  score: { min: 0, max: 100, decimals: 0 },
  maxChunksPerRequest: 16,
  maxEnvelopesPerPurchase: 64,
  requestMaxAgeSeconds: 300,
};

export const intent: ProofOfPayment['purchaseIntent'] = {
  domain: {
    name: 'Swarm AI Data Exchange',
    version: '1',
    chainId: 84532,
    verifyingContract: FACTORY,
  },
  message: {
    itemId: ITEM,
    granteePublicKey: '0x02',
    payment: { scheme: 'exact', asset: 'eip155:84532/erc20:0x0', amount: '5000', payTo: SPLITTER },
    nonce: `0x${'11'.repeat(32)}`,
    validAfter: 0,
    validBefore: 2_000_000_000,
  },
  signature: '0x00',
};

export function storeWithPurchase(txHash = TX): BuyerStore {
  const store = new BuyerStore(':memory:');
  store.recordPurchase({
    txHash,
    itemId: ITEM,
    chainId: CHAIN_ID.toString(),
    payTo: SPLITTER,
    asset: 'eip155:84532/erc20:0x0',
    amount: '5000',
    purchaseIntent: intent,
    settledAt: '2026-11-20T10:00:00.000Z',
  });
  return store;
}

export function wireEnvelopes(addresses: string[]) {
  return addresses.map((address) =>
    envelopeToWire(address, {
      batchId: new BatchId('ba'.repeat(32)),
      issuer: randomBytes(20),
      index: randomBytes(8),
      timestamp: randomBytes(8),
      signature: randomBytes(65),
    }),
  );
}
