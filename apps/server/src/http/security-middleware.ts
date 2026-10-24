import type { FastifyInstance } from "fastify";
import type { EtapiAccess } from "../security/etapi-access.js";
import { consumeRateLimit } from "../security/rate-limit.js";
import { httpError, LOGIN_RATE_LIMIT_WINDOW_MS } from "./errors.js";

export function registerSecurityHeaders(
  app: FastifyInstance,
  loginRequestCounts: Map<string, { count: number; resetAt: number }>,
) {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Strict-Transport-Security", "max-age=31536000");
    reply.header(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    );
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:",
    );
    if (req.method !== "POST") return;
    const path = req.url.split("?")[0];
    if (path !== "/api/v1/auth/login/challenge" && path !== "/api/v1/auth/login/verify") return;
    if (!consumeRateLimit(loginRequestCounts, `${path}:${req.ip ?? "unknown"}`)) {
      reply.header("Retry-After", String(Math.ceil(LOGIN_RATE_LIMIT_WINDOW_MS / 1000)));
      throw httpError(429, "Too many login requests; try again later");
    }
  });
}

/** The optional ETAPI surface is local native-client access, never a public bearer API. */
export function registerEtapiAccessHook(app: FastifyInstance, access: EtapiAccess) {
  app.addHook("onRequest", async (req) => {
    if (!req.url.split("?")[0].startsWith("/etapi/")) return;
    if (!access.getState().enabled)
      throw httpError(403, "AI and external access is disabled in Ygdria settings");
    // Check the socket rather than proxy-derived IPs. Host validation prevents DNS rebinding.
    const address = req.raw.socket.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? ""))
      throw httpError(403, "ETAPI accepts loopback connections only");
    let hostname: string;
    try {
      hostname = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      throw httpError(403, "Invalid ETAPI host");
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname))
      throw httpError(403, "ETAPI requires a loopback host");
    // A non-safelisted header plus rejecting browser origins prevents website-triggered requests.
    if (
      req.headers.origin ||
      req.headers["sec-fetch-site"] ||
      req.headers["x-ygdria-external-access"] !== "1"
    )
      throw httpError(403, "ETAPI requires a local native client with X-Ygdria-External-Access: 1");
  });
}

export function registerLocalTokenHook(app: FastifyInstance, localToken?: string) {
  app.addHook("onRequest", async (req) => {
    if (req.method === "OPTIONS") return;
    const pathname = req.url.split("?")[0];
    // ETAPI is handled separately by its local access switch. The desktop API still requires its secret.
    if (!pathname.startsWith("/api/")) return;
    if (!localToken || req.headers["x-ygdria-local-token"] === localToken) return;
    throw httpError(401, "Missing local token");
  });
}
