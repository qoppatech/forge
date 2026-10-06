import type {
  ForgeIntent,
  LoanAccount,
  VaultAccount,
  WithdrawalAccount,
} from "@forge/sdk";

import type { Db } from "../db";

export interface Snapshots {
  vaults: Map<string, VaultAccount>;
  loans: Map<string, LoanAccount>;
  withdrawals: Map<string, WithdrawalAccount>;
  tokenAmounts: Map<string, bigint>;
}

export interface PostingLine {
  account:
    | "vault_cash"
    | "treasury_cash"
    | "principal_receivable"
    | "interest_income"
    | "unallocated_receipts";
  debit: bigint;
  credit: bigint;
}

export interface Entry {
  entry: string;
  lines: PostingLine[];
  /** Effect on the vault token account, used to detect unexplained movements. */
  vaultCashDelta: bigint;
}

const debit = (
  account: PostingLine["account"],
  amount: bigint
): PostingLine => ({ account, credit: 0n, debit: amount });
const credit = (
  account: PostingLine["account"],
  amount: bigint
): PostingLine => ({ account, credit: amount, debit: 0n });

/**
 * Balanced postings for a successful Forge instruction. Amounts come from the intent or from
 * immutable account fields (principal, payoff, withdrawal amount), so they do not depend on
 * when the projection snapshot was read. Cash-basis demo treatment, not a regulatory policy.
 */
export function entryFor(
  intent: ForgeIntent,
  snapshots: Snapshots
): Entry | undefined {
  switch (intent.kind) {
    case "fund_vault": {
      const amount = BigInt(intent.amount);
      return {
        entry: "fund",
        lines: [debit("vault_cash", amount), credit("treasury_cash", amount)],
        vaultCashDelta: amount,
      };
    }
    case "draw_loan": {
      const loan = snapshots.loans.get(intent.loan);
      if (!loan) {
        throw new Error(`Missing loan snapshot ${intent.loan}`);
      }
      return {
        entry: "disburse",
        lines: [
          debit("principal_receivable", loan.principal),
          credit("vault_cash", loan.principal),
        ],
        vaultCashDelta: -loan.principal,
      };
    }
    case "repay_loan": {
      const loan = snapshots.loans.get(intent.loan);
      if (!loan) {
        throw new Error(`Missing loan snapshot ${intent.loan}`);
      }
      const lines = [
        debit("vault_cash", loan.fixedPayoff),
        credit("principal_receivable", loan.principal),
      ];
      if (loan.fixedInterest > 0n) {
        lines.push(credit("interest_income", loan.fixedInterest));
      }
      return { entry: "repay", lines, vaultCashDelta: loan.fixedPayoff };
    }
    case "approve_withdrawal": {
      // With two approvers, a successful approval is always the executing one.
      const withdrawal = snapshots.withdrawals.get(intent.withdrawal);
      if (!withdrawal) {
        throw new Error(`Missing withdrawal snapshot ${intent.withdrawal}`);
      }
      return {
        entry: "withdraw",
        lines: [
          debit("treasury_cash", withdrawal.amount),
          credit("vault_cash", withdrawal.amount),
        ],
        vaultCashDelta: -withdrawal.amount,
      };
    }
    default: {
      return undefined;
    }
  }
}

export async function insertPostings(
  tx: Db,
  ref: {
    eventId?: string;
    exceptionId?: string;
    vault: string;
    signature: string;
    slot: bigint;
    businessRef: string | null;
  },
  entry: Pick<Entry, "entry" | "lines">
) {
  for (const line of entry.lines) {
    if (line.debit === 0n && line.credit === 0n) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- lines insert in entry order on the caller's transaction; posting ids order the statement
    await tx`
      INSERT INTO postings (event_id, exception_id, vault, entry, account, debit, credit, signature, slot, business_ref)
      VALUES (${ref.eventId ?? null}, ${ref.exceptionId ?? null}, ${ref.vault}, ${entry.entry}, ${line.account},
        ${line.debit.toString()}, ${line.credit.toString()}, ${ref.signature}, ${ref.slot.toString()}, ${ref.businessRef})`;
  }
}

export async function enqueueEvent(
  tx: Db,
  event: {
    eventId: string;
    institutionId: string;
    type: string;
    payload: Record<string, unknown>;
  }
) {
  await tx`
    INSERT INTO webhook_outbox (event_id, institution_id, type, payload)
    VALUES (${event.eventId}, ${event.institutionId}, ${event.type}, ${event.payload})
    ON CONFLICT (event_id) DO NOTHING`;
}

export const EVENT_TYPES: Record<ForgeIntent["kind"], string> = {
  approve_loan: "loan.approved",
  approve_withdrawal: "withdrawal.executed",
  create_vault: "vault.created",
  draw_loan: "loan.drawn",
  fund_vault: "vault.funded",
  propose_loan: "loan.proposed",
  propose_withdrawal: "withdrawal.proposed",
  repay_loan: "loan.repaid",
  set_disbursement_paused: "vault.pause_set",
};
