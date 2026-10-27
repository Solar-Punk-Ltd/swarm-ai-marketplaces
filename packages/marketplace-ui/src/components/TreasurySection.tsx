import { useMarketplace } from '../context/MarketplaceContext';
import { config } from '../config/env';
import { formatTaxBps } from '../lib/format';
import AddressLink from './AddressLink';
import Balance, { Skeleton } from './Balance';
import DistributeAllButton from './DistributeAllButton';
import OperatorDetails from './OperatorDetails';
import { TreasuryIcon } from './icons';
import RoleTip from './RoleTip';
import styles from './styles.module.css';

export default function TreasurySection() {
  const { registry, balances } = useMarketplace();

  // The factory's treasury is the address clones actually pay into. If VITE_TREASURY_ADDRESS
  // points somewhere else, the balances on this card are not the marketplace's revenue.
  const factoryTreasury = registry?.factory.treasury;
  const mismatch =
    factoryTreasury !== undefined &&
    factoryTreasury.toLowerCase() !== config.treasury.toLowerCase();

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Treasury</h2>
      </div>

      {mismatch && (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          This treasury is not the one sellers pay into.
          <OperatorDetails>
            VITE_TREASURY_ADDRESS does not match the factory&rsquo;s treasury ({factoryTreasury}).
            New clones will pay into the factory&rsquo;s address, not this one.
          </OperatorDetails>
        </div>
      )}

      <div className={styles.card}>
        <div className={styles.sellerTop}>
          <div className={styles.splitterFacts}>
            <RoleTip label="Marketplace treasury">
              <TreasuryIcon size={40} />
            </RoleTip>
            <AddressLink address={config.treasury} />
          </div>
          <DistributeAllButton />
        </div>

        <div className={styles.stats}>
          {config.currencies.map((currency) => (
            <div key={currency.symbol} className={styles.stat}>
              <div className={styles.statLabel}>{currency.symbol}</div>
              <div className={styles.statValue}>
                <Balance amount={balances?.treasury[currency.symbol]} currency={currency} />
              </div>
            </div>
          ))}

          <div className={styles.stat}>
            {/* Existing clones freeze their own taxBps at creation, so this is not what current
                sellers necessarily pay — each seller's details show its own rate. */}
            <div
              className={styles.statLabel}
              title="Applies to splitters created from now on. Existing splitters keep the rate frozen at creation."
            >
              Default rate (new sellers)
            </div>
            <div className={styles.statValue}>
              {registry ? formatTaxBps(registry.factory.defaultTaxBps) : <Skeleton width={48} />}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
