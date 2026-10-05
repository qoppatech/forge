import type { DecodedTransactionError, ForgeIntent } from "@forge/sdk";

import type { Snapshots } from "./ledger";

export interface FailureOutcome {
  status: "already_applied" | "failed" | "needs_review";
  reason: string;
}

/**
 * Decides what a landed failure means for the operation. Forge's natural idempotency shows
 * up as an error on replay, so `replay` errors are resolved against on-chain state instead of
 * being treated as failures: the effect may already be in place.
 */
export function classifyFailure(
  intent: ForgeIntent,
  error: DecodedTransactionError,
  snapshots: Snapshots,
): FailureOutcome {
  if (error.category !== "replay") {
    return { status: "failed", reason: `${error.name}: ${error.message}` };
  }
  const applied = (reason: string): FailureOutcome => ({ status: "already_applied", reason });
  const review = (reason: string): FailureOutcome => ({ status: "needs_review", reason });
  switch (intent.kind) {
    case "create_vault": {
      const vault = snapshots.vaults.get(intent.vault);
      if (!vault) return review("Vault PDA in use but not decodable as a Forge vault");
      const same =
        vault.treasury === intent.treasury &&
        vault.vaultId === intent.vaultId &&
        vault.mint === intent.mint &&
        vault.treasuryDestination === intent.treasuryDestination &&
        vault.approvers.join() === intent.approvers.join() &&
        vault.perLoanLimit.toString() === intent.perLoanLimit &&
        vault.outstandingLimit.toString() === intent.outstandingLimit;
      return same
        ? applied("Vault already exists with the requested configuration")
        : review("Vault id already used with a different configuration");
    }
    case "propose_loan": {
      const loan = snapshots.loans.get(intent.loan);
      if (!loan) return review("Loan PDA in use but not decodable as a Forge loan");
      const same =
        loan.borrower === intent.borrower &&
        loan.destination === intent.destination &&
        loan.principal.toString() === intent.principal &&
        loan.termRateBps === intent.termRateBps &&
        loan.termSeconds.toString() === intent.termSeconds &&
        loan.offerExpiry.toString() === intent.offerExpiry;
      return same
        ? applied("Loan already proposed with the requested terms")
        : review("Loan id already used with different terms");
    }
    case "propose_withdrawal": {
      const withdrawal = snapshots.withdrawals.get(intent.withdrawal);
      if (!withdrawal) return review("Withdrawal PDA in use but not decodable");
      return withdrawal.amount.toString() === intent.amount
        ? applied("Withdrawal already proposed with the requested amount")
        : review("Withdrawal id already used with a different amount");
    }
    case "approve_loan": {
      const loan = snapshots.loans.get(intent.loan);
      const vault = snapshots.vaults.get(intent.vault);
      const index = vault?.approvers.indexOf(intent.approver) ?? -1;
      if (loan && index >= 0 && loan.approvals[index]) return applied("Approval already recorded");
      return { status: "failed", reason: `${error.name}: loan is ${loan?.state ?? "unknown"}` };
    }
    case "approve_withdrawal": {
      const withdrawal = snapshots.withdrawals.get(intent.withdrawal);
      const vault = snapshots.vaults.get(intent.vault);
      const index = vault?.approvers.indexOf(intent.approver) ?? -1;
      if (withdrawal && index >= 0 && withdrawal.approvals[index]) return applied("Approval already recorded");
      return { status: "failed", reason: `${error.name}: withdrawal is ${withdrawal?.state ?? "unknown"}` };
    }
    case "draw_loan": {
      const loan = snapshots.loans.get(intent.loan);
      return loan && (loan.state === "Active" || loan.state === "Repaid")
        ? applied("Loan already drawn")
        : { status: "failed", reason: `${error.name}: loan is ${loan?.state ?? "unknown"}` };
    }
    case "repay_loan": {
      const loan = snapshots.loans.get(intent.loan);
      return loan?.state === "Repaid"
        ? applied("Loan already repaid")
        : { status: "failed", reason: `${error.name}: loan is ${loan?.state ?? "unknown"}` };
    }
    default:
      return review(`Unexpected replay error ${error.name} for ${intent.kind}`);
  }
}
