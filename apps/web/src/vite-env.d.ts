/// <reference types="vite/client" />
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string);
    window: any;
  }
}

interface Window {
  ygdria?: {
    connection: () => Promise<{ baseUrl: string; token?: string }>;
    windowControl?: (action: "minimize" | "toggle-maximize" | "close") => Promise<boolean>;
    openTabWindow?: (tab: unknown) => Promise<void>;
    zoom?: (direction: number) => Promise<number | undefined>;
    openDevTools?: () => Promise<void>;
    remote?: {
      status: () => Promise<{ configured: boolean; serverUrl: string | null; authenticated: boolean }>;
      configure: (serverUrl: string) => Promise<boolean>;
      disconnect: () => Promise<boolean>;
      test: (serverUrl: string, timeoutSeconds: number) => Promise<boolean>;
      request: (init: {
        method: string;
        path: string;
        body?: string | ArrayBuffer;
        headers?: Record<string, string>;
      }) => Promise<{ status: number; body: unknown; headers: Record<string, string>; isBinary: boolean }>;
    };
  };
}
