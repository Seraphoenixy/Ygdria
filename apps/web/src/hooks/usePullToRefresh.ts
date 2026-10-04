import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

/** Pure pull math shared with the unit tests. */
export function pullDistance(rawDeltaPx: number): number {
  if (rawDeltaPx <= 0) return 0;
  // Resistance: the first 20px map 1:1, beyond that each extra pixel adds 0.35.
  return Math.min(20 + Math.max(0, rawDeltaPx - 20) * 0.35, 96);
}

export const PULL_TRIGGER_PX = 56;

type PullToRefreshOptions = {
  onRefresh: () => Promise<void>;
};

/**
 * Pull-to-refresh for the phone layout. Tracks a downward drag that starts at
 * the top of a scrolling tab container (`.document-scroll`), shows a rubber
 * band indicator, and triggers a full data refresh past the threshold.
 *
 * Native overscroll rubber-banding is already disabled for the app shell
 * (capacitor.css `overscroll-behavior-y: none`), so the tracked distance is
 * the only movement the user sees. Listeners are passive: the container is
 * already at scrollTop 0, so an extra downward drag scrolls nothing.
 */
export function usePullToRefresh({ onRefresh }: PullToRefreshOptions): {
  pull: number;
  refreshing: boolean;
} {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const isPhone =
      Capacitor.isNativePlatform() || window.matchMedia("(max-width: 680px)").matches;
    if (!isPhone) return;

    let startY = 0;
    let tracking = false;

    const reset = () => {
      pullRef.current = 0;
      setPull(0);
    };

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || refreshingRef.current) return;
      const touch = event.touches[0];
      const target = touch.target as HTMLElement | null;
      if (!target) return;
      // Never hijack text editing or horizontal scrolling.
      if (isEditableTarget(target) || isHorizontallyScrollable(target)) return;
      // The drag must start inside a scrolling tab container pinned to the top.
      const scroller = target.closest(".document-scroll") as HTMLElement | null;
      if (!scroller || scroller.scrollTop > 0) return;
      startY = touch.clientY;
      tracking = true;
    };

    const onMove = (event: TouchEvent) => {
      if (!tracking) return;
      const distance = pullDistance(event.touches[0].clientY - startY);
      pullRef.current = distance;
      setPull(distance);
    };

    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (pullRef.current < PULL_TRIGGER_PX) {
        reset();
        return;
      }
      refreshingRef.current = true;
      setRefreshing(true);
      setPull(PULL_TRIGGER_PX);
      void Promise.resolve()
        .then(onRefresh)
        .catch((error) => console.error("Pull-to-refresh failed", error))
        .finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          reset();
        });
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
    };
  }, [onRefresh]);

  return { pull, refreshing };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

function isHorizontallyScrollable(target: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll|overlay/.test(style.overflowX)) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}
