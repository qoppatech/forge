import type { DecodedTransactionError, ForgeIntent } from "@forge/sdk";

import type { Snapshots } from "./ledger";

export interface FailureOutcome {
  status: "already_applied" | "failed" | "needs_review";
  reason: string;
}

type IntentOf<K extends ForgeIntent["kind"]> = Extract<
  ForgeIntent,
  { kind: K }
>;

const applied = (reason: string): FailureOutcome => ({
  reason,
  status: "already_applied",
});
const review = (reason: string): FailureOutcome => ({
  reason,
  status: "needs_review",
});

function classifyCreateVault(
  intent: IntentOf<"create_vault">,
  snapshots: Snapshots
): FailureOutcome {
  const vault = snapshots.vaults.get(intent.vault);
  if (!vault) {
    return review("Vault PDA in use but not decodable as a Forge vault");
  }
  const same =
    vault.treasury === intent.treasury &&
    vault.vaultId === intent.vaultId &&
    vault.mint === intent.mint &&
    vault.treasuryDestination === intent.treasuryDestination &&
    vault.approvers.join(",") === intent.approvers.join(",") &&
    vault.perLoanLimit.toString() === intent.perLoanLimit &&
    vault.outstandingLimit.toString() === intent.outstandingLimit;
  return same
    ? applied("Vault already exists with the requested configuration")
    : review("Vault id already used with a different configuration");
}

function classifyProposeLoan(
  intent: IntentOf<"propose_loan">,
  snapshots: Snapshots
): FailureOutcome {
  const loan = snapshots.loans.get(intent.loan);
  if (!loan) {
    return review("Loan PDA in use but not decodable as a Forge loan");
  }
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

function classifyProposeWithdrawal(
  intent: IntentOf<"propose_withdrawal">,
  snapshots: Snapshots
): FailureOutcome {
  const withdrawal = snapshots.withdrawals.get(intent.withdrawal);
  if (!withdrawal) {
    return review("Withdrawal PDA in use but not decodable");
  }
  return withdrawal.amount.toString() === intent.amount
    ? applied("Withdrawal already proposed with the requested amount")
    : review("Withdrawal id already used with a different amount");
}

function classifyApproveLoan(
  intent: IntentOf<"approve_loan">,
  error: DecodedTransactionError,
  snapshots: Snapshots
): FailureOutcome {
  const loan = snapshots.loans.get(intent.loan);
  const vault = snapshots.vaults.get(intent.vault);
  const index = vault?.approvers.indexOf(intent.approver) ?? -1;
  if (loan && index !== -1 && loan.approvals[index]) {
    return applied("Approval already recorded");
  }
  return {
    reason: `${error.name}: loan is ${loan?.state ?? "unknown"}`,
    status: "failed",
  };
}

function classifyApproveWithdrawal(
  intent: IntentOf<"approve_withdrawal">,
  error: DecodedTransactionError,
  snapshots: Snapshots
): FailureOutcome {
  const withdrawal = snapshots.withdrawals.get(intent.withdrawal);
  const vault = snapshots.vaults.get(intent.vault);
  const index = vault?.approvers.indexOf(intent.approver) ?? -1;
  if (withdrawal && index !== -1 && withdrawal.approvals[index]) {
    return applied("Approval already recorded");
  }
  return {
    reason: `${error.name}: withdrawal is ${withdrawal?.state ?? "unknown"}`,
    status: "failed",
  };
}

function classifyDrawLoan(
  intent: IntentOf<"draw_loan">,
  error: DecodedTransactionError,
  snapshots: Snapshots
): FailureOutcome {
  const loan = snapshots.loans.get(intent.loan);
  return loan && (loan.state === "Active" || loan.state === "Repaid")
    ? applied("Loan already drawn")
    : {
        reason: `${error.name}: loan is ${loan?.state ?? "unknown"}`,
        status: "failed",
      };
}

function classifyRepayLoan(
  intent: IntentOf<"repay_loan">,
  error: DecodedTransactionError,
  snapshots: Snapshots
): FailureOutcome {
  const loan = snapshots.loans.get(intent.loan);
  return loan?.state === "Repaid"
    ? applied("Loan already repaid")
    : {
        reason: `${error.name}: loan is ${loan?.state ?? "unknown"}`,
        status: "failed",
      };
}

/**
 * Decides what a landed failure means for the operation. Forge's natural idempotency shows
 * up as an error on replay, so `replay` errors are resolved against on-chain state instead of
 * being treated as failures: the effect may already be in place.
 */
export function classifyFailure(
  intent: ForgeIntent,
  error: DecodedTransactionError,
  snapshots: Snapshots
): FailureOutcome {
  if (error.category !== "replay") {
    return { reason: `${error.name}: ${error.message}`, status: "failed" };
  }
  switch (intent.kind) {
    case "create_vault": {
      return classifyCreateVault(intent, snapshots);
    }
    case "propose_loan": {
      return classifyProposeLoan(intent, snapshots);
    }
    case "propose_withdrawal": {
      return classifyProposeWithdrawal(intent, snapshots);
    }
    case "approve_loan": {
      return classifyApproveLoan(intent, error, snapshots);
    }
    case "approve_withdrawal": {
      return classifyApproveWithdrawal(intent, error, snapshots);
    }
    case "draw_loan": {
      return classifyDrawLoan(intent, error, snapshots);
    }
    case "repay_loan": {
      return classifyRepayLoan(intent, error, snapshots);
    }
    default: {
      return review(`Unexpected replay error ${error.name} for ${intent.kind}`);
    }
  }
}
