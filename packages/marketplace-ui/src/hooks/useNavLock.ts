import { createContext, useContext, useEffect } from 'react';

/**
 * Lets a page hide the top nav while leaving would cost the visitor something.
 *
 * The claim page is the one user: its buyer agent is shut down when the visitor leaves, so a tap
 * on "Dashboard" mid-run would throw away the purchase they are watching. Before Start and after
 * delivery there is nothing to lose, so the nav is there — the Devcon8 tab leads to this page, and
 * a page with no way back would be a dead end.
 *
 * `AppShell` provides the setter; outside it this is a no-op.
 */
export const NavLockContext = createContext<(locked: boolean) => void>(() => {});

export function useNavLock(locked: boolean): void {
  const setLocked = useContext(NavLockContext);
  useEffect(() => {
    setLocked(locked);
    return () => setLocked(false);
  }, [locked, setLocked]);
}
