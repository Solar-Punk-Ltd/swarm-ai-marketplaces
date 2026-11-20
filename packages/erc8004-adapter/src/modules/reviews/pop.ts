/**
 * Proof-of-Purchase verification (CLAUDE.md "PoP validity" rules 1–3 and 5–7; rule 4 — one review
 * per purchase — needs other reviews, see `findAnchoredPurchase`).
 *
 * Chain access goes through `PoPChainReader` so the rules can be tested without an RPC.
 */
import { PURCHASE_INTENT_TYPES } from '@solarpunk/swarm-catalog';
import {
  Contract,
  ZeroAddress,
  getAddress,
  getBytes,
  id,
  verifyTypedData,
  zeroPadValue,
  type Provider,
  type TypedDataField,
} from 'ethers';
import { IDENTITY_REGISTRY_ABI } from '../../abis/IdentityRegistry';
import { REVENUE_SPLITTER_ABI, SPLITTER_FACTORY_ABI } from '../../abis/Splitter';
import { AGENT_SPLITTER } from '../../constants';
import { decodeSplitterMetadata } from '../../splitter-link';
import { sameAddress } from './identifiers';
import type { PoPResult, ProofOfPayment, ReviewMarketplaceConfig } from './types';

export const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
/** ERC-3009: emitted by the token when a transferWithAuthorization nonce is consumed. */
export const AUTHORIZATION_USED_TOPIC = id('AuthorizationUsed(address,bytes32)');

export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
  index: number;
}

export interface SettlementReceipt {
  status: number | null;
  blockNumber: number;
  logs: readonly ReceiptLog[];
}

export interface SplitterInfo {
  seller: string;
  treasury: string;
  taxBps: number;
}

export interface PoPChainReader {
  getReceipt(txHash: string): Promise<SettlementReceipt | null>;
  /** `agent_splitter` of `agentId` as it stood just before log `logIndex` of block `blockNumber`. */
  getAgentSplitterAt(
    agentId: bigint,
    blockNumber: number,
    logIndex: number,
  ): Promise<string | null>;
  /** Clone terms, or null when `address` is not a splitter (calls revert / no code). */
  getSplitterInfo(address: string): Promise<SplitterInfo | null>;
  splitterOf(factory: string, seller: string): Promise<string>;
  /**
   * Addresses entitled to be the agent's splitter seller, as they stood at the end of block
   * `blockNumber`: the NFT owner and the registered agent wallet (null when unset). Null overall
   * when the agent did not exist yet.
   */
  getAgentPayees(
    agentId: bigint,
    blockNumber: number,
  ): Promise<{ owner: string; agentWallet: string | null } | null>;
}

/**
 * ethers-backed reader. The historical link read needs state at block N − 1, so `archiveProvider`
 * must be an archive node (falls back to `provider` — fine if that already is one).
 */
export function createPoPChainReader(params: {
  provider: Provider;
  archiveProvider?: Provider;
  identityRegistry: string;
}): PoPChainReader {
  const archive = params.archiveProvider ?? params.provider;
  const identityArchive = new Contract(params.identityRegistry, IDENTITY_REGISTRY_ABI, archive);
  const identityLogs = new Contract(
    params.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    params.provider,
  );

  return {
    async getReceipt(txHash) {
      const receipt = await params.provider.getTransactionReceipt(txHash);
      if (!receipt) return null;
      return { status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs };
    },

    async getAgentSplitterAt(agentId, blockNumber, logIndex) {
      // State after block N − 1 …
      const raw = (await identityArchive.getMetadata(agentId, AGENT_SPLITTER, {
        blockTag: blockNumber - 1,
      })) as string;
      let splitter = decodeSplitterMetadata(getBytes(raw));

      // … then any re-link inside block N that lands before the settlement log; the last one wins.
      const filter = identityLogs.filters.MetadataSet(agentId, AGENT_SPLITTER);
      const sameBlock = await identityLogs.queryFilter(filter, blockNumber, blockNumber);
      for (const log of sameBlock.sort((a, b) => a.index - b.index)) {
        if (log.index >= logIndex) break;
        const parsed = identityLogs.interface.parseLog({ topics: [...log.topics], data: log.data });
        splitter = decodeSplitterMetadata(getBytes(parsed?.args.metadataValue as string));
      }
      return splitter;
    },

    async getSplitterInfo(address) {
      const splitter = new Contract(address, REVENUE_SPLITTER_ABI, params.provider);
      try {
        const [seller, treasury, taxBps] = await Promise.all([
          splitter.seller() as Promise<string>,
          splitter.treasury() as Promise<string>,
          splitter.taxBps() as Promise<bigint>,
        ]);
        return { seller, treasury, taxBps: Number(taxBps) };
      } catch {
        return null;
      }
    },

    async splitterOf(factory, seller) {
      const contract = new Contract(factory, SPLITTER_FACTORY_ABI, params.provider);
      return (await contract.splitterOf(seller)) as string;
    },

    async getAgentPayees(agentId, blockNumber) {
      const overrides = { blockTag: blockNumber };
      let owner: string;
      try {
        owner = (await identityArchive.ownerOf(agentId, overrides)) as string;
      } catch {
        return null; // not minted yet at that block
      }
      const wallet = (await identityArchive.getAgentWallet(agentId, overrides)) as string;
      return { owner, agentWallet: wallet === ZeroAddress ? null : wallet };
    },
  };
}

/**
 * Checks that `pop` proves `clientAddress` bought from `agentId` through a genuine, correctly-taxed
 * splitter of this marketplace. Returns the first failing rule.
 */
