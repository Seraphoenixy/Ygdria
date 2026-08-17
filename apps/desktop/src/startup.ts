export type StartupFailureDialog = {
  title: string;
  message: string;
  detail: string;
};

export function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "EADDRINUSE" || isAddressInUseError(candidate.cause);
}

export function startupFailureDialog(error: unknown): StartupFailureDialog {
  const detail = error instanceof Error ? error.message : String(error);
  if (isAddressInUseError(error)) {
    return {
      title: "Ygdria could not start",
      message: "Port 4318 is already in use.",
      detail: "Close the program using 127.0.0.1:4318, then choose Retry. Ygdria keeps this fixed local address for its desktop and AI integrations.",
    };
  }
  return {
    title: "Ygdria could not start",
    message: "The local Ygdria service could not be started.",
    detail: detail || "An unknown startup error occurred. Choose Retry after resolving the problem.",
  };
}

/** Shares one in-flight close operation across every concurrent caller. */
export function onceAsync(operation: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => (promise ??= operation());
}

/**
 * Two-phase quit handshake for the desktop shell. The first quit request is
 * deferred until the pending close settles, after which the quit is
 * re-issued; any later request passes through immediately (returns false) so
 * the re-issued quit is not prevented again.
 *
 * The handshake itself raises `state.quitting`. Callers must not raise any
 * shared quitting flag before invoking it — doing so makes this guard return
 * immediately, skipping the close and leaving the app running forever.
 */
export function deferQuitOnce(
  state: { quitting: boolean },
  close: () => Promise<void>,
  quit: () => void,
): boolean {
  if (state.quitting) return false;
  state.quitting = true;
  void close()
    .catch(() => undefined)
    .finally(quit);
  return true;
}
