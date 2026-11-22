import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EtapiError, EtapiNetworkError } from "../client/etapi-client.js";

export function success(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(data !== null && typeof data === "object" && !Array.isArray(data)
      ? { structuredContent: data as Record<string, unknown> }
      : {}),
  };
}

export function failure(error: unknown): CallToolResult {
  const message =
    error instanceof EtapiError || error instanceof EtapiNetworkError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unexpected error while communicating with Ygdria ETAPI.";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          message,
          ...(error instanceof EtapiError
            ? {
                status: error.status,
                details: error.status < 500 ? error.details : undefined,
              }
            : {}),
          nextAction:
            error instanceof EtapiError
              ? ((
                  {
                    401: "Enable AI and external access in Ygdria settings, then call again.",
                    403: "Enable AI and external access in Ygdria settings; use a local native client.",
                    404: "Resolve the target again.",
                    409: "Read current state and reconsider the change.",
                    422: "Read current content and regenerate unique edit targets.",
                  } as Record<number, string>
                )[error.status] ??
                "Correct the request using the error details.")
              : error instanceof EtapiNetworkError
                ? "Check connectivity. Retry reads freely; retry creates or appends only with the same idempotency key within 30 days."
                : "Correct parameters or local configuration using the message.",
        }),
      },
    ],
  };
}

export async function versionConflict(
  client: { getNote(noteId: string, format: "markdown"): Promise<unknown> },
  noteId: string,
): Promise<CallToolResult> {
  try {
    const latest = await client.getNote(noteId, "markdown");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "version_conflict",
              message:
                "The note changed. Re-evaluate the requested edit against this latest state; do not retry the old version.",
              latest,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error) {
    return failure(error);
  }
}
