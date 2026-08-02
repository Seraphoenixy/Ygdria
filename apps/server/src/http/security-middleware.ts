import type { FastifyInstance } from "fastify";
import { consumeRateLimit } from "../security/rate-limit.js";
import { httpError, LOGIN_RATE_LIMIT_WINDOW_MS } from "./errors.js";

export function registerSecurityHeaders(app: FastifyInstance, loginRequestCounts: Map<string, { count: number; resetAt: number }>) {
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
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'",
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

export function registerLocalTokenHook(app: FastifyInstance, localToken?: string) {
  app.addHook("onRequest", async (req) => {
    if (req.method === "OPTIONS") return;
    // The embedded desktop window navigates to the local server's static
    // shell. Electron navigations cannot attach an application-specific
    // request header, so protecting `/` (and its JS/CSS assets) makes a
    // packaged desktop app render the JSON 401 response instead of the UI.
    // Only application API routes expose user data or mutations; keep the
    // per-launch local-token boundary on those routes.
    const pathname = req.url.split("?")[0];
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/etapi/")) return;
    if (localToken && req.headers["x-ygdria-local-token"] !== localToken)
      throw httpError(401, "Missing local token");
  });
}
