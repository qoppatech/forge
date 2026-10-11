import { formatTokenAmount, parseTokenAmount } from "@forge/sdk";

export const ASSET = "FORGE_TEST_USD";

export function tokens(base: string | bigint | null | undefined): string {
  if (base === null || base === undefined || base === "") {
    return "—";
  }
  return (
    formatTokenAmount(BigInt(base))
      .replace(/\.?0+$/u, "")
      .replace(/\.$/u, "") || "0"
  );
}

export function baseUnits(value: string): string {
  return parseTokenAmount(value).toString();
}

export function short(value: string | null | undefined, size = 4): string {
  if (!value) {
    return "—";
  }
  return value.length <= size * 2 + 1
    ? value
    : `${value.slice(0, size)}…${value.slice(-size)}`;
}

export function when(value: string | Date | null | undefined): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function unixDate(seconds: string | bigint | null | undefined): string {
  if (!seconds || BigInt(seconds) === 0n) {
    return "—";
  }
  return new Date(Number(seconds) * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export const KIND_LABELS: Record<string, string> = {
  approve_loan: "Approve loan",
  approve_withdrawal: "Approve withdrawal",
  create_vault: "Create vault",
  draw_loan: "Draw loan",
  fund_vault: "Fund vault",
  propose_loan: "Propose loan",
  propose_withdrawal: "Propose withdrawal",
  repay_loan: "Repay loan",
  set_disbursement_paused: "Pause or resume draws",
};

/** Settlement language from DESIGN.md: a signing event is never shown as settlement. */
export const STATUS: Record<
  string,
  { label: string; tone: "success" | "warning" | "error" | "info" | "neutral" }
> = {
  already_applied: { label: "Already applied", tone: "neutral" },
  confirmed: { label: "Confirmed", tone: "info" },
  expired: { label: "Expired — prepare again", tone: "warning" },
  failed: { label: "Failed", tone: "error" },
  finalized: { label: "Finalized", tone: "success" },
  needs_review: { label: "Needs review", tone: "error" },
  prepared: { label: "Awaiting signatures", tone: "warning" },
  submitted: { label: "Transaction submitted", tone: "info" },
};

/** Loans the indexer has not seen on chain yet; also the fallback for unknown statuses. */
export const LOAN_PENDING: {
  label: string;
  tone: "success" | "warning" | "error" | "info" | "neutral";
} = { label: "Not on chain yet", tone: "neutral" };

export const LOAN_VIEW: Record<
  string,
  { label: string; tone: "success" | "warning" | "error" | "info" | "neutral" }
> = {
  active: { label: "Drawn · active", tone: "info" },
  approved: { label: "Ready to draw", tone: "info" },
  offer_expired: { label: "Offer expired", tone: "error" },
  overdue: { label: "Overdue", tone: "error" },
  pending: LOAN_PENDING,
  proposed: { label: "Proposed", tone: "neutral" },
  repaid: { label: "Repaid", tone: "success" },
};
