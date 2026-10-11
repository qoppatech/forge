import {
  FORGE_PROGRAM_ID,
  base64ToBytes,
  bytesToBase64,
  compileIntentTransaction,
  decodeWireTransaction,
  encodeWireTransaction,
  intentSubject,
  isFullySigned,
  mergeSignatures,
  messageHash,
  operationMemo,
  requiredSigners,
  sha256Hex,
  stableStringify,
  transactionSignature,
} from "@forge/sdk";
import type { ForgeIntent, TransactionPlan } from "@forge/sdk";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import type { SignatureBytes, Transaction } from "@solana/kit";

import type { Institution } from "./auth";
import type { Chain } from "./chain";
import { isUniqueViolation } from "./db";
import type { Db } from "./db";
import { conflict, HttpError, notFound } from "./http";

const base58Bytes = getBase58Encoder();
const base58String = getBase58Decoder();

/** Vaults an institution may have awaiting creation at once; each one is watched by the worker. */
export const MAX_PENDING_VAULTS = 20;

/**
 * Rejects making another not-yet-on-chain vault watchable past the per-institution cap. Runs
 * inside the transaction that commits the create_vault attempt; the advisory lock serialises
 * concurrent creations and re-preparations for one institution.
 */
export async function assertPendingVaultCapacity(
  tx: Db,
  institutionId: string
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`pending-vaults:${institutionId}`}))`;
  const [{ pending }] = await tx`
    SELECT count(*)::int AS pending FROM vaults v
    WHERE v.institution_id = ${institutionId} AND NOT v.onchain AND EXISTS (
      SELECT 1 FROM operations o WHERE o.vault = v.address AND o.kind = 'create_vault'
        AND o.status NOT IN ('expired', 'failed'))`;
  if (pending >= MAX_PENDING_VAULTS) {
    throw new HttpError(
      429,
      "too_many_pending_vaults",
      `At most ${MAX_PENDING_VAULTS} vaults may await confirmation`
    );
  }
}

export type OperationStatus =
  | "prepared"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "failed"
  | "expired"
  | "already_applied"
  | "needs_review";

export interface OperationRow {
  id: string;
  institution_id: string;
  idempotency_key: string;
  request_hash: string;
  origin: "api" | "chain";
  kind: ForgeIntent["kind"];
  vault: string;
  subject: string;
  intent: ForgeIntent;
  display: Record<string, string>;
  required_signers: string[];
  status: OperationStatus;
  status_reason: string | null;
  error: unknown;
  applied_signature: string | null;
  finalized_slot: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AttemptRow {
  id: string;
  operation_id: string;
  attempt_no: number;
  unsigned_tx: Uint8Array;
  message_hash: string;
  signatures: Record<string, string>;
  signed_tx: Uint8Array | null;
  signature: string | null;
  blockhash: string;
  last_valid_block_height: string;
  status:
    | "awaiting_signatures"
    | "live"
    | "landed_ok"
    | "landed_err"
    | "expired";
  confirmation: string | null;
  err: unknown;
  slot: string | null;
  send_count: number;
  last_sent_at: Date | null;
  last_send_error: string | null;
}

/** Hash of the canonical request: same key + different payload → 409. */
export function requestHash(route: string, body: unknown): Promise<string> {
  return sha256Hex(stableStringify({ body, route }));
}

/** Rebuilds the stored transaction with the signatures collected so far. */
export function attemptTransaction(attempt: AttemptRow): Transaction {
  const unsigned = decodeWireTransaction(
    bytesToBase64(new Uint8Array(attempt.unsigned_tx))
  );
  const signatures = { ...unsigned.signatures } as Record<
    string,
    SignatureBytes | null
  >;
  for (const [signer, signature] of Object.entries(attempt.signatures)) {
    signatures[signer] = new Uint8Array(
      base58Bytes.encode(signature)
    ) as SignatureBytes;
  }
  return { ...unsigned, signatures } as Transaction;
}

/** The first required signer pays the fee; every Forge intent has at least one signer. */
function feePayerOf(signers: string[]): string {
  const [feePayer] = signers;
  if (feePayer === undefined) {
    throw new Error("Intent has no required signers");
  }
  return feePayer;
}

async function insertAttempt(
  tx: Db,
  operationId: string,
  attemptNo: number,
  plan: TransactionPlan
) {
  await tx`
      INSERT INTO tx_attempts (operation_id, attempt_no, unsigned_tx, message_hash, blockhash,
        last_valid_block_height, status)
      VALUES (${operationId}, ${attemptNo}, ${base64ToBytes(plan.transaction)}, ${plan.messageHash},
        ${plan.blockhash}, ${plan.lastValidBlockHeight}, 'awaiting_signatures')`;
}

export interface OperationView {
  id: string;
  kind: string;
  origin: string;
  status: OperationStatus;
  statusReason: string | null;
  error: unknown;
  vault: string;
  subject: string;
  intent: ForgeIntent;
  display: Record<string, string>;
  requiredSigners: string[];
  appliedSignature: string | null;
  finalizedSlot: string | null;
  createdAt: Date;
  updatedAt: Date;
  attempts: {
    attemptNo: number;
    status: AttemptRow["status"];
    signature: string | null;
    signedBy: string[];
    blockhash: string;
    lastValidBlockHeight: string;
    confirmation: string | null;
    slot: string | null;
    sendCount: number;
    lastSendError: string | null;
    err: unknown;
  }[];
  /** Plan for the attempt awaiting signatures, if any. */
  plan: (TransactionPlan & { attemptNo: number; signedBy: string[] }) | null;
}

export function toView(
  operation: OperationRow,
  attempts: AttemptRow[],
  network: string
): OperationView {
  const open = attempts.find((a) => a.status === "awaiting_signatures");
  return {
    appliedSignature: operation.applied_signature,
    attempts: attempts.map((a) => ({
      attemptNo: a.attempt_no,
      blockhash: a.blockhash,
      confirmation: a.confirmation,
      err: a.err,
      lastSendError: a.last_send_error,
      lastValidBlockHeight: a.last_valid_block_height,
      sendCount: a.send_count,
      signature: a.signature,
      signedBy: Object.keys(a.signatures),
      slot: a.slot,
      status: a.status,
    })),
    createdAt: operation.created_at,
    display: operation.display,
    error: operation.error,
    finalizedSlot: operation.finalized_slot,
    id: operation.id,
    intent: operation.intent,
    kind: operation.kind,
    origin: operation.origin,
    plan: open
      ? {
          attemptNo: open.attempt_no,
          blockhash: open.blockhash,
          display: operation.display,
          feePayer: feePayerOf(operation.required_signers),
          intent: operation.intent,
          lastValidBlockHeight: open.last_valid_block_height,
          memo: operationMemo(operation.id, open.attempt_no),
          messageHash: open.message_hash,
          network,
          programId: FORGE_PROGRAM_ID,
          requiredSigners: operation.required_signers,
          signedBy: Object.keys(open.signatures),
          transaction: bytesToBase64(new Uint8Array(open.unsigned_tx)),
        }
      : null,
    requiredSigners: operation.required_signers,
    status: operation.status,
    statusReason: operation.status_reason,
    subject: operation.subject,
    updatedAt: operation.updated_at,
    vault: operation.vault,
  };
}

export class Operations {
  private readonly db: Db;
  private readonly chain: Chain;

  constructor(db: Db, chain: Chain) {
    this.db = db;
    this.chain = chain;
  }

  private async plan(
    intent: ForgeIntent,
    display: Record<string, string>,
    memo: string
  ) {
    const lifetime = await this.chain.getLatestBlockhash();
    const transaction = compileIntentTransaction(intent, lifetime, { memo });
    const signers = requiredSigners(intent);
    const plan: TransactionPlan = {
      blockhash: lifetime.blockhash,
      display,
      feePayer: feePayerOf(signers),
      intent,
      lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
      memo,
      messageHash: await messageHash(transaction),
      network: this.chain.network,
      programId: FORGE_PROGRAM_ID,
      requiredSigners: signers,
      transaction: encodeWireTransaction(transaction),
    };
    return plan;
  }

  /**
   * Creates an operation and its first attempt, or returns the existing operation for a
   * repeated idempotency key with the same request. `register` writes registry rows (vault,
   * loan, withdrawal) in the same transaction.
   */
  async create(input: {
    institution: Institution;
    idempotencyKey: string;
    requestHash: string;
    intent: ForgeIntent;
    display: Record<string, string>;
    register?: (tx: Db) => Promise<void>;
  }): Promise<{ created: boolean; operation: OperationView }> {
    const existing = await this.findByKey(
      input.institution.id,
      input.idempotencyKey
    );
    if (existing) {
      return {
        created: false,
        operation: await this.reuse(existing, input.requestHash),
      };
    }

    // The id is chosen first so the plan's memo can reference it.
    const operationId = crypto.randomUUID();
    const plan = await this.plan(
      input.intent,
      input.display,
      operationMemo(operationId, 1)
    );
    try {
      const id = await this.db.begin(async (tx) => {
        const [operation] = await tx`
          INSERT INTO operations (id, institution_id, idempotency_key, request_hash, kind, vault,
            subject, intent, display, required_signers, status)
          VALUES (${operationId}, ${input.institution.id}, ${input.idempotencyKey}, ${input.requestHash},
            ${input.intent.kind}, ${(input.intent as { vault: string }).vault},
            ${intentSubject(input.intent)}, ${input.intent}, ${input.display},
            ${plan.requiredSigners}, 'prepared')
          RETURNING id`;
        await insertAttempt(tx, operation.id, 1, plan);
        await input.register?.(tx as Db);
        return operation.id as string;
      });
      return { created: true, operation: await this.view(id) };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const raced = await this.findByKey(
        input.institution.id,
        input.idempotencyKey
      );
      if (!raced) {
        throw error;
      }
      return {
        created: false,
        operation: await this.reuse(raced, input.requestHash),
      };
    }
  }

  private async reuse(existing: OperationRow, hash: string) {
    if (existing.request_hash !== hash) {
      throw conflict(
        "idempotency_conflict",
        "Idempotency-Key was used with a different request",
        {
          operationId: existing.id,
        }
      );
    }
    return await this.view(existing.id);
  }

  private async findByKey(
    institutionId: string,
    key: string
  ): Promise<OperationRow | undefined> {
    const [row] = await this.db`
      SELECT * FROM operations WHERE institution_id = ${institutionId} AND idempotency_key = ${key}`;
    return row;
  }

  /**
   * Accepts full or partial signatures for the open attempt. Signed bytes and the transaction
   * id are committed before the first broadcast, so a crash or RPC timeout can never lose
   * track of a transaction that might land.
   */
  async submit(
    institution: Institution,
    operationId: string,
    wireBase64: string
  ): Promise<OperationView> {
    let submitted: Transaction;
    try {
      submitted = decodeWireTransaction(wireBase64);
    } catch {
      throw new HttpError(
        400,
        "invalid_transaction",
        "Transaction bytes do not decode"
      );
    }
    const outcome = await this.db.begin(async (tx) => {
      const [operation] = await tx`
        SELECT * FROM operations WHERE id = ${operationId} AND institution_id = ${institution.id}
        FOR UPDATE`;
      if (!operation) {
        throw notFound("Operation");
      }
      if (operation.status !== "prepared" && operation.status !== "submitted") {
        // Already applied (possibly by another transaction) or closed: never land it twice.
        throw conflict("operation_closed", `Operation is ${operation.status}`);
      }
      const [attempt] = (await tx`
        SELECT * FROM tx_attempts WHERE operation_id = ${operationId}
          AND status IN ('awaiting_signatures', 'live')
        FOR UPDATE`) as AttemptRow[];
      if (!attempt) {
        throw conflict(
          "no_open_attempt",
          `Operation is ${operation.status}; prepare a new attempt first`
        );
      }
      let merged: Awaited<ReturnType<typeof mergeSignatures>>;
      try {
        merged = await mergeSignatures(attemptTransaction(attempt), submitted);
      } catch (error) {
        throw new HttpError(
          422,
          "signature_rejected",
          (error as Error).message
        );
      }
      const signatures: Record<string, string> = {};
      for (const [signer, bytes] of Object.entries(
        merged.transaction.signatures
      )) {
        if (bytes) {
          signatures[signer] = base58String.decode(bytes);
        }
      }
      if (
        attempt.status !== "awaiting_signatures" ||
        !isFullySigned(merged.transaction)
      ) {
        await tx`UPDATE tx_attempts SET signatures = ${signatures}, updated_at = now()
                 WHERE id = ${attempt.id}`;
        return { send: undefined };
      }
      const wire = encodeWireTransaction(merged.transaction);
      await tx`
        UPDATE tx_attempts SET signatures = ${signatures}, signed_tx = ${base64ToBytes(wire)},
          signature = ${transactionSignature(merged.transaction)}, status = 'live',
          next_check_at = now(), updated_at = now()
        WHERE id = ${attempt.id}`;
      await tx`UPDATE operations SET status = 'submitted', updated_at = now()
               WHERE id = ${operationId} AND status = 'prepared'`;
      return { send: { attemptId: attempt.id, wire } };
    });
    if (outcome.send) {
      await this.broadcast(outcome.send.attemptId, outcome.send.wire);
    }
    return this.view(operationId);
  }

  /** Best-effort first broadcast; the worker rebroadcasts the same bytes until resolved. */
  async broadcast(attemptId: string, wire: string): Promise<void> {
    try {
      await this.chain.sendTransaction(wire);
      await this
        .db`UPDATE tx_attempts SET send_count = send_count + 1, last_sent_at = now(),
                    last_send_error = NULL WHERE id = ${attemptId}`;
    } catch (error) {
      await this
        .db`UPDATE tx_attempts SET last_send_error = ${String((error as Error).message)}
                    WHERE id = ${attemptId}`;
    }
  }

  /** New attempt (new blockhash, new signatures) — only after the previous one is proven dead. */
  async reprepare(
    institution: Institution,
    operationId: string
  ): Promise<OperationView> {
    const [operation] = (await this.db`
      SELECT * FROM operations WHERE id = ${operationId} AND institution_id = ${institution.id}`) as OperationRow[];
    if (!operation) {
      throw notFound("Operation");
    }
    if (operation.status !== "expired") {
      throw conflict(
        "not_expired",
        `Only expired operations can be re-prepared (status: ${operation.status})`
      );
    }
    const [{ next }] = await this.db`
      SELECT coalesce(max(attempt_no), 0) + 1 AS next FROM tx_attempts WHERE operation_id = ${operationId}`;
    const attemptNo = Number(next);
    const plan = await this.plan(
      operation.intent,
      operation.display,
      operationMemo(operationId, attemptNo)
    );
    try {
      await this.db.begin(async (tx) => {
        if (operation.kind === "create_vault") {
          await assertPendingVaultCapacity(tx as Db, institution.id);
        }
        await insertAttempt(tx as Db, operationId, attemptNo, plan);
        const updated = await tx`
          UPDATE operations SET status = 'prepared', status_reason = NULL, updated_at = now()
          WHERE id = ${operationId} AND status = 'expired' RETURNING id`;
        if (updated.length === 0) {
          throw conflict("not_expired", "Operation changed concurrently");
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("attempt_open", "An attempt is still open");
      }
      throw error;
    }
    return this.view(operationId);
  }

  async get(
    institution: Institution,
    operationId: string
  ): Promise<OperationView> {
    const [row] = await this.db`
      SELECT id FROM operations WHERE id = ${operationId} AND institution_id = ${institution.id}`;
    if (!row) {
      throw notFound("Operation");
    }
    return this.view(operationId);
  }

  async view(operationId: string): Promise<OperationView> {
    const [operation] = (await this
      .db`SELECT * FROM operations WHERE id = ${operationId}`) as OperationRow[];
    if (!operation) {
      throw notFound("Operation");
    }
    const attempts = (await this.db`
      SELECT * FROM tx_attempts WHERE operation_id = ${operationId} ORDER BY attempt_no`) as AttemptRow[];
    return toView(operation, attempts, this.chain.network);
  }
}
