import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { YgdriaClient } from "@ygdria/api-client";
import { App } from "./app/App";
import { initCapacitor } from "./lib/capacitor";
import "./style.css";

async function bootstrap() {
  // Electron provides the per-launch loopback credential through the isolated
  // preload bridge. Browser/Vite deployments retain the same-origin client.
  const connection = await window.ygdria?.connection().catch(() => undefined);
  const client = new YgdriaClient(
    connection?.baseUrl ?? import.meta.env.VITE_API_URL ?? "",
    connection?.token,
  );
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={new QueryClient()}>
      <App client={client} />
    </QueryClientProvider>,
  );
  // Apply native-shell tweaks (status bar, keyboard, back button). No-op in a
  // browser or Electron where Capacitor reports a non-native platform.
  void initCapacitor();
}

void bootstrap();
