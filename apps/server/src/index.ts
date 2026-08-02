import { buildApp } from "./app.js";
import { loadStandaloneConfig } from "./config.js";

const config = loadStandaloneConfig();
const app = buildApp({
  // Standalone servers are the multi-device/remote deployment boundary.
  // Do not allow a missing environment variable to expose their API.
  enableDeviceAuth: true,
  databaseUrl: config.databaseUrl,
  origin: config.origin,
  trustedProxy: config.trustedProxy,
  // A SEA release injects its bundled Web directory before this module runs.
  // Source/development execution continues to use the INI value.
  webDist: process.env.YGDRIA_BUNDLED_WEB_DIST || config.webDist,
  prettyLogs: false,
});
let isClosing = false;

async function shutdown(signal: string) {
  if (isClosing) return;
  isClosing = true;
  app.log.info({ signal }, "shutting down Ygdria server");

  try {
    // Runs Fastify's onClose hook, which closes the SQLite handle.
    await app.close();
    app.log.info("Ygdria server stopped");
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "failed to close Ygdria server cleanly");
    process.exit(1);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void app.listen({ port: config.port, host: config.host }).catch((error) => {
  app.log.error({ err: error }, "failed to start Ygdria server");
  process.exitCode = 1;
});
