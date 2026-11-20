import {
  AbiCoder,
  JsonRpcProvider,
  Wallet,
  concat,
  keccak256,
  recoverAddress,
  toUtf8Bytes,
} from 'ethers';
import { IdentityModule } from '../src/modules/identity';

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const CHAIN_ID = 84532n;
const abi = AbiCoder.defaultAbiCoder();

/** The digest IdentityRegistry.setAgentWallet recovers from, built the way Solidity does. */
function contractDigest(agentId: bigint, newWallet: string, owner: string, deadline: number) {
  const typehash = keccak256(
    toUtf8Bytes('AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)'),
  );
  const structHash = keccak256(
    abi.encode(
      ['bytes32', 'uint256', 'address', 'address', 'uint256'],
      [typehash, agentId, newWallet, owner, deadline],
    ),
  );
  const domainTypehash = keccak256(
    toUtf8Bytes(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    ),
  );
  const domainSeparator = keccak256(
    abi.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        domainTypehash,
        keccak256(toUtf8Bytes('ERC8004IdentityRegistry')),
        keccak256(toUtf8Bytes('1')),
        CHAIN_ID,
        REGISTRY,
      ],
    ),
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

describe('agent wallet consent (setAgentWallet)', () => {
  const identity = new IdentityModule(REGISTRY, new JsonRpcProvider(), CHAIN_ID);
  const payout = Wallet.createRandom();
  const owner = Wallet.createRandom().address;

  it('signs exactly what the registry verifies', async () => {
    const auth = await identity.signAgentWalletAuth(42n, payout, owner);
    const digest = contractDigest(42n, payout.address, owner, auth.deadline);
    expect(recoverAddress(digest, auth.signature)).toBe(payout.address);
    expect(auth).toMatchObject({ agentId: 42n, wallet: payout.address, owner });
  });

  it('keeps the deadline within the registry’s 5-minute limit', async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = await identity.signAgentWalletAuth(42n, payout, owner, 3600);
    expect(auth.deadline).toBeLessThanOrEqual(now + 300 + 1);
    expect(auth.deadline).toBeGreaterThan(now);
  });

  it('binds the consent to the owner', async () => {
    const auth = await identity.signAgentWalletAuth(42n, payout, owner);
    const otherOwner = Wallet.createRandom().address;
    const digest = contractDigest(42n, payout.address, otherOwner, auth.deadline);
    expect(recoverAddress(digest, auth.signature)).not.toBe(payout.address);
  });

  it('exposes the typed data for signing elsewhere', () => {
    const typed = identity.agentWalletTypedData(42n, payout.address, owner, 123);
    expect(typed.domain).toEqual({
      name: 'ERC8004IdentityRegistry',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: REGISTRY,
    });
    expect(typed.primaryType).toBe('AgentWalletSet');
    expect(typed.message).toEqual({
      agentId: 42n,
      newWallet: payout.address,
      owner,
      deadline: 123,
    });
  });
});
