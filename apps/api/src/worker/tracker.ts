import { bytesToBase64, toJsonSafe } from "@forge/sdk";

import type { Chain, SignatureStatus } from "../chain";
import type { Db } from "../db";
import type { AttemptRow } from "../operations";
import type { Indexer } from "./indexer";
import { enqueueEvent } from "./ledger";
import type { Reconciler } from "./reconciler";

interface ClaimedAttempt extends AttemptRow {
  lease_epoch: string;
}

const REBROADCAST_MS = 2_000;
const CHECK_MS = 1_000;

/**
 * Drives every signed attempt to a proven outcome:
 * - rebroadcasts the *same* signed bytes until they land or expire (never rebuilds);
 * - records processed/confirmed progress and hands finalized signatures to the reconciler;
 * - declares an attempt expired only with proof: finalized block height is past
 *   `lastValidBlockHeight` and the signature is unknown even with history search.
 * Leases make concurrent workers efficient; safety comes from persisted signed bytes and the
 * one-live-attempt index, so two workers rebroadcasting the same bytes is harmless.
 */
export class Tracker {
  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
    private readonly reconciler: Reconciler,
    private readonly indexer: Indexer,
    private readonly workerId: string,
  ) {}

  private async claim(limit: number): Promise<ClaimedAttempt[]> {
    return (await this.db`
      WITH due AS (
        SELECT id FROM tx_attempts
        WHERE status IN ('live', 'landed_ok', 'landed_err')
          AND confirmation IS DISTINCT FROM 'finalized'
          AND next_check_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY next_check_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tx_attempts t
      SET lease_owner = ${this.workerId}, lease_until = now() + interval '30 seconds',
          lease_epoch = t.lease_epoch + 1
      FROM due WHERE t.id = due.id
      RETURNING t.*`) as ClaimedAttempt[];
  }

  async tick(): Promise<number> {
    const attempts = await this.claim(50);
    if (attempts.length === 0) return 0;
    let statuses: (SignatureStatus | null)[];
    try {
      statuses = await this.chain.getSignatureStatuses(attempts.map((a) => a.signature!));
    } catch {
      // RPC outage: no evidence, no transition. Leases lapse and the next tick retries.
      return 0;
    }
    let finalizedHeight: bigint | undefined;
    for (const [i, attempt] of attempts.entries()) {
      const status = statuses[i] ?? null;
      try {
        if (status) {
          await this.recordProgress(attempt, status);
          continue;
        }
        finalizedHeight ??= await this.chain.getBlockHeight("finalized");
        if (finalizedHeight > BigInt(attempt.last_valid_block_height)) {
          await this.expireIfProven(attempt);
        } else {
          await this.rebroadcast(attempt);
        }
      } catch (error) {
        await this.release(attempt, `tracker: ${(error as Error).message}`);
      }
    }
    return attempts.length;
  }

  private async release(attempt: ClaimedAttempt, error?: string) {
    await this.db`
      UPDATE tx_attempts SET lease_until = NULL, next_check_at = now() + ${`${CHECK_MS} milliseconds`}::interval,
        last_send_error = coalesce(${error ?? null}, last_send_error)
      WHERE id = ${attempt.id} AND lease_epoch = ${attempt.lease_epoch}`;
  }

  private async rebroadcast(attempt: ClaimedAttempt) {
    const due = !attempt.last_sent_at || Date.now() - attempt.last_sent_at.getTime() >= REBROADCAST_MS;
    if (due && attempt.status === "live" && attempt.signed_tx) {
      try {
        await this.chain.sendTransaction(bytesToBase64(new Uint8Array(attempt.signed_tx)));
        await this.db`
          UPDATE tx_attempts SET send_count = send_count + 1, last_sent_at = now(), last_send_error = NULL
          WHERE id = ${attempt.id} AND lease_epoch = ${attempt.lease_epoch}`;
      } catch (error) {
        await this.release(attempt, `send: ${(error as Error).message}`);
        return;
      }
    }
    await this.release(attempt);
  }

  private async recordProgress(attempt: ClaimedAttempt, status: SignatureStatus) {
    const landed = status.err === null ? "landed_ok" : "landed_err";
    const confirmation = status.confirmationStatus ?? "processed";
    if (confirmation === "finalized") {
      // The reconciler writes the final attempt/operation state with events and postings.
      const result = await this.reconciler.processSignature(attempt.signature!);
      if (result === "not_found") await this.release(attempt);
      return;
    }
    await this.db.begin(async (sql) => {
      await sql`
        UPDATE tx_attempts SET status = ${landed}, confirmation = ${confirmation},
          slot = ${status.slot.toString()}, err = ${status.err === null ? null : toJsonSafe(status.err)},
          lease_until = NULL, next_check_at = now() + ${`${CHECK_MS} milliseconds`}::interval,
          updated_at = now()
        WHERE id = ${attempt.id} AND lease_epoch = ${attempt.lease_epoch} AND confirmation IS DISTINCT FROM 'finalized'`;
      if (status.err === null && confirmation === "confirmed") {
        await sql`
          UPDATE operations SET status = 'confirmed', updated_at = now()
          WHERE id = ${attempt.operation_id} AND status = 'submitted'`;
      }
    });
  }

  private async expireIfProven(attempt: ClaimedAttempt) {
    // Absence in the status cache is not enough: confirm against finalized history, and index
    // the vault so a landed transaction is recognised even if this node's status lookup missed it.
    if (await this.chain.getTransaction(attempt.signature!)) {
      await this.reconciler.processSignature(attempt.signature!);
      return;
    }
    const [operation] = await this.db`SELECT vault FROM operations WHERE id = ${attempt.operation_id}`;
    if (operation) await this.indexer.syncVault(operation.vault);
    await this.db.begin(async (sql) => {
      const expired = await sql`
        UPDATE tx_attempts SET status = 'expired', lease_until = NULL, updated_at = now()
        WHERE id = ${attempt.id} AND lease_epoch = ${attempt.lease_epoch} AND status = 'live' RETURNING id`;
      if (expired.length > 0) await this.expireOperation(sql as Db, attempt.operation_id, "submitted");
    });
  }

  /**
   * Attempts that never collected every signature expire once their blockhash is dead. A
   * signer may have broadcast the bytes themselves, so the vault is indexed first: if the
   * transaction landed, the reconciler has already finalized the operation.
   */
  async expireUnsigned(): Promise<number> {
    const height = await this.chain.getBlockHeight("finalized");
    const stale = (await this.db`
      SELECT a.id, a.operation_id, o.vault FROM tx_attempts a JOIN operations o ON o.id = a.operation_id
      WHERE a.status = 'awaiting_signatures' AND a.last_valid_block_height < ${height.toString()}
      LIMIT 50`) as { id: string; operation_id: string; vault: string }[];
    for (const vault of new Set(stale.map((s) => s.vault))) await this.indexer.syncVault(vault);
    for (const attempt of stale) {
      await this.db.begin(async (sql) => {
        const expired = await sql`
          UPDATE tx_attempts SET status = 'expired', updated_at = now()
          WHERE id = ${attempt.id} AND status = 'awaiting_signatures' RETURNING id`;
        if (expired.length > 0) await this.expireOperation(sql as Db, attempt.operation_id, "prepared");
      });
    }
    return stale.length;
  }

  private async expireOperation(sql: Db, operationId: string, from: "prepared" | "submitted") {
    const allowed = from === "prepared" ? ["prepared"] : ["submitted", "confirmed"];
    const [operation] = await sql`
      UPDATE operations SET status = 'expired',
        status_reason = 'Blockhash expired before the transaction landed (proven); prepare a new attempt',
        updated_at = now()
      WHERE id = ${operationId} AND status IN ${sql(allowed)}
      RETURNING id, institution_id, kind, vault, subject`;
    if (!operation) return;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM tx_attempts WHERE operation_id = ${operationId}`;
    await enqueueEvent(sql, {
      eventId: `operation:${operationId}:expired:${n}`,
      institutionId: operation.institution_id,
      type: "operation.expired",
      payload: { operationId, kind: operation.kind, vault: operation.vault, subject: operation.subject },
    });
  }
}
