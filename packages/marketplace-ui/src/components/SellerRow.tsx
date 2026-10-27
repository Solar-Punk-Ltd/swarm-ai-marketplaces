import { useMemo, useState } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { config } from '../config/env';
import { erc20Currencies } from '../config/currencies';
import { formatTaxBps } from '../lib/format';
import { isFunded, totalPending } from '../lib/reads';
import type { SellerRecord } from '../lib/reads';
import AddressLink from './AddressLink';
import AgentBadge from './AgentBadge';
import CatalogLink from './CatalogLink';
import Balance, { Skeleton, formatAmount } from './Balance';
import DistributeButton from './DistributeButton';
import HistoryTable from './HistoryTable';
import AgentFace from './AgentFace';
import RoleTip from './RoleTip';
import styles from './styles.module.css';

/**
 * One seller, in one line: who it is, what it has earned that is waiting to be paid out, and the
 * button that pays it out. Everything an operator needs only when investigating — the addresses,
 * the seller's own wallet, the frozen tax rate, the split and the row's activity — sits behind
 * "Details", laid out as the decks' ledger: dotted key/value rows.
 */
export default function SellerRow({ record }: { record: SellerRecord }) {
  const { balances, history, agentLinks } = useMarketplace();
  const [open, setOpen] = useState(false);

  // Filtered from the single global sweep — a row must never fetch its own logs.
  const rowHistory = useMemo(
    () => history.entries.filter((e) => e.splitter.toLowerCase() === record.splitter.toLowerCase()),
    [history.entries, record.splitter],
  );

  const sellerBalances = balances?.sellers[record.seller];
  const pendingMap = balances?.splitters[record.splitter];
  const funded = isFunded(pendingMap);
  const link = agentLinks.bySplitter.get(record.splitter.toLowerCase());
  const linked = link !== undefined;

  // ERC-20 only. RevenueSplitter has no receive(), so a clone's ETH balance is structurally zero
  // and rendering it here would read as a bug.
  const tokens = erc20Currencies(config.currencies);

  return (
    <div className={styles.sellerCard}>
      <div className={styles.sellerTop}>
        <div className={styles.splitterFacts}>
          {/* The agent's own avatar when its card has one that loads, its stall otherwise —
              dimmed when no agent has claimed this splitter. */}
          <RoleTip label={linked ? 'Seller agent' : 'Seller · no agent linked'}>
            <AgentFace link={link} size={40} muted={!linked} />
          </RoleTip>
          <AgentBadge splitter={record.splitter} seller={record.seller} />
          <CatalogLink splitter={record.splitter} />
          {/* With no agent to name it, the seller's address is the only identity the row has. */}
          {!linked && <AddressLink address={record.seller} label="Seller" />}
        </div>

        <div className={styles.sellerEarned}>
          {tokens.map((currency) => {
            const split = pendingMap?.[currency.symbol];
            return (
              <div key={currency.symbol} className={styles.sellerEarnedValue}>
                <div className={styles.balanceLabel}>To distribute</div>
                <div className={`${styles.accrued} ${funded ? styles.accruedLive : ''}`}>
                  {split === undefined ? (
                    <Skeleton />
                  ) : (
                    <>
                      {formatAmount(totalPending(split), currency)}
                      <span className={styles.inlineBalanceUnit}>{currency.symbol}</span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <DistributeButton splitter={record.splitter} funded={funded} />
        </div>
      </div>

      <button
        type="button"
        className={styles.historyToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} details
        <span className={styles.historyCount}>
          {rowHistory.length} event{rowHistory.length === 1 ? '' : 's'}
        </span>
      </button>

      {open && (
        <div className={styles.sellerDetails}>
          <dl className={styles.ledger}>
            {linked && (
              <div className={styles.ledgerRow}>
                <dt>Seller</dt>
                <dd>
                  <AddressLink address={record.seller} />
                </dd>
              </div>
            )}
            <div className={styles.ledgerRow}>
              <dt title="The seller's own wallet. Not marketplace revenue.">Seller wallet</dt>
              <dd className={styles.inlineBalances}>
                {config.currencies.map((currency) => (
                  <Balance
                    key={currency.symbol}
                    amount={sellerBalances?.[currency.symbol]}
                    currency={currency}
                  />
                ))}
              </dd>
            </div>
            <div className={styles.ledgerRow}>
              <dt title="The contract every sale is paid into. It splits revenue between seller and treasury.">
                Splitter contract
              </dt>
              <dd>
                <AddressLink address={record.splitter} />
              </dd>
            </div>
            <div className={styles.ledgerRow}>
              <dt title="Share of every sale forwarded to the marketplace treasury. Frozen when the splitter was created.">
                Marketplace tax
              </dt>
              <dd>{formatTaxBps(record.taxBps)}</dd>
            </div>
            {tokens.map((currency) => {
              const split = pendingMap?.[currency.symbol];
              if (split === undefined) return null;
              return (
                <div key={currency.symbol} className={styles.ledgerRow}>
                  <dt>Distribution would pay</dt>
                  <dd>
                    {formatAmount(split.sellerAmount, currency)} seller ·{' '}
                    {formatAmount(split.treasuryAmount, currency)} treasury
                  </dd>
                </div>
              );
            })}
          </dl>

          <HistoryTable
            entries={rowHistory}
            showSeller={false}
            initial={5}
            emptyLabel="No activity for this seller in the scanned window."
          />
        </div>
      )}
    </div>
  );
}
