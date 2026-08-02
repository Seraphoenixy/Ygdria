import { Capacitor } from "@capacitor/core";

/**
 * Decide whether the *native* shell should use the single-column phone layout
 * (bottom tab bar + full-screen drawers) or fall back to the larger
 * tablet-intermediate / desktop layout.
 *
 * Not every native build is a phone: an iPad (or any tablet) is far more
 * comfortable with the inline tree + 48px rail + drawer-inspector layout that
 * the 681–900px breakpoint already provides. We therefore gate the phone
 * layout on a *short-side* heuristic plus a coarse-pointer check rather than
 * blindly forcing it for every native platform.
 *
 * - Short side > 680px  → treated as a tablet (inline layout).
 * - Fine pointer        → treated as a desktop-class device (Chromebook, etc.).
 * - Otherwise (small, touch) → phone layout.
 */
export function isNativePhone(): boolean {
  if (!Capacitor.isNativePlatform() || typeof window === "undefined") return false;
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  if (shortSide > 680) return false;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  if (!coarsePointer) return false;
  return true;
}

/** True when the phone layout (`.phone` class) should be active: a native
 *  handset OR a browser/PWA viewport narrow enough to need it. */
export function isPhoneLayout(): boolean {
  if (typeof window === "undefined") return false;
  return isNativePhone() || window.matchMedia("(max-width: 680px)").matches;
}
