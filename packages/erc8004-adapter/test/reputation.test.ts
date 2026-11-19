import { Interface, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { REPUTATION_REGISTRY_ABI } from '../src/abis/ReputationRegistry';
import { ReputationModule } from '../src/modules/reputation';
import { AggregateModule } from '../src/modules/aggregate';
import { REPUTATION_REGISTRY, buyer } from './fixtures';

const iface = new Interface(REPUTATION_REGISTRY_ABI);
const feedbackHash = keccak256(toUtf8Bytes('review bytes'));
const feedbackURI = `swarm-feed://${buyer.address}/${'ab'.repeat(32)}/0`;

/** A ReputationModule whose contract calls hit `stub` instead of an RPC. */
function moduleWith(stub: Record<string, jest.Mock>) {
  const mod = new ReputationModule(REPUTATION_REGISTRY, new JsonRpcProvider(), 84532n);
  const contract = (mod as unknown as { contract: Record<string, unknown> }).contract;
  (mod as unknown as { contract: unknown }).contract = {
    ...stub,
    target: REPUTATION_REGISTRY,
    interface: contract.interface,
    filters: contract.filters,
  };
  return mod;
}

function newFeedbackLog(feedbackIndex: bigint) {
  const { data, topics } = iface.encodeEventLog('NewFeedback', [
    42n,
    buyer.address,
    feedbackIndex,
    85n,
    0,
    '',
    '',
    '',
    '',
    feedbackURI,
    feedbackHash,
  ]);
  return { address: REPUTATION_REGISTRY, data, topics };
}

describe('postFeedback', () => {
  it('passes feedbackURI and the content hash through unchanged and returns the feedbackIndex', async () => {
    const giveFeedback = jest.fn(async () => ({
      wait: async () => ({ hash: '0xtx', blockNumber: 123, logs: [newFeedbackLog(7n)] }),
    }));
    const mod = moduleWith({ giveFeedback });

    const result = await mod.postFeedback({
      agentId: 42n,
      value: 85n,
      valueDecimals: 0,
      tag1: 'quality',
      feedbackURI,
      feedbackHash,
    });

    expect(giveFeedback).toHaveBeenCalledWith(
      42n,
      85n,
      0,
      'quality',
      '',
      '',
      feedbackURI,
      feedbackHash,
    );
    expect(result).toEqual({ txHash: '0xtx', feedbackIndex: 7n, blockNumber: 123 });
  });

  it('does not clamp scores — the marketplace owns the scale', async () => {
    const giveFeedback = jest.fn(async () => ({
      wait: async () => ({ hash: '0xtx', blockNumber: 1, logs: [newFeedbackLog(1n)] }),
    }));
    await moduleWith({ giveFeedback }).postFeedback({
      agentId: 42n,
      value: 950n,
      valueDecimals: 1,
      feedbackURI,
      feedbackHash,
    });
    expect(giveFeedback.mock.calls[0]).toEqual(expect.arrayContaining([950n, 1]));
  });

  it('rejects invalid decimals and non-hash feedbackHash before sending', async () => {
    const giveFeedback = jest.fn();
    const mod = moduleWith({ giveFeedback });
    await expect(
      mod.postFeedback({ agentId: 1n, value: 1n, valueDecimals: 19, feedbackURI, feedbackHash }),
    ).rejects.toThrow('valueDecimals');
    await expect(
      mod.postFeedback({
        agentId: 1n,
        value: 1n,
        valueDecimals: 0,
        feedbackURI,
        feedbackHash: feedbackURI,
      }),
    ).rejects.toThrow('feedbackHash');
    expect(giveFeedback).not.toHaveBeenCalled();
  });
});

describe('getSummary', () => {
  it('requires an explicit client set', async () => {
    const mod = moduleWith({ getSummary: jest.fn() });
    await expect(mod.getSummary(42n, [])).rejects.toThrow('non-empty client set');
  });

  it('treats summaryValue as the registry’s average (no second division)', async () => {
    const getSummary = jest.fn(async () => [4n, 875n, 1n]); // 4 reviews averaging 87.5
    const mod = moduleWith({ getSummary });
    const summary = await mod.getSummary(42n, [buyer.address]);
    expect(summary).toEqual({ count: 4n, averageScore: 87.5, rawValue: 875n, rawDecimals: 1 });
  });
});

describe('readAllFeedback / getClients', () => {
  it('passes a block tag only when one is given', async () => {
    const getClients = jest.fn(async () => [buyer.address]);
    const mod = moduleWith({ getClients });
    await mod.getClients(42n);
    await mod.getClients(42n, 999);
    expect(getClients.mock.calls[0]).toEqual([42n]);
    expect(getClients.mock.calls[1]).toEqual([42n, { blockTag: 999 }]);
  });

  it('zips the parallel arrays into entries and excludes revoked by default', async () => {
    const readAllFeedback = jest.fn(async () => [
      [buyer.address],
      [3n],
      [90n],
      [0n],
      ['quality'],
      [''],
      [false],
    ]);
    const mod = moduleWith({ readAllFeedback });
    const entries = await mod.readAllFeedback(42n, [buyer.address], { blockTag: 50 });
    expect(readAllFeedback).toHaveBeenCalledWith(42n, [buyer.address], '', '', false, {
      blockTag: 50,
    });
    expect(entries).toEqual([
      {
        clientAddress: buyer.address,
        feedbackIndex: 3n,
        value: 90n,
        valueDecimals: 0,
        score: 90,
        tag1: 'quality',
        tag2: '',
        isRevoked: false,
      },
    ]);
  });
});

describe('AggregateModule', () => {
  it('scores only the given clients against caller-supplied thresholds', async () => {
    const getSummary = jest.fn(async () => [3n, 8n, 0n]);
    const aggregate = new AggregateModule(moduleWith({ getSummary }));
    const clients = [buyer.address, Wallet.createRandom().address];
    const score = await aggregate.calculateReputation(42n, clients, { minScore: 7, minCount: 3n });
    expect(getSummary).toHaveBeenCalledWith(42n, clients, '', '');
    expect(score).toEqual({ agentId: 42n, score: 8, feedbackCount: 3n, reliable: true });
  });
});
