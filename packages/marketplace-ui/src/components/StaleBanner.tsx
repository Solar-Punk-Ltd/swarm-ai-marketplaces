import { useMarketplace } from '../context/MarketplaceContext';
import OperatorDetails from './OperatorDetails';
import styles from './styles.module.css';

export default function StaleBanner() {
  const { stale, error } = useMarketplace();
  if (!stale) return null;
  return (
    <div className={`${styles.banner} ${styles.bannerDanger}`}>
      Live updates paused — showing the last values that loaded. Retrying automatically.
      <OperatorDetails>{error}</OperatorDetails>
    </div>
  );
}
