import express from 'express';
import { Bee } from '@ethersphere/bee-js';
import { Contract, JsonRpcProvider, getAddress } from 'ethers';
import {
  SPLITTER_FACTORY_ABI,
  createERC8004Client,
  createPoPChainReader,
  findAnchoredPurchase,
  verifyPoP,
  type ReviewMarketplaceConfig,
} from '@solarpunk/erc8004-adapter';
import { BatchManager } from './batches.js';
import { loadConfig, type ServiceConfig } from './config.js';
import { Store } from './db.js';
import { envelopesHandler } from './envelopes.js';
import { publicReviewConfig, reviewConfigHandler } from './reviews-config.js';

// Without SPLITTER_TERMS, accept the terms the factory currently stamps on new clones.
async function resolveSplitterTerms(
  config: ServiceConfig,
  provider: JsonRpcProvider,
): Promise<{ treasury: string; taxBps: number }[]> {
  if (config.splitterTerms) return config.splitterTerms;
  const factory = new Contract(config.splitterFactory, SPLITTER_FACTORY_ABI, provider);
  const [treasury, taxBps] = await Promise.all([
    factory.treasury() as Promise<string>,
    factory.defaultTaxBps() as Promise<bigint>,
  ]);
  return [{ treasury: getAddress(treasury), taxBps: Number(taxBps) }];
}

async function main(): Promise<void> {
  const config = loadConfig();

  const provider = new JsonRpcProvider(config.rpcUrl, Number(config.chainId));
  const archiveProvider = config.archiveRpcUrl
    ? new JsonRpcProvider(config.archiveRpcUrl, Number(config.chainId))
    : undefined;

  const erc8004 = createERC8004Client({
    provider,
    chain: config.erc8004Chain,
    contracts: {
      identityRegistry: config.identityRegistry,
      reputationRegistry: config.reputationRegistry,
    },
  });
  if (erc8004.reputation.networkChainId !== config.chainId) {
    throw new Error(
      `ERC8004_CHAIN "${config.erc8004Chain}" is chain ${erc8004.reputation.networkChainId}, NETWORK is ${config.network}`,
    );
  }

  const reviewConfig: ReviewMarketplaceConfig = {
    chainId: config.chainId,
    identityRegistry: getAddress(erc8004.identity.contractAddress),
    reputationRegistry: getAddress(erc8004.reputation.contractAddress),
    splitterFactory: config.splitterFactory,
    splitterTerms: await resolveSplitterTerms(config, provider),
    acceptedAssets: config.acceptedAssets,
    valueFloor: config.valueFloor,
  };

  const bee = new Bee(config.beeApiUrl);
  const store = new Store(config.dbPath);
  const batches = new BatchManager(bee, store, config.reviewBatch);
  const reader = createPoPChainReader({
    provider,
    archiveProvider,
    identityRegistry: reviewConfig.identityRegistry,
  });

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/v1/reviews/config', reviewConfigHandler(publicReviewConfig(reviewConfig, config)));
  app.post(
    '/v1/reviews/envelopes',
    envelopesHandler({
      config,
      store,
      batches,
      bee: { createEnvelope: (batchId, address) => bee.createEnvelope(batchId, address) },
      verifyPoP: (input) => verifyPoP(input, reader, reviewConfig),
      findAnchoredPurchase: (params) =>
        findAnchoredPurchase(
          { reputation: erc8004.reputation, bee, config: reviewConfig },
          { ...params, chunkSize: config.logRangeMax },
        ),
    }),
  );

  app.listen(config.port, () => {
    console.log(`Marketplace service listening on port ${config.port}`);
    console.log(
      `Accepting splitters of factory ${reviewConfig.splitterFactory} with terms ` +
        reviewConfig.splitterTerms.map((t) => `${t.treasury}@${t.taxBps}bps`).join(', '),
    );
    if (!config.archiveRpcUrl) {
      console.warn(
        'ARCHIVE_RPC_URL is unset — PoP checks read past state from RPC_URL, which must then be an archive node.',
      );
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