export async function verifyPoP(
  input: { agentId: bigint; clientAddress: string; proofOfPayment: ProofOfPayment },
  reader: PoPChainReader,
  config: ReviewMarketplaceConfig,
): Promise<PoPResult> {
  const { agentId, clientAddress, proofOfPayment: pop } = input;
  const fail = (reason: Extract<PoPResult, { valid: false }>['reason']): PoPResult => ({
    valid: false,
    reason,
  });

  if (pop.chainId !== config.chainId.toString()) return fail('chain_mismatch');
  if (!sameAddress(pop.fromAddress, clientAddress)) return fail('pop_fields_mismatch');

  // Rule 1 — the settlement exists and succeeded.
  const receipt = await reader.getReceipt(pop.txHash);
  if (!receipt) return fail('tx_not_found');
  if (receipt.status !== 1) return fail('tx_failed');

  // Rule 2 — a Transfer from the reviewer to the claimed splitter. Read the log, not tx.from:
  // the facilitator submits the transaction.
  const transfersToSplitter = receipt.logs
    .map(parseTransfer)
    .filter((t): t is ParsedTransfer => t !== null && sameAddress(t.to, pop.toAddress));
  if (transfersToSplitter.length === 0) return fail('no_transfer_to_splitter');
  const transfer = transfersToSplitter.find((t) => sameAddress(t.from, clientAddress));
  if (!transfer) return fail('wrong_payer');

  // The agent's link as it stood at the settlement log — later re-links can't change the verdict.
  const linked = await reader.getAgentSplitterAt(agentId, receipt.blockNumber, transfer.logIndex);
  if (!linked) return fail('splitter_unlinked');
  if (!sameAddress(linked, transfer.to)) return fail('no_transfer_to_splitter');

  // The link is owner-written, so the splitter must be a real clone of this marketplace's factory,
  // carrying terms the marketplace accepts — otherwise sellers could mint untaxed PoP.
  const info = await reader.getSplitterInfo(linked);
  if (!info || info.seller === ZeroAddress) return fail('splitter_not_factory_clone');
  const registered = await reader.splitterOf(config.splitterFactory, info.seller);
  if (!sameAddress(registered, linked)) return fail('splitter_not_factory_clone');
  const termsOk = config.splitterTerms.some(
    (t) => sameAddress(t.treasury, info.treasury) && t.taxBps === info.taxBps,
  );
  if (!termsOk) return fail('splitter_terms_mismatch');

  // The clone must belong to this agent: its seller is the agent's NFT owner or registered agent
  // wallet, as of the block before settlement. Otherwise an owner could link another agent's
  // splitter and collect reviews for purchases made from that agent.
  const payees = await reader.getAgentPayees(agentId, receipt.blockNumber - 1);
  const sellerIsAgent =
    payees !== null &&
    (sameAddress(info.seller, payees.owner) ||
      (payees.agentWallet !== null && sameAddress(info.seller, payees.agentWallet)));
  if (!sellerIsAgent) return fail('splitter_seller_mismatch');

  // Rule 3 — accepted token, at or above the floor.
  if (!config.acceptedAssets.some((a) => sameAddress(a, transfer.token))) {
    return fail('asset_not_accepted');
  }
  const floor = config.valueFloor.find((f) => sameAddress(f.asset, transfer.token));
  if (floor && transfer.amount < floor.amount) return fail('below_value_floor');

  // Rule 5 — the reviewer signed the PurchaseIntent.
  const intent = pop.purchaseIntent;
  let signer: string;
  try {
    signer = verifyTypedData(
      intent.domain,
      PURCHASE_INTENT_TYPES as unknown as Record<string, TypedDataField[]>,
      intent.message,
      intent.signature,
    );
  } catch {
    return fail('intent_bad_signature');
  }
  if (!sameAddress(signer, clientAddress)) return fail('intent_bad_signature');

  // Rule 6 — the intent's nonce is the ERC-3009 nonce this tx consumed, tying intent to tx.
  const authorizerTopic = zeroPadValue(clientAddress, 32).toLowerCase();
  const nonceTopic = intent.message.nonce.toLowerCase();
  const consumed = receipt.logs.some(
    (log) =>
      sameAddress(log.address, transfer.token) &&
      log.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC &&
      log.topics[1]?.toLowerCase() === authorizerTopic &&
      log.topics[2]?.toLowerCase() === nonceTopic,
  );
  if (!consumed) return fail('intent_not_in_tx');

  // Rule 7 — the intent priced exactly this payment.
  let intentAmount: bigint;
  try {
    intentAmount = BigInt(intent.message.payment.amount);
  } catch {
    return fail('intent_payment_mismatch');
  }
  if (!sameAddress(intent.message.payment.payTo, linked) || intentAmount !== transfer.amount) {
    return fail('intent_payment_mismatch');
  }

  return {
    valid: true,
    splitter: getAddress(linked),
    seller: getAddress(info.seller),
    token: getAddress(transfer.token),
    amount: transfer.amount,
    settlementBlock: receipt.blockNumber,
    settlementLogIndex: transfer.logIndex,
    itemId: intent.message.itemId,
  };
}

interface ParsedTransfer {
  token: string;
  from: string;
  to: string;
  amount: bigint;
  logIndex: number;
}

function parseTransfer(log: ReceiptLog): ParsedTransfer | null {
  // ERC-20 Transfer has 3 topics; ERC-721 has 4 (indexed tokenId) and is ignored.
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  return {
    token: log.address,
    from: getAddress(`0x${log.topics[1].slice(26)}`),
    to: getAddress(`0x${log.topics[2].slice(26)}`),
    amount: BigInt(log.data),
    logIndex: log.index,
  };
}
