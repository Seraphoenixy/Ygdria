import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

/**
 * Edge-swipe gestures for the phone layout.
 *
 * - When the note-tree drawer is closed, a horizontal swipe starting from the
 *   left screen edge (≤ 28px) opens it.
 * - When the drawer is open, a leftward swipe starting ON the drawer surface
 *   (or its scrim) closes it.
 *
 * Only attaches on phones (narrow viewport or native shell) so desktop is
 * untouched. Listeners are passive; we only read coordinates, never prevent
 * default scrolling.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable === true
  );
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

export function useMobileGestures({
  treeOpen,
  onOpenTree,
  onCloseTree,
}: {
  treeOpen: boolean;
  onOpenTree: () => void;
  onCloseTree: () => void;
}) {
  useEffect(() => {
    const isPhone =
      Capacitor.isNativePlatform() || window.matchMedia("(max-width: 680px)").matches;
    if (!isPhone) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let startedOnDrawer = false;

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const target = event.touches[0].target as HTMLElement | null;
      // Never hijack text selection, editing, or horizontal scrolling
      // (editor panes, code blocks, tables, carousels).
      if (isEditableTarget(target) || isHorizontallyScrollable(target)) {
        tracking = false;
        return;
      }
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      startedOnDrawer = Boolean(
        target && target.closest(".note-tree-panel, .tree-drawer-scrim"),
      );
      tracking = true;
    };

    const onMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return;
      const dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      // Ignore mostly-vertical drags (e.g. scrolling the document).
      if (Math.abs(dx) < Math.abs(dy)) return;
      if (treeOpen) {
        // Only close when the gesture began on the drawer surface / scrim.
        if (startedOnDrawer && dx < -50) {
          onCloseTree();
          tracking = false;
        }
      } else if (startX <= 28 && dx > 60) {
        onOpenTree();
        tracking = false;
      }
    };

    const onEnd = () => {
      tracking = false;
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
    };
  }, [treeOpen, onOpenTree, onCloseTree]);
}
