import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { App } from "@capacitor/app";
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

  // Hide the native splash screen once the first paint is done.
  try {
    await SplashScreen.hide();
  } catch {
    /* not available */
  }

  // Android hardware back: navigate within the SPA instead of quitting.
  try {
    await App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack && window.history.length > 1) {
        window.history.back();
      } else {
        void App.minimizeApp();
      }
    });
  } catch {
    /* not available */
  }
}
