import { bytesToHex, sha256Hex } from "@forge/sdk";

import type { Db } from "./db";
import { HttpError } from "./http";

export interface Institution {
  id: string;
  name: string;
  webhook_url: string | null;
  webhook_secret: string;
}

function randomToken(prefix: string): string {
  return `${prefix}_${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** Creates an institution and returns its API key once; only the key's hash is stored. */
export async function createInstitution(
  db: Db,
  name: string,
  webhookUrl?: string
): Promise<{ institution: Institution; apiKey: string }> {
  const apiKey = randomToken("fk");
  const [institution] = await db`
    INSERT INTO institutions (name, api_key_hash, webhook_url, webhook_secret)
    VALUES (${name}, ${await sha256Hex(apiKey)}, ${webhookUrl ?? null}, ${randomToken("whsec")})
    RETURNING id, name, webhook_url, webhook_secret`;
  return { apiKey, institution };
}

export async function authenticate(
  db: Db,
  request: Request
): Promise<Institution> {
  const header = request.headers.get("authorization") ?? "";
  const key = /^Bearer (?<key>fk_[0-9a-f]{64})$/u.exec(header)?.groups?.key;
  if (!key) {
    throw new HttpError(401, "unauthorized", "A valid API key is required");
  }
  const [institution] = await db`
    SELECT id, name, webhook_url, webhook_secret FROM institutions
    WHERE api_key_hash = ${await sha256Hex(key)}`;
  if (!institution) {
    throw new HttpError(401, "unauthorized", "A valid API key is required");
  }
  return institution;
}
