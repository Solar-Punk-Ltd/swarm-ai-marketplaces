import { IdentityModule } from '@solarpunk/erc8004-adapter';
import { JsonRpcProvider, Wallet, recoverAddress, TypedDataEncoder } from 'ethers';
import { ensureAgentWallet, type AgentWalletDeps } from '../src/agent-wallet';

const ZERO = '0x0000000000000000000000000000000000000000';
const identity = new IdentityModule(
  '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  new JsonRpcProvider(),
  84532n,
);
const owner = Wallet.createRandom();
const payout = Wallet.createRandom();
const NOW = Math.floor(Date.now() / 1000);

function deps(current = ZERO) {
  return {
    getAgentWallet: jest.fn(async () => current),
    setAgentWallet: jest.fn(async () => '0xset'),
    signConsent: jest.fn((id: bigint, signer, o: string) =>
      identity.signAgentWalletAuth(id, signer, o),
    ),
    typedData: jest.fn((id: bigint, w: string, o: string, d: number) =>
      identity.agentWalletTypedData(id, w, o, d),
    ),
    nowSeconds: () => NOW,
  } satisfies AgentWalletDeps;
}

const base = { agentId: 42n, owner: owner.address, seller: payout.address, dryRun: false };

describe('ensureAgentWallet', () => {
  it('is not needed when the seller is the NFT owner', async () => {
    const d = deps();
    const r = await ensureAgentWallet({ ...base, seller: owner.address.toLowerCase() }, d);
    expect(r.status).toBe('not-needed');
    expect(d.getAgentWallet).not.toHaveBeenCalled();
  });

  it('skips without an agent or a seller', async () => {
    expect((await ensureAgentWallet({ ...base, agentId: null }, deps())).status).toBe('skipped');
    expect((await ensureAgentWallet({ ...base, seller: null }, deps())).status).toBe('skipped');
  });

  it('does nothing when the seller is already the agent wallet', async () => {
    const d = deps(payout.address);
    expect((await ensureAgentWallet(base, d)).status).toBe('already-set');
    expect(d.setAgentWallet).not.toHaveBeenCalled();
  });

  it('signs with AGENT_PAYMENT_PK and sets the wallet', async () => {
    const d = deps();
    const r = await ensureAgentWallet({ ...base, payoutSigner: payout }, d);
    expect(r).toMatchObject({ status: 'set', wallet: payout.address, txHash: '0xset' });

    const [agentId, wallet, deadline, signature] = d.setAgentWallet.mock.calls[0] as unknown as [
      bigint,
      string,
      number,
      string,
    ];
    const typed = identity.agentWalletTypedData(agentId, wallet, owner.address, deadline);
    const digest = TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
    expect(recoverAddress(digest, signature)).toBe(payout.address);
  });

  it('replaces a different existing wallet and reports it', async () => {
    const previous = Wallet.createRandom().address;
    const r = await ensureAgentWallet({ ...base, payoutSigner: payout }, deps(previous));
    expect(r).toMatchObject({ status: 'set', previousWallet: previous });
  });

  it('uses a pre-signed consent', async () => {
    const signed = await identity.signAgentWalletAuth(42n, payout, owner.address);
    const d = deps();
    const r = await ensureAgentWallet(
      { ...base, consent: { deadline: signed.deadline, signature: signed.signature } },
      d,
    );
    expect(r.status).toBe('set');
    expect(d.setAgentWallet).toHaveBeenCalledWith(
      42n,
      payout.address,
      signed.deadline,
      signed.signature,
    );
  });

  it('returns what to sign when it has neither key nor consent', async () => {
    const d = deps();
    const r = await ensureAgentWallet(base, d);
    expect(r.status).toBe('needs-consent');
    expect(r.consentRequest).toMatchObject({
      primaryType: 'AgentWalletSet',
      domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: '84532' },
      message: {
        agentId: '42',
        newWallet: payout.address,
        owner: owner.address,
        deadline: NOW + 300,
      },
    });
    expect(JSON.parse(JSON.stringify(r.consentRequest))).toEqual(r.consentRequest);
    expect(d.setAgentWallet).not.toHaveBeenCalled();
  });

  it('rejects an expired consent and a key for the wrong address', async () => {
    const expired = await ensureAgentWallet(
      { ...base, consent: { deadline: NOW - 1, signature: '0x00' } },
      deps(),
    );
    expect(expired).toMatchObject({ status: 'failed' });
    expect(expired.error).toContain('expired');

    const wrong = await ensureAgentWallet({ ...base, payoutSigner: Wallet.createRandom() }, deps());
    expect(wrong.status).toBe('failed');
    expect(wrong.error).toContain('AGENT_PAYMENT_PK');
  });

  it('dry run reports would-set or needs-consent without sending', async () => {
    const d = deps();
    expect(
      (await ensureAgentWallet({ ...base, dryRun: true, payoutSigner: payout }, d)).status,
    ).toBe('would-set');
    expect((await ensureAgentWallet({ ...base, dryRun: true }, d)).status).toBe('needs-consent');
    expect(d.setAgentWallet).not.toHaveBeenCalled();
    expect(d.signConsent).not.toHaveBeenCalled();
  });

  it('treats a reverting getAgentWallet as unset, and a failed send as non-fatal', async () => {
    const d = deps();
    d.getAgentWallet.mockRejectedValue(new Error('revert'));
    d.setAgentWallet.mockRejectedValue(new Error('Not authorized'));
    const r = await ensureAgentWallet({ ...base, payoutSigner: payout }, d);
    expect(r).toMatchObject({ status: 'failed', error: 'Not authorized' });
  });
});
