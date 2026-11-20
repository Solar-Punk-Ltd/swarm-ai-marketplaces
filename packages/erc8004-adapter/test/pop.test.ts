import { Wallet, toBeHex, zeroPadValue } from 'ethers';
import {
  AUTHORIZATION_USED_TOPIC,
  TRANSFER_TOPIC,
  verifyPoP,
  type PoPChainReader,
  type ReceiptLog,
  type SettlementReceipt,
} from '../src/modules/reviews/pop';
import type { ProofOfPayment } from '../src/modules/reviews/types';
import {
  buyer,
  config,
  factory,
  seller,
  signedProofOfPayment,
  splitter,
  token,
  treasury,
} from './fixtures';

const AGENT_ID = 42n;
const BLOCK = 1_000;

function transferLog(
  from: string,
  to: string,
  amount: bigint,
  index = 1,
  address = token,
): ReceiptLog {
  return {
    address,
    topics: [TRANSFER_TOPIC, zeroPadValue(from, 32), zeroPadValue(to, 32)],
    data: toBeHex(amount, 32),
    index,
  };
}

function authorizationUsedLog(authorizer: string, nonce: string, index = 0): ReceiptLog {
  return {
    address: token,
    topics: [AUTHORIZATION_USED_TOPIC, zeroPadValue(authorizer, 32), nonce],
    data: '0x',
    index,
  };
}

/** A reader where everything checks out; each test breaks one thing. */
function reader(
  pop: ProofOfPayment,
  overrides: Partial<PoPChainReader> & { receipt?: SettlementReceipt | null } = {},
): PoPChainReader {
  const receipt: SettlementReceipt | null =
    overrides.receipt !== undefined
      ? overrides.receipt
      : {
          status: 1,
          blockNumber: BLOCK,
          logs: [
            authorizationUsedLog(buyer.address, pop.purchaseIntent.message.nonce),
            transferLog(buyer.address, splitter, 5_000n),
          ],
        };
  return {
    getReceipt: async () => receipt,
    getAgentSplitterAt: async () => splitter,
    getSplitterInfo: async () => ({ seller: seller.address, treasury, taxBps: 500 }),
    splitterOf: async () => splitter,
    getAgentPayees: async () => ({ owner: seller.address, agentWallet: null }),
    ...overrides,
  };
}

const input = (pop: ProofOfPayment) => ({
  agentId: AGENT_ID,
  clientAddress: buyer.address,
  proofOfPayment: pop,
});

