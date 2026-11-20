import type { ReputationModule } from './reputation';
import type { ReputationScore } from '../types';

export class AggregateModule {
  constructor(private reputation: ReputationModule) {}

  /**
   * Averages feedback from `clientAddresses` — pass the PoP-valid client set. Thresholds are on the
   * marketplace's own score scale, so they are parameters rather than constants.
   */
  async calculateReputation(
    agentId: bigint,
    clientAddresses: string[],
    thresholds: { minScore: number; minCount: bigint },
  ): Promise<ReputationScore> {
    const summary = await this.reputation.getSummary(agentId, clientAddresses);
    return {
      agentId,
      score: summary.averageScore,
      feedbackCount: summary.count,
      reliable: summary.averageScore >= thresholds.minScore && summary.count >= thresholds.minCount,
    };
  }
}
