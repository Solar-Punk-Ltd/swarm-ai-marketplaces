/**
 * register_agent step G: make the splitter's seller the agent's registered wallet when it is not
 * the NFT owner.
 *
 * Proof-of-Purchase only counts a sale if the splitter's seller is the agent's NFT owner or its
 * ERC-8004 agent wallet (the "seller check", root CLAUDE.md PoP rule 2) — otherwise an owner could
 * link someone else's splitter. A seller paying out to AGENT_PAYMENT_ADDRESS ≠ owner therefore
 * needs that address registered with setAgentWallet, which requires the payout wallet's own
 * EIP-712 consent (AgentWalletSet, deadline ≤ 5 minutes). The consent comes from, in order:
 * a pre-signed `consent` argument, the payout wallet's key (AGENT_PAYMENT_PK), or — neither
 * available — the typed data is returned for the wallet to sign elsewhere.
 */
import { getAddress, type Signer } from 'ethers';
import type { WalletAuth } from '@solarpunk/erc8004-adapter';

export type AgentWalletStatus =
  | 'not-needed' // seller is the NFT owner
  | 'already-set'
  | 'set'
  | 'would-set'
  | 'needs-consent'
  | 'skipped'
  | 'failed';

export interface RegisterAgentWallet {
  status: AgentWalletStatus;
  wallet: string | null; // the seller that should be the agent wallet
  previousWallet?: string;
  txHash?: string;
  /** With `needs-consent`: what the payout wallet must sign (JSON-safe; bigints as strings). */
  consentRequest?: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: 'AgentWalletSet';
    message: { agentId: string; newWallet: string; owner: string; deadline: number };
  };
  reason?: string;
  error?: string;
}

export interface AgentWalletDeps {
  getAgentWallet(agentId: bigint): Promise<string>;
  setAgentWallet(
    agentId: bigint,
    wallet: string,
    deadline: number,
    signature: string,
  ): Promise<string>;
  signConsent(agentId: bigint, payout: Signer, owner: string): Promise<WalletAuth>;
  typedData(
    agentId: bigint,
    wallet: string,
    owner: string,
    deadline: number,
  ): {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: 'AgentWalletSet';
    message: { agentId: bigint; newWallet: string; owner: string; deadline: number };
  };
  nowSeconds(): number;
}

const ZERO = '0x0000000000000000000000000000000000000000';
/** A returned consent request must leave time to sign and re-call within the registry's 5 min. */
const REQUEST_TTL_SECONDS = 300;

export async function ensureAgentWallet(
  params: {
    agentId: bigint | null;
    owner: string;
    seller: string | null;
    dryRun: boolean;
    consent?: { deadline: number; signature: string };
    payoutSigner?: Signer;
  },
  deps: AgentWalletDeps,
): Promise<RegisterAgentWallet> {
  const { agentId, owner, seller } = params;
  if (agentId === null || !seller) {
    return {
      status: 'skipped',
      wallet: seller,
      reason: agentId === null ? 'no agentId' : 'no splitter seller',
    };
  }
  const wallet = getAddress(seller);
  if (wallet === getAddress(owner)) return { status: 'not-needed', wallet };

  try {
    // Some registries revert instead of returning zero for an unset wallet: treat as unset.
    const current = await deps.getAgentWallet(agentId).catch(() => ZERO);
    if (current && current !== ZERO && getAddress(current) === wallet) {
      return { status: 'already-set', wallet };
    }
    const previousWallet = current && current !== ZERO ? getAddress(current) : undefined;

    let consent = params.consent;
    if (!consent && params.payoutSigner) {
      const signerAddress = getAddress(await params.payoutSigner.getAddress());
      if (signerAddress !== wallet) {
        return {
          status: 'failed',
          wallet,
          previousWallet,
          error: `AGENT_PAYMENT_PK is the key of ${signerAddress}, not of the seller ${wallet}.`,
        };
      }
      if (!params.dryRun) {
        const signed = await deps.signConsent(agentId, params.payoutSigner, owner);
        consent = { deadline: signed.deadline, signature: signed.signature };
      }
    }

    if (params.dryRun) {
      return consent || params.payoutSigner
        ? { status: 'would-set', wallet, previousWallet }
        : needsConsent(agentId, wallet, owner, previousWallet, deps);
    }
    if (!consent) return needsConsent(agentId, wallet, owner, previousWallet, deps);

    if (consent.deadline < deps.nowSeconds()) {
      return {
        status: 'failed',
        wallet,
        previousWallet,
        error: 'The agent wallet consent has expired (the registry allows at most 5 minutes).',
      };
    }
    const txHash = await deps.setAgentWallet(agentId, wallet, consent.deadline, consent.signature);
    return { status: 'set', wallet, previousWallet, txHash };
  } catch (err) {
    return { status: 'failed', wallet, error: err instanceof Error ? err.message : String(err) };
  }
}

function needsConsent(
  agentId: bigint,
  wallet: string,
  owner: string,
  previousWallet: string | undefined,
  deps: AgentWalletDeps,
): RegisterAgentWallet {
  const typed = deps.typedData(agentId, wallet, owner, deps.nowSeconds() + REQUEST_TTL_SECONDS);
  return {
    status: 'needs-consent',
    wallet,
    previousWallet,
    consentRequest: {
      domain: { ...typed.domain, chainId: String(typed.domain.chainId) },
      types: typed.types,
      primaryType: typed.primaryType,
      message: { ...typed.message, agentId: typed.message.agentId.toString() },
    },
    reason:
      `Have ${wallet} sign consentRequest (EIP-712) and call register_agent again within 5 minutes ` +
      'with agentWalletConsent { deadline, signature } — or set AGENT_PAYMENT_PK.',
  };
}
