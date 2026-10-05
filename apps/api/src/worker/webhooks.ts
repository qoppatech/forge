import { bytesToHex } from "@forge/sdk";

import type { Db } from "../db";

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

/**
 * At-least-once webhook delivery from the transactional outbox. Each event keeps its stable
 * `event_id` across retries so receivers can deduplicate. Requests are signed with
 * `Forge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 */
export class Webhooks {
  constructor(
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async deliver(limit = 20): Promise<number> {
    // Claim by pushing next_attempt_at forward; no row lock is held across HTTP calls.
    const due = await this.db`
      WITH due AS (
        SELECT o.id FROM webhook_outbox o JOIN institutions i ON i.id = o.institution_id
        WHERE o.delivered_at IS NULL AND o.next_attempt_at <= now() AND i.webhook_url IS NOT NULL
        ORDER BY o.id LIMIT ${limit} FOR UPDATE OF o SKIP LOCKED
      )
      UPDATE webhook_outbox o SET next_attempt_at = now() + interval '30 seconds'
      FROM due, institutions i WHERE o.id = due.id AND i.id = o.institution_id
      RETURNING o.id, o.event_id, o.type, o.payload, o.attempts, o.created_at, i.webhook_url, i.webhook_secret`;
    for (const event of due) {
      const body = JSON.stringify({ id: event.event_id, type: event.type, createdAt: event.created_at, data: event.payload });
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const response = await this.fetchImpl(event.webhook_url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "forge-event-id": event.event_id,
            "forge-signature": `t=${timestamp},v1=${await hmac(event.webhook_secret, `${timestamp}.${body}`)}`,
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await this.db`UPDATE webhook_outbox SET delivered_at = now(), attempts = attempts + 1, last_error = NULL
                      WHERE id = ${event.id}`;
      } catch (error) {
        const backoffSeconds = Math.min(3600, 2 ** Math.min(event.attempts + 1, 12));
        await this.db`
          UPDATE webhook_outbox SET attempts = attempts + 1, last_error = ${(error as Error).message},
            next_attempt_at = now() + ${`${backoffSeconds} seconds`}::interval
          WHERE id = ${event.id}`;
      }
    }
    return due.length;
  }
}
