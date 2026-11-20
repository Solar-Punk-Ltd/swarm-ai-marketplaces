import type { Contract, ContractEventName, EventLog, Log } from 'ethers';

/** Default `eth_getLogs` page size. The public Base Sepolia RPC caps a query at 200 blocks. */
export const DEFAULT_LOG_RANGE_MAX = 200;

/**
 * `contract.queryFilter` paged in `chunkSize`-block windows.
 *
 * Indexed-topic filters narrow the result set but do not lift an RPC's block-range cap, so every
 * scan over an open-ended range goes through here.
 */
export async function queryFilterChunked(
  contract: Contract,
  filter: ContractEventName,
  fromBlock: number,
  toBlock: number,
  chunkSize = DEFAULT_LOG_RANGE_MAX,
): Promise<(Log | EventLog)[]> {
  const results: (Log | EventLog)[] = [];

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const logs = await contract.queryFilter(filter, start, end);
    results.push(...logs);
  }
  return results;
}
