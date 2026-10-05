import { toJsonSafe } from "@forge/sdk";
import type { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(toJsonSafe(data)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  }
  console.error(error);
  return json({ error: { code: "internal", message: "Internal error" } }, 500);
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body too large");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(400, "invalid_request", "Request validation failed", result.error.issues);
  }
  return result.data;
}

export function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length > 128) {
    throw new HttpError(400, "idempotency_key_required", "Idempotency-Key header (≤128 chars) is required");
  }
  return key;
}
