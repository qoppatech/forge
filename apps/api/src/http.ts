import { toJsonSafe } from "@forge/sdk";
import type { z } from "zod";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) =>
  new HttpError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);

export function json(data: unknown, status = 200): Response {
  return Response.json(toJsonSafe(data), {
    headers: { "content-type": "application/json" },
    status,
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      {
        error: {
          code: error.code,
          details: error.details,
          message: error.message,
        },
      },
      error.status
    );
  }
  console.error(error);
  return json({ error: { code: "internal", message: "Internal error" } }, 500);
}

/** Also passed to Bun.serve as `maxRequestBodySize`, so larger bodies are refused before they
 *  are buffered; the check below keeps the limit in bytes for any other entry point. */
export const MAX_BODY_BYTES = 64 * 1024;

export async function readBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<z.infer<T>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "too_large", "Request body too large");
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_request",
      "Request validation failed",
      result.error.issues
    );
  }
  return result.data;
}

export function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length > 128) {
    throw new HttpError(
      400,
      "idempotency_key_required",
      "Idempotency-Key header (≤128 chars) is required"
    );
  }
  return key;
}
