// Read-only subset of packages/contracts RevenueSplitter / SplitterFactory, for PoP verification.
export const REVENUE_SPLITTER_ABI = [
  'function seller() external view returns (address)',
  'function treasury() external view returns (address)',
  'function taxBps() external view returns (uint16)',
] as const;

export const SPLITTER_FACTORY_ABI = [
  'function splitterOf(address seller) external view returns (address)',
  'function treasury() external view returns (address)',
  'function defaultTaxBps() external view returns (uint16)',
] as const;
