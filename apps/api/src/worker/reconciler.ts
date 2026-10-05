import {
  FORGE_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
  decodeForgeInstruction,
  decodeLoanAccount,
  decodeTransactionError,
  decodeVaultAccount,
  decodeWithdrawalAccount,
  intentSubject,
  intentsEqual,
  parseOperationMemo,
  requiredSigners,
  toJsonSafe,
  type ForgeIntent,
  type IntentKind,
} from "@forge/sdk";

import { parseTokenAccount, type Chain, type ChainTransaction } from "../chain";
import type { Db } from "../db";
import type { OperationRow } from "../operations";
import { classifyFailure } from "./classify";
import { EVENT_TYPES, enqueueEvent, entryFor, insertPostings, type Snapshots } from "./ledger";

interface DecodedInstruction {
  index: number;
  innerIndex: number;
  intent: ForgeIntent;
}

interface VaultRow {
  address: string;
  institution_id: string;
  token_account: string;
  vault_ref: string;
}

interface MatchedAttempt {
  id: string;
  operation_id: string;
}

export type ProcessResult = "processed" | "duplicate" | "not_found" | "irrelevant";

const OPEN_STATUSES = ["prepared", "submitted", "confirmed", "expired"];
const NONE = "__none__";

/**
 * Turns one finalized transaction into durable facts, exactly once per (network, signature):
 * chain events, balanced postings, exceptions, projections, operation transitions and webhook
 * outbox rows are written in a single database transaction. Both the tracker (own
 * submissions) and the indexer (anything touching a watched vault) go through here.
 */
