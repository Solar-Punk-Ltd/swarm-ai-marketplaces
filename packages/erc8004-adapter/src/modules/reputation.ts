import {
  Contract,
  type BlockTag,
  type EventLog,
  type Log,
  type Provider,
  type Signer,
} from 'ethers';
import { REPUTATION_REGISTRY_ABI } from '../abis/ReputationRegistry';
import { queryFilterChunked } from '../utils/logs';
import type {
  FeedbackEntry,
  FeedbackResult,
  FeedbackRevokedEvent,
  LogQueryOptions,
  NewFeedbackEvent,
  PostFeedbackParams,
  PostFeedbackResult,
  ReputationSummary,
  ResponseAppendedEvent,
} from '../types';

/** Registry limit on `valueDecimals` (ERC-8004). */
const MAX_VALUE_DECIMALS = 18;

export class ReputationModule {
  private contract: Contract;
  private provider: Provider;
  private chainId: bigint;

  constructor(address: string, signerOrProvider: Signer | Provider, chainId: bigint) {
    this.contract = new Contract(address, REPUTATION_REGISTRY_ABI, signerOrProvider);
    this.provider =
      'provider' in signerOrProvider && signerOrProvider.provider
        ? signerOrProvider.provider
        : (signerOrProvider as Provider);
    this.chainId = chainId;
  }

  get contractAddress(): string {
    return this.contract.target as string;
  }

  get networkChainId(): bigint {
    return this.chainId;
  }

