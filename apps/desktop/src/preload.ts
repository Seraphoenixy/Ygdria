import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ygdria", {
  connection: () => ipcRenderer.invoke("ygdria:connection"),
  windowControl: (action: "minimize" | "toggle-maximize" | "close") =>
    ipcRenderer.invoke("ygdria:window-control", action) as Promise<boolean>,
  openTabWindow: (tab: unknown) => ipcRenderer.invoke("ygdria:open-tab-window", tab) as Promise<void>,
  zoom: (direction: number) => ipcRenderer.invoke("ygdria:zoom", direction) as Promise<number | undefined>,
  openDevTools: () => ipcRenderer.invoke("ygdria:open-devtools") as Promise<void>,
  remote: {
    status: () =>
      ipcRenderer.invoke("ygdria:remote:status") as Promise<{
        configured: boolean;
        serverUrl: string | null;
        authenticated: boolean;
      }>,
    configure: (serverUrl: string) =>
      ipcRenderer.invoke("ygdria:remote:configure", serverUrl) as Promise<boolean>,
    disconnect: () =>
      ipcRenderer.invoke("ygdria:remote:disconnect") as Promise<boolean>,
    test: (serverUrl: string, timeoutSeconds: number) =>
      ipcRenderer.invoke("ygdria:remote:test", serverUrl, timeoutSeconds) as Promise<boolean>,
    request: (init: {
      method: string;
      path: string;
      body?: string | ArrayBuffer;
      headers?: Record<string, string>;
    }) =>
      ipcRenderer.invoke("ygdria:remote:request", init) as Promise<{
        status: number;
        body: unknown;
        headers: Record<string, string>;
        isBinary: boolean;
      }>,
  },
});
