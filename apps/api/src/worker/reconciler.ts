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
} from "@forge/sdk";
import type { ForgeIntent, IntentKind } from "@forge/sdk";

import { parseTokenAccount } from "../chain";
import type { Chain, ChainTransaction, TokenBalanceChange } from "../chain";
import type { Db } from "../db";
import type { OperationRow } from "../operations";
import { classifyFailure } from "./classify";
import { EVENT_TYPES, enqueueEvent, entryFor, insertPostings } from "./ledger";
import type { Snapshots } from "./ledger";

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
  signature: string | null;
  message_hash: string;
}

/** State shared by the steps that record one successful transaction. */
interface SuccessContext {
  sql: Db;
  tx: ChainTransaction;
  matched: MatchedAttempt | undefined;
  matchedUsed: boolean;
  snapshots: Snapshots;
  /** Vault cash movement explained by Forge instructions, per vault address. */
  explained: Map<string, bigint>;
}

export type ProcessResult =
  | "processed"
  | "duplicate"
  | "not_found"
  | "irrelevant";

const OPEN_STATUSES = ["prepared", "submitted", "confirmed", "expired"];
const NONE = "__none__";

function operationMemo(tx: ChainTransaction) {
  for (const ix of tx.instructions) {
    if (ix.programAddress !== MEMO_PROGRAM_ADDRESS || ix.innerIndex !== -1) {
      continue;
    }
    const parsed = parseOperationMemo(new TextDecoder().decode(ix.data));
    if (parsed) {
      return parsed;
    }
  }
}

function forgeInstructions(tx: ChainTransaction): DecodedInstruction[] {
  const decoded: DecodedInstruction[] = [];
  for (const ix of tx.instructions) {
    if (ix.programAddress !== FORGE_PROGRAM_ADDRESS) {
      continue;
    }
    try {
      // The program ignores bytes after the arguments, so executed data is decoded the same way.
      const intent = decodeForgeInstruction(
        {
          accounts: ix.accounts.map((address) => ({ address })),
          data: ix.data,
          programAddress: ix.programAddress,
        },
        { exact: false }
      );
      if (intent) {
        decoded.push({ index: ix.index, innerIndex: ix.innerIndex, intent });
      }
    } catch {
      // Data the program would reject (unknown discriminator, missing accounts) cannot have
      // executed successfully; failures are still recorded.
    }
  }
  return decoded.toSorted(
    (a, b) => a.index - b.index || a.innerIndex - b.innerIndex
  );
}

async function matchedOperation(
  sql: Db,
  matched: MatchedAttempt,
  intent: ForgeIntent
) {
  const [operation] =
    await sql`SELECT id, intent FROM operations WHERE id = ${matched.operation_id}`;
  return operation && intentsEqual(operation.intent, intent)
    ? (operation.id as string)
    : undefined;
}

/** An open operation planned for exactly this intent (e.g. a wallet altered and broadcast it). */
async function openOperationByIntent(sql: Db, intent: ForgeIntent) {
  const candidates = await sql`
      SELECT id, intent FROM operations
      WHERE vault = ${(intent as { vault: string }).vault} AND kind = ${intent.kind}
        AND subject = ${intentSubject(intent)} AND origin = 'api' AND status IN ${sql(OPEN_STATUSES)}
      ORDER BY created_at`;
  const found = candidates.find((c: { intent: unknown }) =>
    intentsEqual(c.intent, intent)
  );
  return found ? (found.id as string) : undefined;
}

async function businessRefFor(
  sql: Db,
  intent: ForgeIntent,
  vault: VaultRow
): Promise<string | null> {
  if ("loan" in intent) {
    const [row] =
      await sql`SELECT loan_ref FROM loans WHERE address = ${intent.loan}`;
    return row?.loan_ref ?? null;
  }
  if ("withdrawal" in intent) {
    const [row] =
      await sql`SELECT withdrawal_ref FROM withdrawals WHERE address = ${intent.withdrawal}`;
    return row?.withdrawal_ref ?? null;
  }
  return vault.vault_ref;
}

