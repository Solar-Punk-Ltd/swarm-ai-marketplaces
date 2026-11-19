import { PURCHASE_INTENT_TYPES } from '@solarpunk/swarm-catalog';
import { Wallet, hexlify, randomBytes, type Signer, type TypedDataField } from 'ethers';
import type { ProofOfPayment, ReviewMarketplaceConfig } from '../src/modules/reviews/types';

export const CHAIN_ID = 84532n;
export const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

export const buyer = Wallet.createRandom();
export const seller = Wallet.createRandom();
export const treasury = Wallet.createRandom().address;
export const factory = Wallet.createRandom().address;
export const splitter = Wallet.createRandom().address;
export const token = Wallet.createRandom().address;

export const config: ReviewMarketplaceConfig = {
  chainId: CHAIN_ID,
  identityRegistry: IDENTITY_REGISTRY,
  reputationRegistry: REPUTATION_REGISTRY,
  splitterFactory: factory,
  splitterTerms: [{ treasury, taxBps: 500 }],
  acceptedAssets: [token],
  valueFloor: [{ asset: token, amount: 1_000n }],
};

export const intentDomain = {
  name: 'Swarm AI Data Exchange',
  version: '1',
  chainId: Number(CHAIN_ID),
  verifyingContract: Wallet.createRandom().address,
};

export async function signedProofOfPayment(
  overrides: { signer?: Signer; amount?: string; payTo?: string; nonce?: string } = {},
): Promise<ProofOfPayment> {
  const message = {
    itemId: 'ab'.repeat(32),
    granteePublicKey: hexlify(randomBytes(33)),
    payment: {
      scheme: 'exact' as const,
      asset: `eip155:84532/erc20:${token}`,
      amount: overrides.amount ?? '5000',
      payTo: overrides.payTo ?? splitter,
    },
    nonce: overrides.nonce ?? hexlify(randomBytes(32)),
    validAfter: 0,
    validBefore: 2_000_000_000,
  };
  const signature = await (overrides.signer ?? buyer).signTypedData(
    intentDomain,
    PURCHASE_INTENT_TYPES as unknown as Record<string, TypedDataField[]>,
    message,
  );
  return {
    fromAddress: buyer.address,
    toAddress: splitter,
    chainId: CHAIN_ID.toString(),
    txHash: hexlify(randomBytes(32)),
    purchaseIntent: { domain: intentDomain, message, signature },
  };
}
