import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

/**
 * Central Android hardware-back dispatcher for the native shell.
 *
 * Capacitor's `backButton` event is global; without a dispatcher every React
 * view that wants to consume it would have to add its own listener (and the
 * last one registered would win non-deterministically). Instead, views register
 * a handler that returns `true` when it handled the back press. Handlers run
 * most-recently-registered first, which naturally gives the topmost overlay
 * (dialog / drawer / editor) the chance to close before navigation goes back a
 * tab.
 *
 * When no handler claims the press we minimize the app, matching the platform
 * expectation of leaving the task instead of killing it.
 */
export type AndroidBackHandler = () => boolean;

const handlers = new Set<AndroidBackHandler>();
let listening = false;

function dispatchBack(): void {
  for (const handler of Array.from(handlers).reverse()) {
    try {
      if (handler()) return;
    } catch (error) {
      console.error("Android back handler failed", error);
    }
  }
  void App.minimizeApp();
}

/**
 * Register a back handler. Returns an unregister function; call it from the
 * effect cleanup. The native listener is installed lazily on the first
 * registration and only on native platforms.
 */
export function registerAndroidBackHandler(handler: AndroidBackHandler): () => void {
  handlers.add(handler);
  if (!listening && Capacitor.isNativePlatform()) {
    listening = true;
    void App.addListener("backButton", dispatchBack);
  }
  return () => {
    handlers.delete(handler);
  };
}