describe('verifyPoP', () => {
  it('accepts a genuine, taxed purchase', async () => {
    const pop = await signedProofOfPayment();
    const result = await verifyPoP(input(pop), reader(pop), config);
    expect(result).toEqual({
      valid: true,
      splitter,
      seller: seller.address,
      token,
      amount: 5_000n,
      settlementBlock: BLOCK,
      settlementLogIndex: 1,
      itemId: pop.purchaseIntent.message.itemId,
    });
  });

  it('reads the agent link at the settlement log, not the current one', async () => {
    const pop = await signedProofOfPayment();
    const getAgentSplitterAt = jest.fn(async () => splitter);
    await verifyPoP(input(pop), reader(pop, { getAgentSplitterAt }), config);
    expect(getAgentSplitterAt).toHaveBeenCalledWith(AGENT_ID, BLOCK, 1);
  });

  it('rejects a proof for another chain', async () => {
    const pop = { ...(await signedProofOfPayment()), chainId: '1' };
    expect(await verifyPoP(input(pop), reader(pop), config)).toEqual({
      valid: false,
      reason: 'chain_mismatch',
    });
  });

  it('rejects a proof whose fromAddress is not the reviewer', async () => {
    const pop = { ...(await signedProofOfPayment()), fromAddress: seller.address };
    expect(await verifyPoP(input(pop), reader(pop), config)).toMatchObject({
      reason: 'pop_fields_mismatch',
    });
  });

  it('rejects an unknown or failed tx', async () => {
    const pop = await signedProofOfPayment();
    expect(await verifyPoP(input(pop), reader(pop, { receipt: null }), config)).toMatchObject({
      reason: 'tx_not_found',
    });
    const failed = { status: 0, blockNumber: BLOCK, logs: [] };
    expect(await verifyPoP(input(pop), reader(pop, { receipt: failed }), config)).toMatchObject({
      reason: 'tx_failed',
    });
  });

  it('rejects a tx that paid someone else, or that someone else paid', async () => {
    const pop = await signedProofOfPayment();
    const nonce = pop.purchaseIntent.message.nonce;
    const elsewhere = Wallet.createRandom().address;
    const paidElsewhere = {
      status: 1,
      blockNumber: BLOCK,
      logs: [
        authorizationUsedLog(buyer.address, nonce),
        transferLog(buyer.address, elsewhere, 5_000n),
      ],
    };
    expect(
      await verifyPoP(input(pop), reader(pop, { receipt: paidElsewhere }), config),
    ).toMatchObject({
      reason: 'no_transfer_to_splitter',
    });

    // A seller citing a purchase it made itself, on behalf of the "reviewer".
    const paidByOther = {
      status: 1,
      blockNumber: BLOCK,
      logs: [transferLog(seller.address, splitter, 5_000n)],
    };
    expect(
      await verifyPoP(input(pop), reader(pop, { receipt: paidByOther }), config),
    ).toMatchObject({
      reason: 'wrong_payer',
    });
  });

  it('rejects when the agent had no splitter linked, or a different one, at settlement', async () => {
    const pop = await signedProofOfPayment();
    expect(
      await verifyPoP(input(pop), reader(pop, { getAgentSplitterAt: async () => null }), config),
    ).toMatchObject({ reason: 'splitter_unlinked' });
    expect(
      await verifyPoP(
        input(pop),
        reader(pop, { getAgentSplitterAt: async () => Wallet.createRandom().address }),
        config,
      ),
    ).toMatchObject({ reason: 'no_transfer_to_splitter' });
  });

  it('rejects a linked address that is not this factory’s clone (e.g. the seller’s own wallet)', async () => {
    const pop = await signedProofOfPayment();
    expect(
      await verifyPoP(input(pop), reader(pop, { getSplitterInfo: async () => null }), config),
    ).toMatchObject({ reason: 'splitter_not_factory_clone' });

    const splitterOf = jest.fn(async () => Wallet.createRandom().address);
    expect(await verifyPoP(input(pop), reader(pop, { splitterOf }), config)).toMatchObject({
      reason: 'splitter_not_factory_clone',
    });
    expect(splitterOf).toHaveBeenCalledWith(factory, seller.address);
  });

  it('rejects a clone with terms the marketplace does not accept (e.g. 0% tax)', async () => {
    const pop = await signedProofOfPayment();
    const zeroTax = async () => ({ seller: seller.address, treasury, taxBps: 0 });
    expect(
      await verifyPoP(input(pop), reader(pop, { getSplitterInfo: zeroTax }), config),
    ).toMatchObject({ reason: 'splitter_terms_mismatch' });
  });

  it('rejects a genuine clone that belongs to another agent’s seller', async () => {
    const pop = await signedProofOfPayment();
    const otherAgent = async () => ({ owner: Wallet.createRandom().address, agentWallet: null });
    expect(
      await verifyPoP(input(pop), reader(pop, { getAgentPayees: otherAgent }), config),
    ).toMatchObject({ reason: 'splitter_seller_mismatch' });
    expect(
      await verifyPoP(input(pop), reader(pop, { getAgentPayees: async () => null }), config),
    ).toMatchObject({ reason: 'splitter_seller_mismatch' });
  });

  it('accepts a seller registered as the agent wallet, read before the settlement block', async () => {
    const pop = await signedProofOfPayment();
    const getAgentPayees = jest.fn(async () => ({
      owner: Wallet.createRandom().address,
      agentWallet: seller.address,
    }));
    expect(await verifyPoP(input(pop), reader(pop, { getAgentPayees }), config)).toMatchObject({
      valid: true,
    });
    expect(getAgentPayees).toHaveBeenCalledWith(AGENT_ID, BLOCK - 1);
  });

  it('rejects unaccepted tokens and payments below the floor', async () => {
    const pop = await signedProofOfPayment();
    const nonce = pop.purchaseIntent.message.nonce;
    const otherToken = Wallet.createRandom().address;
    const wrongToken = {
      status: 1,
      blockNumber: BLOCK,
      logs: [transferLog(buyer.address, splitter, 5_000n, 1, otherToken)],
    };
    expect(await verifyPoP(input(pop), reader(pop, { receipt: wrongToken }), config)).toMatchObject(
      {
        reason: 'asset_not_accepted',
      },
    );

    const cheap = await signedProofOfPayment({ amount: '999' });
    const below = {
      status: 1,
      blockNumber: BLOCK,
      logs: [
        authorizationUsedLog(buyer.address, nonce),
        transferLog(buyer.address, splitter, 999n),
      ],
    };
    expect(await verifyPoP(input(cheap), reader(cheap, { receipt: below }), config)).toMatchObject({
      reason: 'below_value_floor',
    });
  });

  it('rejects an intent signed by someone other than the reviewer', async () => {
    const pop = await signedProofOfPayment({ signer: Wallet.createRandom() });
    expect(await verifyPoP(input(pop), reader(pop), config)).toMatchObject({
      reason: 'intent_bad_signature',
    });
  });

  it('rejects an intent whose nonce this tx did not consume', async () => {
    const pop = await signedProofOfPayment();
    const otherNonce = {
      status: 1,
      blockNumber: BLOCK,
      logs: [
        authorizationUsedLog(buyer.address, toBeHex(1n, 32)),
        transferLog(buyer.address, splitter, 5_000n),
      ],
    };
    expect(await verifyPoP(input(pop), reader(pop, { receipt: otherNonce }), config)).toMatchObject(
      {
        reason: 'intent_not_in_tx',
      },
    );
  });

  it('rejects an intent that priced a different payment', async () => {
    const pop = await signedProofOfPayment({ amount: '4000' });
    expect(await verifyPoP(input(pop), reader(pop), config)).toMatchObject({
      reason: 'intent_payment_mismatch',
    });
  });
});