async function projectSubject(
  sql: Db,
  intent: ForgeIntent,
  vault: VaultRow,
  snapshots: Snapshots,
  slot: bigint
) {
  if ("loan" in intent) {
    const loan = snapshots.loans.get(intent.loan);
    if (!loan) {
      return;
    }
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
        ON CONFLICT (address) DO UPDATE SET onchain = true, borrower = EXCLUDED.borrower,
          destination = EXCLUDED.destination, principal = EXCLUDED.principal,
          term_rate_bps = EXCLUDED.term_rate_bps, term_seconds = EXCLUDED.term_seconds,
          offer_expiry = EXCLUDED.offer_expiry, fixed_interest = EXCLUDED.fixed_interest,
          fixed_payoff = EXCLUDED.fixed_payoff, approvals = EXCLUDED.approvals, state = EXCLUDED.state,
          proposed_at = EXCLUDED.proposed_at, disbursed_at = EXCLUDED.disbursed_at,
          repaid_at = EXCLUDED.repaid_at, synced_slot = EXCLUDED.synced_slot, updated_at = now()`;
  }
  if ("withdrawal" in intent) {
    const withdrawal = snapshots.withdrawals.get(intent.withdrawal);
    if (!withdrawal) {
      return;
    }
    await sql`
        INSERT INTO withdrawals (address, vault, withdrawal_ref, withdrawal_id, amount, onchain,
          approvals, state, proposed_at, executed_at, synced_slot)
        VALUES (${intent.withdrawal}, ${vault.address}, ${`external:${withdrawal.withdrawalId}`},
          ${withdrawal.withdrawalId}, ${withdrawal.amount.toString()}, true, ${withdrawal.approvals},
          ${withdrawal.state}, ${withdrawal.proposedAt.toString()}, ${withdrawal.executedAt.toString()},
          ${slot.toString()})
        ON CONFLICT (address) DO UPDATE SET onchain = true, amount = EXCLUDED.amount,
          approvals = EXCLUDED.approvals,
          state = EXCLUDED.state, proposed_at = EXCLUDED.proposed_at,
          executed_at = EXCLUDED.executed_at, synced_slot = EXCLUDED.synced_slot, updated_at = now()`;
  }
}

async function projectVault(
  sql: Db,
  address: string,
  snapshots: Snapshots,
  slot: bigint
) {
  const vault = snapshots.vaults.get(address);
  if (!vault) {
    return;
  }
  const cash = snapshots.tokenAmounts.get(vault.tokenAccount);
  await sql`
      UPDATE vaults SET onchain = true, mint = ${vault.mint}, approvers = ${vault.approvers},
        treasury_destination = ${vault.treasuryDestination}, per_loan_limit = ${vault.perLoanLimit.toString()},
        outstanding_limit = ${vault.outstandingLimit.toString()},
        outstanding_principal = ${vault.outstandingPrincipal.toString()},
        disbursement_paused = ${vault.disbursementPaused}, pause_seq = ${vault.pauseSeq.toString()},
        cash = ${cash === undefined ? null : cash.toString()}, synced_slot = ${slot.toString()},
        updated_at = now()
      WHERE address = ${address}`;
}

/**
 * Turns one finalized transaction into durable facts, exactly once per (network, signature):
 * chain events, balanced postings, exceptions, projections, operation transitions and webhook
 * outbox rows are written in a single database transaction. Both the tracker (own
 * submissions) and the indexer (anything touching a watched vault) go through here.
 */
export class Reconciler {
  private readonly db: Db;
  private readonly chain: Chain;

  constructor(db: Db, chain: Chain) {
    this.db = db;
    this.chain = chain;
  }

  async processSignature(signature: string): Promise<ProcessResult> {
    const { network } = this.chain;
    const [seen] = await this.db`
      SELECT 1 FROM chain_transactions WHERE network = ${network} AND signature = ${signature}`;
    if (seen) {
      return "duplicate";
    }
    const tx = await this.chain.getTransaction(signature);
    if (!tx) {
      return "not_found";
    }

    const instructions = forgeInstructions(tx);
    const vaultAddresses = instructions.map(
      (i) => (i.intent as { vault: string }).vault
    );
    const tokenAccounts = tx.tokenBalances.map((b) => b.account);
    const vaults = (await this.db`
      SELECT address, institution_id, token_account, vault_ref FROM vaults
      WHERE address IN ${this.db([...vaultAddresses, NONE])}
         OR token_account IN ${this.db([...tokenAccounts, NONE])}`) as VaultRow[];

    // Our attempt, by transaction id, exact message, or the operation memo (which survives a
    // wallet adding instructions before broadcasting).
    const memo = operationMemo(tx);
    const [matched] = (await this.db`
      SELECT id, operation_id, signature, message_hash FROM tx_attempts
      WHERE signature = ${signature} OR message_hash = ${tx.messageHash}
         OR (operation_id = ${memo?.operationId ?? null}::uuid AND attempt_no = ${memo?.attemptNo ?? -1})
      ORDER BY (signature IS NOT DISTINCT FROM ${signature}) DESC LIMIT 1`) as MatchedAttempt[];

    if (vaults.length === 0 && !matched) {
      await this.recordTransaction(this.db, tx);
      return "irrelevant";
    }
    const snapshots = await this.snapshots(
      instructions.map((i) => i.intent),
      vaults
    );
    return tx.err === null
      ? this.recordSuccess(tx, instructions, vaults, matched, snapshots)
      : this.recordFailure(tx, instructions, matched, snapshots);
  }

  /** Finalized account state for everything the transaction touched. */
  private async snapshots(
    intents: ForgeIntent[],
    vaults: VaultRow[]
  ): Promise<Snapshots> {
    const vaultSet = new Set([
      ...vaults.map((v) => v.address),
      ...intents.map((i) => (i as { vault: string }).vault),
    ]);
    const tokenSet = new Set(vaults.map((v) => v.token_account));
    const loanSet = new Set(
      intents.flatMap((i) => ("loan" in i ? [i.loan] : []))
    );
    const withdrawalSet = new Set(
      intents.flatMap((i) => ("withdrawal" in i ? [i.withdrawal] : []))
    );
    const addresses = [...vaultSet, ...tokenSet, ...loanSet, ...withdrawalSet];
    const accounts = await this.chain.getAccounts(addresses, "finalized");
    const snapshots: Snapshots = {
      loans: new Map(),
      tokenAmounts: new Map(),
      vaults: new Map(),
      withdrawals: new Map(),
    };
    for (const [i, address] of addresses.entries()) {
      const data = accounts[i]?.data;
      if (!data) {
        continue;
      }
      try {
        if (vaultSet.has(address)) {
          snapshots.vaults.set(address, decodeVaultAccount(data));
        } else if (loanSet.has(address)) {
          snapshots.loans.set(address, decodeLoanAccount(data));
        } else if (withdrawalSet.has(address)) {
          snapshots.withdrawals.set(address, decodeWithdrawalAccount(data));
        } else {
          const token = parseTokenAccount(data);
          if (token) {
            snapshots.tokenAmounts.set(address, token.amount);
          }
        }
      } catch {
        // Not a Forge account of the expected type (e.g. a squatted PDA); classification handles it.
      }
    }
    return snapshots;
  }

  private async recordTransaction(
    sql: Db,
    tx: ChainTransaction
  ): Promise<boolean> {
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
    snapshots: Snapshots
  ): Promise<ProcessResult> {
    const kinds: (IntentKind | undefined)[] = [];
    for (const i of instructions) {
      if (i.innerIndex === -1) {
        kinds[i.index] = i.intent.kind;
      }
    }
    const error = decodeTransactionError(tx.err, kinds);
    return await this.db.begin(async (sql) => {
      if (!(await this.recordTransaction(sql as Db, tx))) {
        return "duplicate";
      }
      if (!matched) {
        return "processed";
      }
      const [operation] = (await sql`
        SELECT * FROM operations WHERE id = ${matched.operation_id}`) as OperationRow[];
      if (!operation) {
        return "processed";
      }
      // The memo is public, copyable text: a memo-only match must also be paid by the operation's
      // fee payer and carry its exact intent before it may fail the operation.
      const exact =
        matched.signature === tx.signature ||
        matched.message_hash === tx.messageHash;
      const bound =
        exact ||
        (tx.feePayer === operation.required_signers[0] &&
          instructions.some(
            (i) =>
              i.innerIndex === -1 && intentsEqual(operation.intent, i.intent)
          ));
      if (!bound) {
        return "processed";
      }
      const outcome = classifyFailure(operation.intent, error, snapshots);
      await sql`
        UPDATE tx_attempts SET status = 'landed_err', confirmation = 'finalized',
          err = ${toJsonSafe(tx.err)}, slot = ${tx.slot.toString()},
          signature = coalesce(signature, ${tx.signature}), updated_at = now()
        WHERE id = ${matched.id} AND confirmation IS DISTINCT FROM 'finalized'`;
      const updated = await sql`
        UPDATE operations SET status = ${outcome.status}, status_reason = ${outcome.reason},
          error = ${toJsonSafe(error)}, finalized_slot = ${tx.slot.toString()}, updated_at = now()
        WHERE id = ${operation.id} AND status IN ${sql(OPEN_STATUSES)}
        RETURNING id`;
      if (updated.length > 0) {
        await enqueueEvent(sql as Db, {
          eventId: `operation:${operation.id}:${outcome.status}`,
          institutionId: operation.institution_id,
          payload: {
            error: toJsonSafe(error),
            kind: operation.kind,
            operationId: operation.id,
            reason: outcome.reason,
            signature: tx.signature,
            slot: tx.slot.toString(),
            subject: operation.subject,
            vault: operation.vault,
          },
          type: `operation.${outcome.status}`,
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
    snapshots: Snapshots
  ): Promise<ProcessResult> {
    const byAddress = new Map(vaults.map((v) => [v.address, v]));
    const byToken = new Map(vaults.map((v) => [v.token_account, v]));
    return await this.db.begin(async (raw) => {
      const sql = raw as Db;
      if (!(await this.recordTransaction(sql, tx))) {
        return "duplicate";
      }
      const context: SuccessContext = {
        explained: new Map<string, bigint>(),
        matched,
        matchedUsed: false,
        snapshots,
        sql,
        tx,
      };
      const touched = new Set<string>();

      for (const ix of instructions) {
        const vault = byAddress.get((ix.intent as { vault: string }).vault);
        if (!vault) {
          continue;
        }
        touched.add(vault.address);
        // oxlint-disable-next-line no-await-in-loop -- instructions are applied in transaction order within one DB transaction
        await this.recordInstruction(context, ix, vault);
      }

      // Token movements into or out of a vault that no Forge instruction explains.
      for (const balance of tx.tokenBalances) {
        const vault = byToken.get(balance.account);
        if (!vault) {
          continue;
        }
        touched.add(vault.address);
        // oxlint-disable-next-line no-await-in-loop -- residuals depend on every instruction above and share one DB transaction
        await this.recordResidual(context, balance, vault);
      }

      for (const address of touched) {
        // oxlint-disable-next-line no-await-in-loop -- projections run sequentially on the transaction's single connection
        await projectVault(sql, address, snapshots, tx.slot);
      }
      return "processed";
    });
  }

  /** Finalizes (or records) the operation behind one Forge instruction and posts its effects. */
  private async recordInstruction(
    context: SuccessContext,
    ix: DecodedInstruction,
    vault: VaultRow
  ): Promise<void> {
    const { network } = this.chain;
    const { sql, tx, matched, snapshots, explained } = context;
    const { intent } = ix;

    let operationId =
      matched && !context.matchedUsed
        ? await matchedOperation(sql, matched, intent)
        : undefined;
    if (operationId) {
      context.matchedUsed = true;
    }
    operationId ??= await openOperationByIntent(sql, intent);
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
      // Applied by another transaction (e.g. a wallet rebuild): the plan still awaiting signatures
      // must not be signable any more, or the operation could land twice.
      await sql`
            UPDATE tx_attempts SET status = 'expired', updated_at = now()
            WHERE operation_id = ${operationId} AND status = 'awaiting_signatures'`;
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
    if (!event) {
      return;
    }

    const businessRef = await businessRefFor(sql, intent, vault);
    const entry = entryFor(intent, snapshots);
    if (entry) {
      await insertPostings(
        sql,
        {
          businessRef,
          eventId: event.id,
          signature: tx.signature,
          slot: tx.slot,
          vault: vault.address,
        },
        entry
      );
      explained.set(
        vault.address,
        (explained.get(vault.address) ?? 0n) + entry.vaultCashDelta
      );
    }
    await projectSubject(sql, intent, vault, snapshots, tx.slot);
    await enqueueEvent(sql, {
      eventId: `${network}:${tx.signature}:${ix.index}:${ix.innerIndex}`,
      institutionId: vault.institution_id,
      payload: {
        blockTime: tx.blockTime?.toString() ?? null,
        businessRef,
        intent,
        network,
        operationId,
        signature: tx.signature,
        slot: tx.slot.toString(),
        subject: intentSubject(intent),
        vault: vault.address,
      },
      type: EVENT_TYPES[intent.kind],
    });
  }

  /** Records a vault token movement that the Forge instructions do not explain. */
  private async recordResidual(
    context: SuccessContext,
    balance: TokenBalanceChange,
    vault: VaultRow
  ): Promise<void> {
    const { network } = this.chain;
    const { sql, tx, explained } = context;
    const residual =
      balance.post - balance.pre - (explained.get(vault.address) ?? 0n);
    if (residual === 0n) {
      return;
    }
    const kind = residual > 0n ? "unexpected_deposit" : "unexplained_outflow";
    const amount = residual > 0n ? residual : -residual;
    const [exception] = await sql`
          INSERT INTO exceptions (network, vault, kind, signature, amount, details)
          VALUES (${network}, ${vault.address}, ${kind}, ${tx.signature}, ${amount.toString()},
            ${{ feePayer: tx.feePayer, post: balance.post.toString(), pre: balance.pre.toString() }})
          ON CONFLICT (network, vault, kind, signature) DO NOTHING RETURNING id`;
    if (!exception) {
      return;
    }
    if (residual > 0n) {
      await insertPostings(
        sql,
        {
          businessRef: null,
          exceptionId: exception.id,
          signature: tx.signature,
          slot: tx.slot,
          vault: vault.address,
        },
        {
          entry: "unallocated_receipt",
          lines: [
            { account: "vault_cash", credit: 0n, debit: amount },
            { account: "unallocated_receipts", credit: amount, debit: 0n },
          ],
        }
      );
    }
    await enqueueEvent(sql, {
      eventId: `exception:${exception.id}`,
      institutionId: vault.institution_id,
      payload: {
        amount: amount.toString(),
        exceptionId: exception.id,
        kind,
        signature: tx.signature,
        vault: vault.address,
      },
      type: "exception.created",
    });
  }

  /** Records a Forge instruction nobody planned here — a direct program call. */
  private async externalOperation(
    sql: Db,
    tx: ChainTransaction,
    ix: DecodedInstruction,
    vault: VaultRow
  ) {
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
}
