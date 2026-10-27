import { useEffect, useRef } from 'react';
import '../vendor/buyer-agent-anim.js';

/**
 * The buyer agent's story beside the Claim wallet checklist — see `vendor/buyer-agent-anim.js`.
 *
 * The script owns its own pacing: it never steps backwards and plays every scene in order for its
 * minimum time, so a poll that jumps several steps at once still reads as a story. This wrapper
 * therefore just forwards the step; it must not try to sequence or debounce anything itself.
 */

export type AnimStep =
  | 'created'
  | 'funded'
  | 'started'
  | 'discover'
  | 'discovered'
  | 'purchase'
  | 'finalize'
  | 'download'
  | 'done'
  | 'error';

interface AnimHandle {
  setStep(step: AnimStep): void;
  destroy(): void;
}

declare global {
  interface Window {
    BuyerAgentAnim: {
      mount(el: HTMLElement, opts?: { step?: AnimStep; settled?: boolean }): AnimHandle;
    };
  }
}

export default function BuyerAgentAnim({
  step,
  settled = false,
  className,
}: {
  step: AnimStep;
  /**
   * Open on `step`'s scene instead of playing the story up to it. For a run that finished before
   * this page saw it (restored from `deliveredStore`, or reattached after a reload): replaying it
   * above a key already on screen reads as a second purchase, and hiding it reads as breakage.
   * Read once, at mount.
   */
  settled?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<AnimHandle>();

  // Mounted once. `destroy` removes the SVG, so StrictMode's double mount leaves exactly one.
  useEffect(() => {
    if (!box.current) return;
    const anim = window.BuyerAgentAnim.mount(box.current, settled ? { step, settled } : undefined);
    handle.current = anim;
    return () => {
      anim.destroy();
      handle.current = undefined;
    };
    // Mount-time only by design: `settled` and the opening `step` are read once.
  }, []);

  // Declared after the mount effect, so on first render it runs second and finds the handle.
  useEffect(() => {
    handle.current?.setStep(step);
  }, [step]);

  return <div ref={box} className={className} />;
}
