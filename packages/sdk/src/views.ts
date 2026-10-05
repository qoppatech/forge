import type { LoanAccount } from "./accounts.js";

export type LoanStatusView =
  | "proposed"
  | "approved"
  | "offer_expired"
  | "active"
  | "overdue"
  | "repaid";

export interface LoanView {
  status: LoanStatusView;
  /** `disbursed_at + term_seconds` once drawn. */
  dueAt?: bigint;
}

/**
 * Computed loan status. Expiry and overdue are views, not stored states: time passing never
 * executes an instruction (`docs/FORGE-MVP-v0.1.md` §4). `now` is a Unix timestamp in seconds.
 */
export function loanView(
  loan: Pick<LoanAccount, "state" | "offerExpiry" | "disbursedAt" | "termSeconds">,
  now: bigint,
): LoanView {
  switch (loan.state) {
    case "Proposed":
    case "Approved":
      if (now > loan.offerExpiry) return { status: "offer_expired" };
      return { status: loan.state === "Proposed" ? "proposed" : "approved" };
    case "Active": {
      const dueAt = loan.disbursedAt + loan.termSeconds;
      return { status: now > dueAt ? "overdue" : "active", dueAt };
    }
    case "Repaid":
      return { status: "repaid", dueAt: loan.disbursedAt + loan.termSeconds };
  }
}

const UNIT_DECIMALS = 6;

/** Parses a decimal token amount ("5000.5") into base units, rejecting excess precision. */
export function parseTokenAmount(value: string, decimals = UNIT_DECIMALS): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new TypeError(`Invalid token amount: ${value}`);
  const [, whole = "0", fraction = ""] = match;
  if (fraction.length > decimals) throw new RangeError(`More than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Formats base units as a decimal token amount with grouping ("10,100.000000"). */
export function formatTokenAmount(baseUnits: bigint | string, decimals = UNIT_DECIMALS): string {
  const value = BigInt(baseUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
