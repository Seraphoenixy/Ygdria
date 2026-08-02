import type { FastifyInstance } from "fastify";
import { NotFoundError, ConflictError, DeviceError } from "@ygdria/domain";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _req, reply) => {
    const issue = error as Error & { statusCode?: number };
    let code: number;
    if (issue instanceof NotFoundError) code = 404;
    else if (issue instanceof ConflictError) code = 409;
    else if (issue instanceof DeviceError) {
      code =
        issue.code === "device_not_found"
          ? 404
          : issue.code === "label_required"
            ? 400
            : issue.code === "already_bootstrapped" || issue.code === "not_bootstrapped"
              ? 409
              : 401;
    } else code = issue.statusCode ?? 500;
    app.log.error({ err: issue, statusCode: code }, "request failed");
    // Internal exceptions can carry SQLite, filesystem, or implementation
    // details. Log them above, but never disclose them to an API client.
    const message = code >= 500 ? "Internal server error" : issue.message;
    reply.code(code).send({ error: { code: issue.constructor.name, message } });
  });
}