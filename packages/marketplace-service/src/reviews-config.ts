import type { RequestHandler } from 'express';
import type { ReviewMarketplaceConfig } from '@solarpunk/erc8004-adapter';
import type { ServiceConfig } from './config.js';

/** The JSON body of GET /v1/reviews/config. Bigints are decimal strings. */
export interface PublicReviewConfig {
  chainId: string;
  identityRegistry: string;
  reputationRegistry: string;
  splitterFactory: string;
  splitterTerms: { treasury: string; taxBps: number }[];
  score: { min: number; max: number; decimals: number };
  valueFloor: { asset: string; amount: string }[];
  acceptedAssets: string[];
  maxChunksPerRequest: number;
  maxEnvelopesPerPurchase: number;
  requestMaxAgeSeconds: number;
}

export function publicReviewConfig(
  review: ReviewMarketplaceConfig,
  config: Pick<
    ServiceConfig,
    'score' | 'maxChunksPerRequest' | 'maxEnvelopesPerPurchase' | 'requestMaxAgeSeconds'
  >,
): PublicReviewConfig {
  return {
    chainId: review.chainId.toString(),
    identityRegistry: review.identityRegistry,
    reputationRegistry: review.reputationRegistry,
    splitterFactory: review.splitterFactory,
    splitterTerms: review.splitterTerms,
    score: config.score,
    valueFloor: review.valueFloor.map((f) => ({ asset: f.asset, amount: f.amount.toString() })),
    acceptedAssets: review.acceptedAssets,
    maxChunksPerRequest: config.maxChunksPerRequest,
    maxEnvelopesPerPurchase: config.maxEnvelopesPerPurchase,
    requestMaxAgeSeconds: config.requestMaxAgeSeconds,
  };
}

/** GET /v1/reviews/config — this marketplace's terms, so buyer tools hardcode nothing. */
export function reviewConfigHandler(body: PublicReviewConfig): RequestHandler {
  return (_req, res) => {
    res.json(body);
  };
}