export class Reconciler {
  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
  ) {}

  async processSignature(signature: string): Promise<ProcessResult> {
    const network = this.chain.network;
    const [seen] = await this.db`
      SELECT 1 FROM chain_transactions WHERE network = ${network} AND signature = ${signature}`;
    if (seen) return "duplicate";
    const tx = await this.chain.getTransaction(signature);
    if (!tx) return "not_found";

    const instructions = this.forgeInstructions(tx);
    const vaultAddresses = instructions.map((i) => (i.intent as { vault: string }).vault);
    const tokenAccounts = tx.tokenBalances.map((b) => b.account);
    const vaults = (await this.db`
      SELECT address, institution_id, token_account, vault_ref FROM vaults
      WHERE address IN ${this.db([...vaultAddresses, NONE])}
         OR token_account IN ${this.db([...tokenAccounts, NONE])}`) as VaultRow[];

    // Our attempt, by transaction id, exact message, or the operation memo (which survives a
    // wallet adding instructions before broadcasting).
    const memo = this.operationMemo(tx);
    const [matched] = (await this.db`
      SELECT id, operation_id FROM tx_attempts
      WHERE signature = ${signature} OR message_hash = ${tx.messageHash}
         OR (operation_id = ${memo?.operationId ?? null}::uuid AND attempt_no = ${memo?.attemptNo ?? -1})
      ORDER BY (signature IS NOT DISTINCT FROM ${signature}) DESC LIMIT 1`) as MatchedAttempt[];

    if (vaults.length === 0 && !matched) {
      await this.recordTransaction(this.db, tx);
      return "irrelevant";
    }
    const snapshots = await this.snapshots(instructions.map((i) => i.intent), vaults);
    return tx.err === null
      ? this.recordSuccess(tx, instructions, vaults, matched, snapshots)
      : this.recordFailure(tx, instructions, matched, snapshots);
  }

  private operationMemo(tx: ChainTransaction) {
    for (const ix of tx.instructions) {
      if (ix.programAddress !== MEMO_PROGRAM_ADDRESS || ix.innerIndex !== -1) continue;
      const parsed = parseOperationMemo(new TextDecoder().decode(ix.data));
      if (parsed) return parsed;
    }
    return undefined;
  }

  private forgeInstructions(tx: ChainTransaction): DecodedInstruction[] {
    const decoded: DecodedInstruction[] = [];
    for (const ix of tx.instructions) {
      if (ix.programAddress !== FORGE_PROGRAM_ADDRESS) continue;
      try {
        const intent = decodeForgeInstruction({
          programAddress: ix.programAddress,
          accounts: ix.accounts.map((address) => ({ address })),
          data: ix.data,
        });
        if (intent) decoded.push({ index: ix.index, innerIndex: ix.innerIndex, intent });
      } catch {
        // Malformed Forge data cannot have executed successfully; failures are still recorded.
      }
    }
    return decoded.sort((a, b) => a.index - b.index || a.innerIndex - b.innerIndex);
  }

  /** Finalized account state for everything the transaction touched. */
  private async snapshots(intents: ForgeIntent[], vaults: VaultRow[]): Promise<Snapshots> {
    const vaultSet = new Set([...vaults.map((v) => v.address), ...intents.map((i) => (i as { vault: string }).vault)]);
    const tokenSet = new Set(vaults.map((v) => v.token_account));
    const loanSet = new Set(intents.flatMap((i) => ("loan" in i ? [i.loan] : [])));
    const withdrawalSet = new Set(intents.flatMap((i) => ("withdrawal" in i ? [i.withdrawal] : [])));
    const addresses = [...vaultSet, ...tokenSet, ...loanSet, ...withdrawalSet];
    const accounts = await this.chain.getAccounts(addresses, "finalized");
    const snapshots: Snapshots = { vaults: new Map(), loans: new Map(), withdrawals: new Map(), tokenAmounts: new Map() };
    addresses.forEach((address, i) => {
      const data = accounts[i]?.data;
      if (!data) return;
      try {
        if (vaultSet.has(address)) snapshots.vaults.set(address, decodeVaultAccount(data));
        else if (loanSet.has(address)) snapshots.loans.set(address, decodeLoanAccount(data));
        else if (withdrawalSet.has(address)) snapshots.withdrawals.set(address, decodeWithdrawalAccount(data));
        else {
          const token = parseTokenAccount(data);
          if (token) snapshots.tokenAmounts.set(address, token.amount);
        }
      } catch {
        // Not a Forge account of the expected type (e.g. a squatted PDA); classification handles it.
      }
    });
    return snapshots;
  }

  private async recordTransaction(sql: Db, tx: ChainTransaction): Promise<boolean> {
    const rows = await sql`
      INSERT INTO chain_transactions (network, signature, slot, block_time, err, fee_payer, message_hash)
      VALUES (${this.chain.network}, ${tx.signature}, ${tx.slot.toString()},
        ${tx.blockTime?.toString() ?? null}, ${tx.err === null ? null : toJsonSafe(tx.err)},
        ${tx.feePayer}, ${tx.messageHash})
      ON CONFLICT DO NOTHING RETURNING signature`;
    return rows.length > 0;
  }

  private async recordFailure(
    tx: ChainTransaction,
    instructions: DecodedInstruction[],
    matched: MatchedAttempt | undefined,
    snapshots: Snapshots,
  ): Promise<ProcessResult> {
    const kinds: (IntentKind | undefined)[] = [];
    for (const i of instructions) if (i.innerIndex === -1) kinds[i.index] = i.intent.kind;
    const error = decodeTransactionError(tx.err, kinds);
    return this.db.begin(async (sql) => {
      if (!(await this.recordTransaction(sql as Db, tx))) return "duplicate";
      if (!matched) return "processed";
      const [operation] = (await sql`
        SELECT * FROM operations WHERE id = ${matched.operation_id}`) as OperationRow[];
      if (!operation) return "processed";
      const outcome = classifyFailure(operation.intent, error, snapshots);
      await sql`
        UPDATE tx_attempts SET status = 'landed_err', confirmation = 'finalized',
          err = ${toJsonSafe(tx.err)}, slot = ${tx.slot.toString()},
          signature = coalesce(signature, ${tx.signature}), updated_at = now()
        WHERE id = ${matched.id}`;
      const updated = await sql`
        UPDATE operations SET status = ${outcome.status}, status_reason = ${outcome.reason},
          error = ${toJsonSafe(error)}, finalized_slot = ${tx.slot.toString()}, updated_at = now()
        WHERE id = ${operation.id} AND status IN ${sql(OPEN_STATUSES)}
        RETURNING id`;
      if (updated.length > 0) {
        await enqueueEvent(sql as Db, {
          eventId: `operation:${operation.id}:${outcome.status}`,
          institutionId: operation.institution_id,
          type: `operation.${outcome.status}`,
          payload: {
            operationId: operation.id,
            kind: operation.kind,
            vault: operation.vault,
            subject: operation.subject,
            reason: outcome.reason,
            error: toJsonSafe(error),
            signature: tx.signature,
            slot: tx.slot.toString(),
          },
        });
      }
      return "processed";
    });
  }

  private async recordSuccess(
    tx: ChainTransaction,
    instructions: DecodedInstruction[],
    vaults: VaultRow[],
    matched: MatchedAttempt | undefined,
    snapshots: Snapshots,
  ): Promise<ProcessResult> {
    const network = this.chain.network;
    const byAddress = new Map(vaults.map((v) => [v.address, v]));
    const byToken = new Map(vaults.map((v) => [v.token_account, v]));
    return this.db.begin(async (raw) => {
      const sql = raw as Db;
      if (!(await this.recordTransaction(sql, tx))) return "duplicate";
      const explained = new Map<string, bigint>();
      const touched = new Set<string>();
      let matchedUsed = false;

      for (const ix of instructions) {
        const intent = ix.intent;
        const vault = byAddress.get((intent as { vault: string }).vault);
        if (!vault) continue;
        touched.add(vault.address);

        let operationId = matched && !matchedUsed ? await this.matchedOperation(sql, matched, intent) : undefined;
        if (operationId) matchedUsed = true;
        operationId ??= await this.openOperationByIntent(sql, intent);
        if (operationId) {
          await sql`
            UPDATE operations SET status = 'finalized', status_reason = NULL,
              applied_signature = ${tx.signature}, finalized_slot = ${tx.slot.toString()}, updated_at = now()
            WHERE id = ${operationId} AND status IN ${sql(OPEN_STATUSES)}`;
          await sql`
            UPDATE tx_attempts SET status = 'landed_ok', confirmation = 'finalized',
              slot = ${tx.slot.toString()}, signature = coalesce(signature, ${tx.signature}), updated_at = now()
            WHERE operation_id = ${operationId}
              AND (signature = ${tx.signature} OR message_hash = ${tx.messageHash} OR id = ${matched?.id ?? null})`;
        } else {
          operationId = await this.externalOperation(sql, tx, ix, vault);
        }

        const [event] = await sql`
          INSERT INTO chain_events (network, signature, ix_index, inner_index, kind, vault, subject,
            operation_id, intent, slot, block_time)
          VALUES (${network}, ${tx.signature}, ${ix.index}, ${ix.innerIndex}, ${intent.kind},
            ${vault.address}, ${intentSubject(intent)}, ${operationId}, ${intent},
            ${tx.slot.toString()}, ${tx.blockTime?.toString() ?? null})
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!event) continue;

        const businessRef = await this.businessRef(sql, intent, vault);
        const entry = entryFor(intent, snapshots);
        if (entry) {
          await insertPostings(sql, { eventId: event.id, vault: vault.address, signature: tx.signature, slot: tx.slot, businessRef }, entry);
          explained.set(vault.address, (explained.get(vault.address) ?? 0n) + entry.vaultCashDelta);
        }
        await this.projectSubject(sql, intent, vault, snapshots, tx.slot);
        await enqueueEvent(sql, {
          eventId: `${network}:${tx.signature}:${ix.index}:${ix.innerIndex}`,
          institutionId: vault.institution_id,
          type: EVENT_TYPES[intent.kind],
          payload: {
            network,
            signature: tx.signature,
            slot: tx.slot.toString(),
            blockTime: tx.blockTime?.toString() ?? null,
            vault: vault.address,
            subject: intentSubject(intent),
            businessRef,
            operationId,
            intent,
          },
        });
      }

      // Token movements into or out of a vault that no Forge instruction explains.
      for (const balance of tx.tokenBalances) {
        const vault = byToken.get(balance.account);
        if (!vault) continue;
        touched.add(vault.address);
        const residual = balance.post - balance.pre - (explained.get(vault.address) ?? 0n);
        if (residual === 0n) continue;
        const kind = residual > 0n ? "unexpected_deposit" : "unexplained_outflow";
        const amount = residual > 0n ? residual : -residual;
        const [exception] = await sql`
          INSERT INTO exceptions (network, vault, kind, signature, amount, details)
          VALUES (${network}, ${vault.address}, ${kind}, ${tx.signature}, ${amount.toString()},
            ${{ pre: balance.pre.toString(), post: balance.post.toString(), feePayer: tx.feePayer }})
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!exception) continue;
        if (residual > 0n) {
          await insertPostings(sql, { exceptionId: exception.id, vault: vault.address, signature: tx.signature, slot: tx.slot, businessRef: null }, {
            entry: "unallocated_receipt",
            lines: [
              { account: "vault_cash", debit: amount, credit: 0n },
              { account: "unallocated_receipts", debit: 0n, credit: amount },
            ],
          });
        }
        await enqueueEvent(sql, {
          eventId: `exception:${exception.id}`,
          institutionId: vault.institution_id,
          type: "exception.created",
          payload: { exceptionId: exception.id, kind, vault: vault.address, amount: amount.toString(), signature: tx.signature },
        });
      }

      for (const address of touched) await this.projectVault(sql, address, snapshots, tx.slot);
      return "processed";
    });
  }

  private async matchedOperation(sql: Db, matched: MatchedAttempt, intent: ForgeIntent) {
    const [operation] = await sql`SELECT id, intent FROM operations WHERE id = ${matched.operation_id}`;
    return operation && intentsEqual(operation.intent, intent) ? (operation.id as string) : undefined;
  }

  /** An open operation planned for exactly this intent (e.g. a wallet altered and broadcast it). */
  private async openOperationByIntent(sql: Db, intent: ForgeIntent) {
    const candidates = await sql`
      SELECT id, intent FROM operations
      WHERE vault = ${(intent as { vault: string }).vault} AND kind = ${intent.kind}
        AND subject = ${intentSubject(intent)} AND origin = 'api' AND status IN ${sql(OPEN_STATUSES)}
      ORDER BY created_at`;
    const found = candidates.find((c: { intent: unknown }) => intentsEqual(c.intent, intent));
    return found ? (found.id as string) : undefined;
  }

  /** Records a Forge instruction nobody planned here — a direct program call. */
  private async externalOperation(sql: Db, tx: ChainTransaction, ix: DecodedInstruction, vault: VaultRow) {
    const [operation] = await sql`
      INSERT INTO operations (institution_id, idempotency_key, request_hash, origin, kind, vault,
        subject, intent, required_signers, status, applied_signature, finalized_slot)
      VALUES (${vault.institution_id}, ${`chain:${this.chain.network}:${tx.signature}:${ix.index}:${ix.innerIndex}`},
        'chain', 'chain', ${ix.intent.kind}, ${vault.address}, ${intentSubject(ix.intent)}, ${ix.intent},
        ${requiredSigners(ix.intent)}, 'finalized', ${tx.signature}, ${tx.slot.toString()})
      ON CONFLICT (institution_id, idempotency_key) DO UPDATE SET updated_at = now()
      RETURNING id`;
    return operation.id as string;
  }

  private async businessRef(sql: Db, intent: ForgeIntent, vault: VaultRow): Promise<string | null> {
    if ("loan" in intent) {
      const [row] = await sql`SELECT loan_ref FROM loans WHERE address = ${intent.loan}`;
      return row?.loan_ref ?? null;
    }
    if ("withdrawal" in intent) {
      const [row] = await sql`SELECT withdrawal_ref FROM withdrawals WHERE address = ${intent.withdrawal}`;
      return row?.withdrawal_ref ?? null;
    }
    return vault.vault_ref;
  }

  private async projectSubject(sql: Db, intent: ForgeIntent, vault: VaultRow, snapshots: Snapshots, slot: bigint) {
    if ("loan" in intent) {
      const loan = snapshots.loans.get(intent.loan);
      if (!loan) return;
      await sql`
        INSERT INTO loans (address, vault, loan_ref, loan_id, borrower, destination, principal,
          term_rate_bps, term_seconds, offer_expiry, onchain, fixed_interest, fixed_payoff, approvals,
          state, proposed_at, disbursed_at, repaid_at, synced_slot)
        VALUES (${intent.loan}, ${vault.address}, ${`external:${loan.loanId}`}, ${loan.loanId},
          ${loan.borrower}, ${loan.destination}, ${loan.principal.toString()}, ${loan.termRateBps},
          ${loan.termSeconds.toString()}, ${loan.offerExpiry.toString()}, true,
          ${loan.fixedInterest.toString()}, ${loan.fixedPayoff.toString()}, ${loan.approvals},
          ${loan.state}, ${loan.proposedAt.toString()}, ${loan.disbursedAt.toString()},
          ${loan.repaidAt.toString()}, ${slot.toString()})
        ON CONFLICT (address) DO UPDATE SET onchain = true, fixed_interest = EXCLUDED.fixed_interest,
          fixed_payoff = EXCLUDED.fixed_payoff, approvals = EXCLUDED.approvals, state = EXCLUDED.state,
          proposed_at = EXCLUDED.proposed_at, disbursed_at = EXCLUDED.disbursed_at,
          repaid_at = EXCLUDED.repaid_at, synced_slot = EXCLUDED.synced_slot, updated_at = now()`;
    }
    if ("withdrawal" in intent) {
      const withdrawal = snapshots.withdrawals.get(intent.withdrawal);
      if (!withdrawal) return;
      await sql`
        INSERT INTO withdrawals (address, vault, withdrawal_ref, withdrawal_id, amount, onchain,
          approvals, state, proposed_at, executed_at, synced_slot)
        VALUES (${intent.withdrawal}, ${vault.address}, ${`external:${withdrawal.withdrawalId}`},
          ${withdrawal.withdrawalId}, ${withdrawal.amount.toString()}, true, ${withdrawal.approvals},
          ${withdrawal.state}, ${withdrawal.proposedAt.toString()}, ${withdrawal.executedAt.toString()},
          ${slot.toString()})
        ON CONFLICT (address) DO UPDATE SET onchain = true, approvals = EXCLUDED.approvals,
          state = EXCLUDED.state, proposed_at = EXCLUDED.proposed_at,
          executed_at = EXCLUDED.executed_at, synced_slot = EXCLUDED.synced_slot, updated_at = now()`;
    }
  }

  private async projectVault(sql: Db, address: string, snapshots: Snapshots, slot: bigint) {
    const vault = snapshots.vaults.get(address);
    if (!vault) return;
    const cash = snapshots.tokenAmounts.get(vault.tokenAccount);
    await sql`
      UPDATE vaults SET onchain = true, outstanding_principal = ${vault.outstandingPrincipal.toString()},
        disbursement_paused = ${vault.disbursementPaused}, pause_seq = ${vault.pauseSeq.toString()},
        cash = ${cash === undefined ? null : cash.toString()}, synced_slot = ${slot.toString()},
        updated_at = now()
      WHERE address = ${address}`;
  }
}
