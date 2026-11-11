import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { SplashScreen } from "@capacitor/splash-screen";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

let initialized = false;

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** Light haptic feedback. Safe to call on any platform (no-op on web). */
export function haptic(): void {
  if (!isNative()) return;
  try {
    void Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* plugin not available */
  }
}

/**
 * Apply Capacitor-native UX tweaks once React has mounted. The web/desktop
 * bundles import this module but `initCapacitor` early-returns off-device, so
 * the SPA keeps working unchanged in a browser or Electron.
 */
export async function initCapacitor(): Promise<void> {
  if (initialized || !isNative()) return;
  initialized = true;
  document.body.classList.add("capacitor-native");

  // Status bar: let content run underneath and follow the system appearance.
  try {
    await StatusBar.setOverlaysWebView({ overlay: true });
    const dark =
      window.matchMedia?.("(prefers-color-scheme: dark)").matches ??
      document.documentElement.getAttribute("data-theme") === "dark";
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch {
    /* not available */
  }

  // Soft keyboard must not cover the editor on iOS.
  try {
    Keyboard.setResizeMode({ mode: KeyboardResize.Native });
  } catch {
    /* not available */
  }

  // While the IME is open the phone layout is shorter and the bottom tab bar
  // would sit directly above the keyboard, eating roughly 56dp of the editing
  // area and separating the caret from the keyboard. Hide it (and reclaim the
  // space it reserved under the document) for the duration of the IME.
  try {
    const show = () => document.documentElement.classList.add("keyboard-open");
    const hide = () => document.documentElement.classList.remove("keyboard-open");
    await Keyboard.addListener("keyboardWillShow", show);
    await Keyboard.addListener("keyboardDidShow", show);
    await Keyboard.addListener("keyboardWillHide", hide);
    await Keyboard.addListener("keyboardDidHide", hide);
  } catch {
    /* not available */
  }

  // Hide the native splash screen once the first paint is done.
  try {
    await SplashScreen.hide();
  } catch {
    /* not available */
  }
}