  // The caller becomes the feedback's clientAddress. No provider authorization is involved: the
  // live registry is permissionless apart from rejecting the agent's own owner/operators.
  async postFeedback(params: PostFeedbackParams): Promise<PostFeedbackResult> {
    if (
      !Number.isInteger(params.valueDecimals) ||
      params.valueDecimals < 0 ||
      params.valueDecimals > MAX_VALUE_DECIMALS
    ) {
      throw new Error(`valueDecimals must be an integer 0–${MAX_VALUE_DECIMALS}`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(params.feedbackHash)) {
      throw new Error('feedbackHash must be a 0x-prefixed 32-byte hex string');
    }

    const tx = await this.contract.giveFeedback(
      params.agentId,
      params.value,
      params.valueDecimals,
      params.tag1 ?? '',
      params.tag2 ?? '',
      params.endpoint ?? '',
      params.feedbackURI,
      params.feedbackHash,
    );
    const receipt = await tx.wait();

    const event = this.parseReceiptLog(receipt.logs, 'NewFeedback');
    if (!event) throw new Error(`NewFeedback event not found in tx ${receipt.hash}`);

    return {
      txHash: receipt.hash as string,
      feedbackIndex: event.args.feedbackIndex as bigint,
      blockNumber: receipt.blockNumber as number,
    };
  }

  async revokeFeedback(agentId: bigint, feedbackIndex: bigint): Promise<string> {
    const tx = await this.contract.revokeFeedback(agentId, feedbackIndex);
    const receipt = await tx.wait();
    return receipt.hash as string;
  }

  // Anyone may respond to a feedback entry (typically the agent, as a rebuttal).
  async appendResponse(
    agentId: bigint,
    clientAddress: string,
    feedbackIndex: bigint,
    responseURI: string,
    responseHash: string,
  ): Promise<string> {
    const tx = await this.contract.appendResponse(
      agentId,
      clientAddress,
      feedbackIndex,
      responseURI,
      responseHash,
    );
    const receipt = await tx.wait();
    return receipt.hash as string;
  }

  async getFeedback(
    agentId: bigint,
    clientAddress: string,
    feedbackIndex: bigint,
  ): Promise<FeedbackResult> {
    const [value, valueDecimals, tag1, tag2, isRevoked] = (await this.contract.readFeedback(
      agentId,
      clientAddress,
      feedbackIndex,
    )) as [bigint, bigint, string, string, boolean];

    return {
      value,
      valueDecimals: Number(valueDecimals),
      score: toDecimal(value, Number(valueDecimals)),
      tag1,
      tag2,
      isRevoked,
    };
  }

  /** Pass `blockTag` (archive RPC) to read the client set as it stood at a checkpoint. */
  async getClients(agentId: bigint, blockTag?: BlockTag): Promise<string[]> {
    return [...((await this.contract.getClients(agentId, ...callOverrides(blockTag))) as string[])];
  }

  /**
   * Every feedback entry from `clientAddresses`. Empty `tag1`/`tag2` mean "no filter" in the
   * reference registry. Pass `blockTag` (archive RPC) to read state at a checkpoint; split large
   * client sets across calls to stay within RPC gas/response limits.
   */
  async readAllFeedback(
    agentId: bigint,
    clientAddresses: string[],
    options: { tag1?: string; tag2?: string; includeRevoked?: boolean; blockTag?: BlockTag } = {},
  ): Promise<FeedbackEntry[]> {
    const [clients, indexes, values, decimals, tag1s, tag2s, revoked] =
      (await this.contract.readAllFeedback(
        agentId,
        clientAddresses,
        options.tag1 ?? '',
        options.tag2 ?? '',
        options.includeRevoked ?? false,
        ...callOverrides(options.blockTag),
      )) as [string[], bigint[], bigint[], bigint[], string[], string[], boolean[]];

    return clients.map((clientAddress, i) => ({
      clientAddress,
      feedbackIndex: indexes[i],
      value: values[i],
      valueDecimals: Number(decimals[i]),
      score: toDecimal(values[i], Number(decimals[i])),
      tag1: tag1s[i],
      tag2: tag2s[i],
      isRevoked: revoked[i],
    }));
  }

  /**
   * The registry's average over `clientAddresses`. The client set is required: ERC-8004 leaves
   * Sybil resistance to the caller, so pass the PoP-valid set, never `getClients()`.
   */
  async getSummary(
    agentId: bigint,
    clientAddresses: string[],
    tag1 = '',
    tag2 = '',
  ): Promise<ReputationSummary> {
    if (clientAddresses.length === 0) {
      throw new Error('getSummary requires a non-empty client set (the PoP-valid clients)');
    }

    const [count, summaryValue, summaryDecimals] = (await this.contract.getSummary(
      agentId,
      clientAddresses,
      tag1,
      tag2,
    )) as [bigint, bigint, bigint];

    // summaryValue is already the average — the registry divides by count itself.
    return {
      count,
      averageScore: count > 0n ? toDecimal(summaryValue, Number(summaryDecimals)) : 0,
      rawValue: summaryValue,
      rawDecimals: Number(summaryDecimals),
    };
  }

  async getNewFeedbackEvents(
    agentId: bigint | null, // null = every agent (indexers)
    options: LogQueryOptions & { clientAddress?: string },
  ): Promise<NewFeedbackEvent[]> {
    const filter = this.contract.filters.NewFeedback(agentId, options.clientAddress ?? null);
    const logs = await this.scan(filter, options);
    return logs.map((log) => {
      const { args, meta } = this.parseLog(log);
      return {
        ...meta,
        agentId: args.agentId as bigint,
        clientAddress: args.clientAddress as string,
        feedbackIndex: args.feedbackIndex as bigint,
        value: args.value as bigint,
        valueDecimals: Number(args.valueDecimals),
        tag1: args.tag1 as string,
        tag2: args.tag2 as string,
        endpoint: args.endpoint as string,
        feedbackURI: args.feedbackURI as string,
        feedbackHash: args.feedbackHash as string,
      };
    });
  }

  async getFeedbackRevokedEvents(
    agentId: bigint | null, // null = every agent (indexers)
    options: LogQueryOptions & { clientAddress?: string },
  ): Promise<FeedbackRevokedEvent[]> {
    const filter = this.contract.filters.FeedbackRevoked(agentId, options.clientAddress ?? null);
    const logs = await this.scan(filter, options);
    return logs.map((log) => {
      const { args, meta } = this.parseLog(log);
      return {
        ...meta,
        agentId: args.agentId as bigint,
        clientAddress: args.clientAddress as string,
        feedbackIndex: args.feedbackIndex as bigint,
      };
    });
  }

  async getResponseAppendedEvents(
    agentId: bigint | null, // null = every agent (indexers)
    options: LogQueryOptions & { clientAddress?: string },
  ): Promise<ResponseAppendedEvent[]> {
    const filter = this.contract.filters.ResponseAppended(agentId, options.clientAddress ?? null);
    const logs = await this.scan(filter, options);
    return logs.map((log) => {
      const { args, meta } = this.parseLog(log);
      return {
        ...meta,
        agentId: args.agentId as bigint,
        clientAddress: args.clientAddress as string,
        feedbackIndex: args.feedbackIndex as bigint,
        responder: args.responder as string,
        responseURI: args.responseURI as string,
        responseHash: args.responseHash as string,
      };
    });
  }

  private async scan(
    filter: ReturnType<Contract['filters'][string]>,
    options: LogQueryOptions,
  ): Promise<(Log | EventLog)[]> {
    const toBlock = options.toBlock ?? (await this.provider.getBlockNumber());
    return queryFilterChunked(this.contract, filter, options.fromBlock, toBlock, options.chunkSize);
  }

  private parseLog(log: Log | EventLog) {
    const parsed = this.contract.interface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed) throw new Error(`Unparseable registry log in tx ${log.transactionHash}`);
    return {
      args: parsed.args,
      meta: {
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      },
    };
  }

  private parseReceiptLog(logs: readonly Log[], eventName: string) {
    const target = (this.contract.target as string).toLowerCase();
    for (const log of logs) {
      if (log.address.toLowerCase() !== target) continue;
      const parsed = this.contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === eventName) return parsed;
    }
    return null;
  }
}

/** `eth_call` overrides: only pass a block tag when one was asked for. */
function callOverrides(blockTag?: BlockTag): [{ blockTag: BlockTag }] | [] {
  return blockTag === undefined ? [] : [{ blockTag }];
}

/** Fixed-point → decimal number. Display-only: comparisons should use the raw bigint. */
function toDecimal(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}
